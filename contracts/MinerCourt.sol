// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
pragma solidity ^0.8.20;

/// @title MinerCourt
/// @notice The on-chain half of Empanel. It is two things at once: the register
///         where a jury of Telegraph miners has its verdict written down, and the
///         ERC-8183 callback that receives an appeal answered by a miner through
///         the on-chain rail.
/// @dev Reads are shaped like a price feed on purpose. An integrator who has ever
///      read a Chainlink aggregator can consume `latestAnswer` without learning
///      anything new about Empanel.
contract MinerCourt {
    /// Telegraph carries job parameters and job results in these four arrays.
    /// The layout is a protocol fact, so declaring it here gives `subnetMessage`
    /// the same selector the Diamond calls.
    struct OnChainData {
        address[] addresses;
        uint256[] integers;
        string[] strings;
        bool[] bools;
    }

    /// A panel outcome. 0 is the absence of a record, not a neutral vote.
    uint8 public constant VERDICT_UNKNOWN = 0;
    uint8 public constant VERDICT_SUPPORTED = 1;
    uint8 public constant VERDICT_REFUTED = 2;
    uint8 public constant VERDICT_HUNG = 3;

    /// One case, three storage slots. `panelRoot` commits to every juror that
    /// voted, so the panel is provable later without keeping it on chain.
    struct Case {
        bytes32 caseId;
        bytes32 panelRoot;
        uint8 verdict;
        uint16 confidenceBp;
        uint16 panelSize;
        uint40 updatedAt;
    }

    /// The Telegraph Diamond. Only it may deliver an appeal answer.
    address public immutable diamond;

    /// The key that publishes case pages. It is the only writer of verdicts.
    address public recorder;

    mapping(bytes32 => Case) private _cases; // claimHash => record
    bytes32[] private _claimHashes;

    mapping(uint256 => bytes32) public appealCase; // ERC-8183 jobId => caseId
    mapping(uint256 => bytes32) public appealAnswerHash; // jobId => hash of the delivered result
    uint256[] private _appealJobs;

    event VerdictEntered(
        bytes32 indexed caseId,
        bytes32 indexed claimHash,
        uint8 verdict,
        uint16 confidenceBp,
        uint16 panelSize,
        bytes32 panelRoot
    );
    event AppealRegistered(bytes32 indexed caseId, uint256 indexed jobId);
    event AppealAnswered(
        bytes32 indexed caseId,
        uint256 indexed jobId,
        bool success,
        OnChainData response,
        string errorMessage
    );
    event RecorderChanged(address indexed previous, address indexed next);

    error NotRecorder();
    error NotDiamond();
    error BadVerdict(uint8 verdict);
    error BadConfidence(uint16 confidenceBp);
    error EmptyPanel();
    error BadCaseId();
    error AppealAlreadyRegistered(uint256 jobId);
    error ZeroRecorder();

    constructor(address diamond_, address recorder_) {
        if (diamond_ == address(0)) revert NotDiamond();
        if (recorder_ == address(0)) revert ZeroRecorder();
        diamond = diamond_;
        recorder = recorder_;
        emit RecorderChanged(address(0), recorder_);
    }

    modifier onlyRecorder() {
        if (msg.sender != recorder) revert NotRecorder();
        _;
    }

    // --- writes ---------------------------------------------------------------

    /// Publish what the panel decided. Re-entering a claim overwrites it and
    /// refreshes `updatedAt`, which is how a case gets re-tried on new evidence.
    /// @param caseId      identifier of the published case page
    /// @param claimHash   keccak256 of the normalised claim text, the read key
    /// @param verdict     one of the VERDICT_ constants
    /// @param confidenceBp panel confidence in basis points, 0 to 10000
    /// @param panelSize   how many jurors voted
    /// @param panelRoot   Merkle root over the sorted juror signal hashes
    function enterVerdict(
        bytes32 caseId,
        bytes32 claimHash,
        uint8 verdict,
        uint16 confidenceBp,
        uint16 panelSize,
        bytes32 panelRoot
    ) external onlyRecorder {
        if (caseId == bytes32(0)) revert BadCaseId();
        if (verdict > VERDICT_HUNG) revert BadVerdict(verdict);
        if (confidenceBp > 10000) revert BadConfidence(confidenceBp);
        if (panelSize == 0) revert EmptyPanel();

        Case storage c = _cases[claimHash];
        if (c.updatedAt == 0) _claimHashes.push(claimHash);
        c.caseId = caseId;
        c.panelRoot = panelRoot;
        c.verdict = verdict;
        c.confidenceBp = confidenceBp;
        c.panelSize = panelSize;
        c.updatedAt = uint40(block.timestamp);

        emit VerdictEntered(caseId, claimHash, verdict, confidenceBp, panelSize, panelRoot);
    }

    /// Bind an ERC-8183 job to the case that appealed. Called right after
    /// createJob, so the callback knows which case the answer belongs to.
    function registerAppeal(bytes32 caseId, uint256 jobId) external onlyRecorder {
        if (caseId == bytes32(0)) revert BadCaseId();
        if (appealCase[jobId] != bytes32(0)) revert AppealAlreadyRegistered(jobId);
        appealCase[jobId] = caseId;
        _appealJobs.push(jobId);
        emit AppealRegistered(caseId, jobId);
    }

    function setRecorder(address next) external onlyRecorder {
        if (next == address(0)) revert ZeroRecorder();
        emit RecorderChanged(recorder, next);
        recorder = next;
    }

    // --- ERC-8183 receiver ----------------------------------------------------

    /// Telegraph delivers a resolved job here. The protocol calls this inside a
    /// try/catch and hands over only the gas left in the settling transaction, so
    /// this body is one storage write and one event and nothing else. The result
    /// text goes out in the event rather than into storage: copying the arrays in
    /// would be the one thing that can exhaust the callback and lose the record.
    function subnetMessage(
        uint256 jobId,
        bool success,
        OnChainData memory response,
        string memory errorMessage
    ) external {
        if (msg.sender != diamond) revert NotDiamond();
        appealAnswerHash[jobId] = keccak256(abi.encode(jobId, success, response, errorMessage));
        emit AppealAnswered(appealCase[jobId], jobId, success, response, errorMessage);
    }

    // --- reads ----------------------------------------------------------------

    /// The feed-shaped read. `updatedAt` is 0 when no panel has ruled.
    function latestAnswer(bytes32 claimHash)
        external
        view
        returns (uint8 verdict, uint16 confidenceBp, uint16 panelSize, uint256 updatedAt)
    {
        Case storage c = _cases[claimHash];
        return (c.verdict, c.confidenceBp, c.panelSize, c.updatedAt);
    }

    /// True when a verdict exists and is younger than `maxAge` seconds.
    function isFresh(bytes32 claimHash, uint256 maxAge) external view returns (bool) {
        uint256 updatedAt = _cases[claimHash].updatedAt;
        if (updatedAt == 0) return false;
        return block.timestamp - updatedAt <= maxAge;
    }

    /// Prove a juror was on the panel that produced this verdict. Leaves are the
    /// juror signal hashes themselves, sorted ascending, and each level hashes
    /// the pair in ascending order so a proof carries no index bits.
    function verifyJuror(bytes32 claimHash, bytes32 signalHash, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        bytes32 root = _cases[claimHash].panelRoot;
        if (root == bytes32(0)) return false;
        bytes32 node = signalHash;
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            node = node < sibling
                ? keccak256(abi.encodePacked(node, sibling))
                : keccak256(abi.encodePacked(sibling, node));
        }
        return node == root;
    }

    function getCase(bytes32 claimHash) external view returns (Case memory) {
        return _cases[claimHash];
    }

    function caseCount() external view returns (uint256) {
        return _claimHashes.length;
    }

    function claimHashAt(uint256 index) external view returns (bytes32) {
        return _claimHashes[index];
    }

    /// Every claim the register holds, for a page that lists the docket.
    function claimHashes() external view returns (bytes32[] memory) {
        return _claimHashes;
    }

    function appealCount() external view returns (uint256) {
        return _appealJobs.length;
    }

    function appealJobs() external view returns (uint256[] memory) {
        return _appealJobs;
    }
}
