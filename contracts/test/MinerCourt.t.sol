// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
pragma solidity ^0.8.20;

import {MinerCourt} from "../MinerCourt.sol";
import {Gate} from "../Gate.sol";

/// The cheatcode surface this suite uses. Declared here so the project needs no
/// external dependency: forge-std is not vendored and no remapping is wanted.
interface Vm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 selector) external;
}

contract MinerCourtTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    address constant DIAMOND = 0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8;
    address constant RECORDER = 0x8b224783FE5b3c52B7DB0cb9B1754f8812b75287;
    address constant STRANGER = address(0xBEEF);

    // The morpho-safety panel, straight out of panel-root.mjs. Leaves are real
    // signal hashes re-derived from tools/fixtures.
    bytes32 constant CLAIM = 0x60548c6897ac877688c5b502c4184efff295203b5265fc0e5a10f8255ae16d2f;
    bytes32 constant CASE_ID = 0x831e53462904ab7b4c0e582d0cd5aa7946a0d4d8bacaa1589ca3fd9fd21b680a;
    bytes32 constant PANEL_ROOT = 0x603c7e1baf72a30eddbd90a9b9cc9e7d586bd61f1c72f88848a46031c97285b0;
    bytes32 constant JUROR_TAVILY = 0xa5c84f2fc272fab580c7851c7f9cbc05e3c0835c15444b2f77b57aa6ce30b198;
    bytes32 constant JUROR_SARZOPS = 0xea7879a90f63fb6f893548945fe1c079730c372d74d96cd4a77b752cf9d5832a;
    bytes32 constant JUROR_NETWIRE = 0x914718b264a57ea3515cf07a9713340d5c0774c326f3db5310e16365ae7ecab1;
    bytes32 constant JUROR_PAIR = 0xf8a8f83edec3042067c3af8ef92ca80744905d7b472a902a3458d9ffce8fbe5e;
    bytes32 constant NOT_A_JUROR = 0xe7885e7cf02f28d55feebca1ff3e181836bdf87c62a207369caa041cc6228ae8;

    // The hung panel.
    bytes32 constant HUNG_CLAIM = 0x734020a58013ea75289e80a48f7a9ccae5c13ea9a9ea2363c227a1681f4b33df;
    bytes32 constant HUNG_CASE_ID = 0x8c048d9390972588e0d009ee537229778238681196da90f5bfb773cc8db53189;
    bytes32 constant HUNG_ROOT = 0xc69cbe5107baf7d5e3f08b36ee34ca9a27f62d717883af1c2038ffac43e4888f;

    MinerCourt court;
    Gate gate;

    function setUp() public {
        court = new MinerCourt(DIAMOND, RECORDER);
        gate = new Gate(address(court), 5000);
        vm.warp(1788500000);
        vm.prank(RECORDER);
        court.enterVerdict(CASE_ID, CLAIM, 1, 6000, 3, PANEL_ROOT);
        vm.prank(RECORDER);
        court.enterVerdict(HUNG_CASE_ID, HUNG_CLAIM, 3, 5000, 3, HUNG_ROOT);
    }

    function assertTrue(bool ok, string memory what) internal pure {
        require(ok, what);
    }

    function test_latestAnswerReadsBackWhatWasEntered() public view {
        (uint8 verdict, uint16 confidenceBp, uint16 panelSize, uint256 updatedAt) = court.latestAnswer(CLAIM);
        assertTrue(verdict == 1, "verdict");
        assertTrue(confidenceBp == 6000, "confidence");
        assertTrue(panelSize == 3, "panelSize");
        assertTrue(updatedAt == 1788500000, "updatedAt");
        assertTrue(court.getCase(CLAIM).caseId == CASE_ID, "caseId");
        assertTrue(court.caseCount() == 2, "caseCount");
        assertTrue(court.claimHashAt(0) == CLAIM, "docket order");
    }

    function test_unknownClaimReadsAsZero() public view {
        (uint8 verdict,,, uint256 updatedAt) = court.latestAnswer(keccak256("never ruled on"));
        assertTrue(verdict == 0 && updatedAt == 0, "empty");
        assertTrue(!court.isFresh(keccak256("never ruled on"), 1 days), "not fresh");
    }

    function test_onlyRecorderWrites() public {
        vm.expectRevert(MinerCourt.NotRecorder.selector);
        vm.prank(STRANGER);
        court.enterVerdict(CASE_ID, CLAIM, 1, 6000, 3, PANEL_ROOT);
    }

    function test_rejectsNonsenseRecords() public {
        vm.expectRevert(abi.encodeWithSelector(MinerCourt.BadVerdict.selector, uint8(4)));
        vm.prank(RECORDER);
        court.enterVerdict(CASE_ID, CLAIM, 4, 6000, 3, PANEL_ROOT);

        vm.expectRevert(abi.encodeWithSelector(MinerCourt.BadConfidence.selector, uint16(10001)));
        vm.prank(RECORDER);
        court.enterVerdict(CASE_ID, CLAIM, 1, 10001, 3, PANEL_ROOT);

        vm.expectRevert(MinerCourt.EmptyPanel.selector);
        vm.prank(RECORDER);
        court.enterVerdict(CASE_ID, CLAIM, 1, 6000, 0, PANEL_ROOT);

        vm.expectRevert(MinerCourt.BadCaseId.selector);
        vm.prank(RECORDER);
        court.enterVerdict(bytes32(0), CLAIM, 1, 6000, 3, PANEL_ROOT);
    }

    function test_freshnessWindow() public {
        assertTrue(court.isFresh(CLAIM, 3600), "fresh at entry");
        vm.warp(1788500000 + 3600);
        assertTrue(court.isFresh(CLAIM, 3600), "fresh on the boundary");
        vm.warp(1788500000 + 3601);
        assertTrue(!court.isFresh(CLAIM, 3600), "stale one second later");
    }

    function test_verifyJurorAcceptsEveryPanelMember() public view {
        bytes32[] memory proofTavily = new bytes32[](2);
        proofTavily[0] = JUROR_NETWIRE;
        proofTavily[1] = JUROR_SARZOPS;
        assertTrue(court.verifyJuror(CLAIM, JUROR_TAVILY, proofTavily), "tavily");

        bytes32[] memory proofNetwire = new bytes32[](2);
        proofNetwire[0] = JUROR_TAVILY;
        proofNetwire[1] = JUROR_SARZOPS;
        assertTrue(court.verifyJuror(CLAIM, JUROR_NETWIRE, proofNetwire), "netwire");

        bytes32[] memory proofSarzops = new bytes32[](1);
        proofSarzops[0] = JUROR_PAIR;
        assertTrue(court.verifyJuror(CLAIM, JUROR_SARZOPS, proofSarzops), "sarzops");
    }

    function test_verifyJurorRejectsAnOutsider() public view {
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = JUROR_NETWIRE;
        proof[1] = JUROR_SARZOPS;
        assertTrue(!court.verifyJuror(CLAIM, NOT_A_JUROR, proof), "outsider with a real proof");

        bytes32[] memory empty = new bytes32[](0);
        assertTrue(!court.verifyJuror(CLAIM, NOT_A_JUROR, empty), "outsider with no proof");
        assertTrue(!court.verifyJuror(keccak256("no such case"), JUROR_TAVILY, proof), "no case");

        // A member of the other panel is not a member of this one.
        assertTrue(!court.verifyJuror(HUNG_CLAIM, JUROR_TAVILY, proof), "wrong panel");
    }

    function test_gateActsOnASupportedCase() public {
        gate.actIfSupported(CLAIM, 1 days);
        assertTrue(gate.actions() == 1, "acted once");
    }

    function test_gateRefusesAHungCase() public {
        vm.expectRevert(abi.encodeWithSelector(Gate.NotSupported.selector, uint8(3)));
        gate.actIfSupported(HUNG_CLAIM, 1 days);
        assertTrue(gate.actions() == 0, "no action");
    }

    function test_gateRefusesLowConfidence() public {
        bytes32 claim = keccak256("a claim the panel barely believes");
        vm.prank(RECORDER);
        court.enterVerdict(keccak256("case-low"), claim, 1, 4999, 3, PANEL_ROOT);
        vm.expectRevert(abi.encodeWithSelector(Gate.ConfidenceTooLow.selector, uint16(4999), uint16(5000)));
        gate.actIfSupported(claim, 1 days);
    }

    function test_gateRefusesAStaleVerdict() public {
        vm.warp(1788500000 + 601);
        vm.expectRevert(abi.encodeWithSelector(Gate.VerdictStale.selector, CLAIM, uint256(600)));
        gate.actIfSupported(CLAIM, 600);
    }

    function test_gateRefusesAnUnknownClaim() public {
        vm.expectRevert(abi.encodeWithSelector(Gate.NotSupported.selector, uint8(0)));
        gate.actIfSupported(keccak256("never ruled on"), 1 days);
    }

    function test_appealRoundTrip() public {
        vm.prank(RECORDER);
        court.registerAppeal(CASE_ID, 34);
        assertTrue(court.appealCase(34) == CASE_ID, "bound");
        assertTrue(court.appealCount() == 1, "counted");

        MinerCourt.OnChainData memory response;
        response.addresses = new address[](0);
        response.integers = new uint256[](1);
        response.integers[0] = 9500;
        response.strings = new string[](1);
        response.strings[0] = "SUPPORTED";
        response.bools = new bool[](1);
        response.bools[0] = false;

        vm.prank(DIAMOND);
        court.subnetMessage(34, true, response, "");
        assertTrue(
            court.appealAnswerHash(34) == keccak256(abi.encode(uint256(34), true, response, "")),
            "answer committed"
        );
    }

    function test_onlyDiamondDelivers() public {
        MinerCourt.OnChainData memory response;
        response.addresses = new address[](0);
        response.integers = new uint256[](0);
        response.strings = new string[](0);
        response.bools = new bool[](0);
        vm.expectRevert(MinerCourt.NotDiamond.selector);
        vm.prank(STRANGER);
        court.subnetMessage(34, true, response, "");
    }

    function test_appealCannotBeRegisteredTwice() public {
        vm.prank(RECORDER);
        court.registerAppeal(CASE_ID, 34);
        vm.expectRevert(abi.encodeWithSelector(MinerCourt.AppealAlreadyRegistered.selector, uint256(34)));
        vm.prank(RECORDER);
        court.registerAppeal(HUNG_CASE_ID, 34);
    }

    function test_recorderCanHandOver() public {
        vm.prank(RECORDER);
        court.setRecorder(STRANGER);
        assertTrue(court.recorder() == STRANGER, "handed over");
        vm.expectRevert(MinerCourt.NotRecorder.selector);
        vm.prank(RECORDER);
        court.enterVerdict(CASE_ID, CLAIM, 1, 6000, 3, PANEL_ROOT);
    }
}
