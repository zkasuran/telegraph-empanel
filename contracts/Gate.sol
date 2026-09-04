// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
pragma solidity ^0.8.20;

interface IMinerCourt {
    function latestAnswer(bytes32 claimHash)
        external
        view
        returns (uint8 verdict, uint16 confidenceBp, uint16 panelSize, uint256 updatedAt);
    function isFresh(bytes32 claimHash, uint256 maxAge) external view returns (bool);
}

/// @title Gate
/// @notice The smallest contract that shows why the register is worth anything.
///         It takes an action only while a panel of Telegraph miners still says
///         the claim holds, and it refuses out loud otherwise. Anything gated on
///         a fact (a payout, a listing, an insurance trigger) is this shape.
contract Gate {
    /// Mirrors MinerCourt.VERDICT_SUPPORTED.
    uint8 private constant SUPPORTED = 1;

    IMinerCourt public immutable court;
    uint16 public immutable minConfidenceBp;
    uint256 public actions;

    event Acted(bytes32 indexed claimHash, uint16 confidenceBp, uint16 panelSize, uint256 count);

    error NotSupported(uint8 verdict);
    error ConfidenceTooLow(uint16 confidenceBp, uint16 required);
    error VerdictStale(bytes32 claimHash, uint256 maxAge);

    constructor(address court_, uint16 minConfidenceBp_) {
        court = IMinerCourt(court_);
        minConfidenceBp = minConfidenceBp_;
    }

    function actIfSupported(bytes32 claimHash, uint256 maxAge) external {
        (uint8 verdict, uint16 confidenceBp, uint16 panelSize,) = court.latestAnswer(claimHash);
        if (verdict != SUPPORTED) revert NotSupported(verdict);
        if (confidenceBp < minConfidenceBp) revert ConfidenceTooLow(confidenceBp, minConfidenceBp);
        if (!court.isFresh(claimHash, maxAge)) revert VerdictStale(claimHash, maxAge);
        emit Acted(claimHash, confidenceBp, panelSize, ++actions);
    }
}
