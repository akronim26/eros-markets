// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    Globals,
    Outcome,
    PanelLabel,
    PanelResult,
    Path,
    Phase,
    Resolution,
    RState
} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {SigLib} from "../../src/libraries/SigLib.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O14.5: the early check (§8.5) and the Layer 2 panel paths (§5.4 routing rows, §6.4 auto gate,
///         §8.6), with every routing row and every gate condition tested on both sides of its boundary.
/// @dev Fixture market: θ_hi 9,100 bps, category "sports"; testnet globals Δp_max 200 bps, N_min 150,
///      review limit 1,668,000,000 atoms (= 1,668,000 lots at 1,000 atoms per lot), early TTL 600 s.
contract OraclePanelTest is OracleFixture {
    bytes32 internal constant SPORTS = keccak256("sports");
    uint8 internal constant Y = uint8(PanelLabel.YES);
    uint8 internal constant N = uint8(PanelLabel.NO);
    uint8 internal constant I = uint8(PanelLabel.INVALID);
    uint8 internal constant NY = uint8(PanelLabel.NOT_YET);
    uint8 internal constant AB = uint8(PanelLabel.ABSTAIN);

    /// keccak256(abi.encode(modelIdHashes, promptHash, calibratorHash, highConfBps)) of the fixture market.
    function _gate() internal pure returns (bytes32) {
        bytes32[3] memory models = [keccak256("a:m1@1"), keccak256("b:m2@1"), keccak256("c:m3@1")];
        return keccak256(abi.encode(models, keccak256("prompt"), keccak256("calibrator"), uint16(9_100)));
    }

    // ------------------------------------------------------------------ helpers

    function _panel(bytes32 id, Phase phase, uint8 a, uint8 b, uint8 c) internal view returns (PanelResult memory p) {
        Resolution memory r = _res(id);
        p.marketId = id;
        p.phase = uint8(phase);
        p.attempt = r.attempts;
        p.labels = [a, b, c];
        p.calibratedBps = [uint16(9_100), uint16(9_500), uint16(9_900)];
        p.evidenceHash = keccak256("snapshot");
        p.evidenceURIHash = keccak256(bytes(URI));
        p.gateHash = _gate();
        p.trustSetId = r.trustSetId != 0 ? r.trustSetId : ro.activeTrustSetId();
        p.deadline = uint64(block.timestamp + 1 hours);
    }

    function _psig(PanelResult memory p) internal view returns (bytes memory) {
        bytes32 d = keccak256(
            abi.encodePacked(hex"1901", SigLib.domainSeparator(block.chainid, address(ro)), SigLib.hashPanelResult(p))
        );
        return _sign(attestorKey, d);
    }

    function _submit(bytes32 id, PanelResult memory p) internal returns (RState) {
        return ro.submitPanelResult(id, p, URI, _psig(p));
    }

    function _toEarlyCheck(bytes32 id, MockResolutionEngine e) internal {
        vm.startPrank(monitor);
        e.setMonitorRestricted(true);
        ro.requestEarlyCheck(id);
        vm.stopPrank();
    }

    function _validate(uint16 u95, uint32 n) internal {
        vm.prank(gov);
        reg.setCategory(SPORTS, _gate(), u95, n, true);
    }

    /// A no-feed market in L2Pending at T, with its category validated before the halt.
    function _l2(bool validated) internal returns (bytes32 id, MockResolutionEngine e) {
        (id, e) = _listNoFeed();
        if (validated) _validate(200, 150);
        _halt(id);
    }

    function _expectGate(bytes32 id, PanelResult memory p, uint8 code) internal {
        bytes memory sig = _psig(p);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.GateClosed.selector, code));
        ro.submitPanelProposal(id, p, URI, sig);
    }

    function _expectBad(bytes32 id, PanelResult memory p, bytes memory err) internal {
        bytes memory sig = _psig(p);
        vm.expectRevert(err);
        ro.submitPanelResult(id, p, URI, sig);
    }

    function _bad(uint8 code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, code);
    }

    // ------------------------------------------------------------------ requestEarlyCheck and expireEarly

    function test_gateHashIsTheMarkets() public {
        (bytes32 id,) = _listNoFeed();
        assertEq(reg.getMarketCore(id).gateHash, _gate());
    }

    /// requestEarlyCheck and expireEarly (from EarlyCheck and EarlyReview).
    function test_earlyCheck() public {
        uint256 snap = vm.snapshotState();
        {
            // test_earlyCheck_request
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            vm.warp(NOW + 100);
            vm.prank(monitor);
            e.setMonitorRestricted(true);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.StateChanged(id, RState.None, RState.EarlyCheck);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.EarlyCheckRequested(id, NOW + 100);
            vm.prank(monitor);
            ro.requestEarlyCheck(id);
            assertEq(uint8(_state(id)), uint8(RState.EarlyCheck));
            assertEq(_res(id).earlyStartedAt, NOW + 100);
            assertFalse(e.getHaltSnapshot().halted, "an early check does not halt");
        }
        vm.revertToState(snap);
        {
            // test_earlyCheck_guards
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            vm.expectRevert(IResolutionOracle.UnknownMarket.selector);
            ro.requestEarlyCheck(keccak256("nope"));
            vm.prank(monitor);
            vm.expectRevert(IResolutionOracle.EngineCallFailed.selector); // engine not reduce-only yet
            ro.requestEarlyCheck(id);
            vm.prank(monitor);
            e.setMonitorRestricted(true);
            vm.prank(keeper);
            vm.expectRevert(IResolutionOracle.Unauthorized.selector);
            ro.requestEarlyCheck(id);
            vm.warp(T);
            vm.prank(monitor);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.None));
            ro.requestEarlyCheck(id);
            vm.warp(T - 1);
            vm.prank(monitor);
            ro.requestEarlyCheck(id);
            vm.prank(monitor);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.EarlyCheck));
            ro.requestEarlyCheck(id);
        }
        vm.revertToState(snap);
        {
            // test_expireEarly
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            assertFalse(ro.expireEarly(id), "None");
            _toEarlyCheck(id, e);
            vm.warp(NOW + 599);
            assertFalse(ro.expireEarly(id), "TTL not over");
            vm.warp(NOW + 600);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.StateChanged(id, RState.EarlyCheck, RState.None);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.EarlyCheckCleared(id, 1);
            assertTrue(ro.expireEarly(id));
            assertEq(uint8(_state(id)), uint8(RState.None));
            assertEq(_res(id).earlyStartedAt, 0);
            vm.prank(monitor);
            ro.requestEarlyCheck(id); // the monitor can ask again
            assertEq(_res(id).earlyStartedAt, NOW + 600);
        }
        vm.revertToState(snap);
        {
            // test_expireEarly_fromEarlyReview
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            _toEarlyCheck(id, e);
            vm.warp(NOW + 500);
            _submit(id, _panel(id, Phase.EARLY, Y, Y, Y)); // EarlyReview restarts the TTL
            vm.warp(NOW + 500 + 599);
            assertFalse(ro.expireEarly(id));
            vm.warp(NOW + 500 + 600);
            assertTrue(ro.expireEarly(id));
            assertEq(uint8(_state(id)), uint8(RState.None));
        }
    }

    // ------------------------------------------------------------------ early panel routing

    /// EarlyCheck routing: known or flagged → EarlyReview, otherwise None; the confidence floor; payload checks.
    function test_earlyPanel() public {
        uint256 snap = vm.snapshotState();
        {
            // test_earlyPanel_knownGoesToEarlyReview
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            _toEarlyCheck(id, e);
            vm.warp(NOW + 60);
            PanelResult memory p = _panel(id, Phase.EARLY, I, I, I);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.StateChanged(id, RState.EarlyCheck, RState.EarlyReview);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.PanelResultAccepted(
                id, Phase.EARLY, p.labels, p.calibratedBps, p.evidenceHash, URI, RState.EarlyReview
            );
            assertEq(uint8(_submit(id, p)), uint8(RState.EarlyReview));
            assertEq(_res(id).earlyStartedAt, NOW + 60);
            assertEq(uint8(_res(id).proposed), uint8(Outcome.NONE), "the committee decides");
            assertFalse(e.getHaltSnapshot().halted);
        }
        vm.revertToState(snap);
        {
            // test_earlyPanel_unknownGoesToNone
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            uint8[3][5] memory unknown = [[Y, Y, N], [Y, N, Y], [NY, NY, NY], [AB, AB, AB], [Y, Y, I]];
            for (uint256 i; i < unknown.length; ++i) {
                _toEarlyCheck(id, e);
                PanelResult memory p = _panel(id, Phase.EARLY, unknown[i][0], unknown[i][1], unknown[i][2]);
                vm.expectEmit(address(ro));
                emit IResolutionOracle.EarlyCheckCleared(id, 0);
                assertEq(uint8(_submit(id, p)), uint8(RState.None));
                assertEq(_res(id).earlyStartedAt, 0);
            }
        }
        vm.revertToState(snap);
        {
            // test_earlyPanel_confidenceFloor
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            _toEarlyCheck(id, e);
            PanelResult memory p = _panel(id, Phase.EARLY, N, N, N);
            p.calibratedBps[2] = 9_099;
            assertEq(uint8(_submit(id, p)), uint8(RState.None), "one below theta_hi");
            _toEarlyCheck(id, e);
            p.calibratedBps = [uint16(9_100), uint16(9_100), uint16(9_100)];
            assertEq(uint8(_submit(id, p)), uint8(RState.EarlyReview), "theta_hi itself is confident");
        }
        vm.revertToState(snap);
        {
            // test_earlyPanel_flagGoesToEarlyReview
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            _toEarlyCheck(id, e);
            PanelResult memory p = _panel(id, Phase.EARLY, Y, N, AB);
            p.calibratedBps = [uint16(0), uint16(0), uint16(0)];
            p.flags = 1; // injection suspected
            assertEq(uint8(_submit(id, p)), uint8(RState.EarlyReview));
        }
        vm.revertToState(snap);
        {
            // test_earlyPanel_payloadChecks
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            _toEarlyCheck(id, e);
            PanelResult memory p = _panel(id, Phase.EARLY, Y, Y, Y);
            p.marketId = keccak256("other");
            _expectBad(id, p, _bad(7));
            p = _panel(id, Phase.EARLY, Y, Y, Y);
            p.attempt = 1;
            _expectBad(id, p, _bad(2));
            p = _panel(id, Phase.EARLY, Y, Y, Y);
            p.trustSetId = 2;
            _expectBad(id, p, _bad(4));
            p = _panel(id, Phase.EARLY, Y, Y, Y);
            p.evidenceURIHash = keccak256("x");
            _expectBad(id, p, _bad(5));
            p = _panel(id, Phase.POST_T, Y, Y, Y);
            _expectBad(id, p, _bad(1));
            p = _panel(id, Phase.EARLY, Y, Y, Y);
            p.gateHash = keccak256("another panel");
            _expectBad(id, p, _bad(3));
            p = _panel(id, Phase.EARLY, Y, Y, Y);
            p.deadline = uint64(block.timestamp - 1);
            _expectBad(id, p, abi.encodeWithSelector(IResolutionOracle.SignatureExpired.selector));
            p.deadline = uint64(block.timestamp);
            assertEq(uint8(_submit(id, p)), uint8(RState.EarlyReview), "at the deadline is valid");
        }
    }

    /// Panel signatures and wrong states are refused.
    function test_panel_rejections() public {
        uint256 snap = vm.snapshotState();
        {
            // test_panel_signatureChecks
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            _toEarlyCheck(id, e);
            PanelResult memory p = _panel(id, Phase.EARLY, Y, Y, Y);
            bytes memory good = _psig(p);
            (, uint256 otherKey) = makeAddrAndKey("not the attestor");
            bytes32 d = keccak256(
                abi.encodePacked(
                    hex"1901", SigLib.domainSeparator(block.chainid, address(ro)), SigLib.hashPanelResult(p)
                )
            );
            vm.expectRevert(IResolutionOracle.BadSignature.selector);
            ro.submitPanelResult(id, p, URI, _sign(otherKey, d));
            vm.expectRevert(IResolutionOracle.BadSignature.selector);
            ro.submitPanelResult(id, p, URI, bytes.concat(good, hex"00")); // 66 bytes
            PanelResult memory q = _panel(id, Phase.EARLY, Y, Y, N); // signed payload changed
            vm.expectRevert(IResolutionOracle.BadSignature.selector);
            ro.submitPanelResult(id, q, URI, good);
            vm.prank(guardian);
            ro.revokeAttestor(1);
            vm.expectRevert(IResolutionOracle.BadSignature.selector);
            ro.submitPanelResult(id, p, URI, good);
        }
        vm.revertToState(snap);
        {
            // test_panel_wrongState
            (bytes32 id,) = _listNoFeed();
            PanelResult memory p = _panel(id, Phase.EARLY, Y, Y, Y);
            _expectBad(id, p, abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.None));
            _halt(id);
            _forceState(id, RState.Review);
            p = _panel(id, Phase.POST_T, Y, Y, Y);
            _expectBad(id, p, abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Review));
            bytes memory sig = _psig(p);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Review));
            ro.submitPanelProposal(id, p, URI, sig);
        }
    }

    // ------------------------------------------------------------------ early path end to end

    function test_early_committeeHaltsThenRejectionWaitsForT() public {
        (bytes32 id, MockResolutionEngine e) = _listNoFeed();
        _toEarlyCheck(id, e);
        vm.warp(NOW + 120);
        _submit(id, _panel(id, Phase.EARLY, Y, Y, Y));
        vm.warp(NOW + 180);
        _propose(id, uint8(Outcome.YES));
        Resolution memory r = _res(id);
        assertEq(r.haltedAt, NOW + 180, "the early proposal halts at its block time");
        assertEq(uint8(r.path), uint8(Path.REVIEWED), "ORC-15");
        assertTrue(ro.assertProposal(id));
        mvenue.setResult(_res(id).assertionId, false);
        ro.finalizeMarket(id);
        assertEq(uint8(_state(id)), uint8(RState.Review));
        assertEq(_res(id).retryOpensAt, NOW + 180 + 300);
        vm.warp(NOW + 180 + 300);
        assertFalse(ro.openAfterDeadline(id), "committee-only until T");
        PanelResult memory p = _panel(id, Phase.POST_T, N, N, N);
        _expectBad(id, p, abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Review));
        vm.warp(T);
        assertTrue(ro.openAfterDeadline(id));
    }

    // ------------------------------------------------------------------ L2 panel routing

    /// L2Pending routing: NOT_YET stays, gate closed → Review, gate passes → L2_AUTO; the pinned set.
    function test_l2Routing() public {
        uint256 snap = vm.snapshotState();
        {
            // test_l2_notYetStays
            (bytes32 id,) = _l2(true);
            PanelResult memory p = _panel(id, Phase.POST_T, NY, Y, NY);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.PanelNotYet(id, 0);
            assertEq(uint8(_submit(id, p)), uint8(RState.L2Pending));
            assertEq(uint8(_state(id)), uint8(RState.L2Pending));
            p = _panel(id, Phase.POST_T, NY, Y, Y); // one NOT_YET is a split
            assertEq(uint8(_submit(id, p)), uint8(RState.Review));
        }
        vm.revertToState(snap);
        {
            // test_l2_gateClosedGoesToReview
            (bytes32 id,) = _l2(false); // launch: no category validated
            PanelResult memory p = _panel(id, Phase.POST_T, Y, Y, Y);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.StateChanged(id, RState.L2Pending, RState.Review);
            assertEq(uint8(_submit(id, p)), uint8(RState.Review));
            Resolution memory r = _res(id);
            assertEq(uint8(r.proposed), uint8(Outcome.NONE));
            assertEq(r.evidenceHash, 0);
            assertEq(r.retryOpensAt, 0, "opens at the L2 deadline");
        }
        vm.revertToState(snap);
        {
            // test_l2_gatePassesToL2Auto
            (bytes32 id,) = _l2(true);
            PanelResult memory p = _panel(id, Phase.POST_T, N, N, N);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.ProposalRecorded(id, Outcome.NO, Path.L2_AUTO, keccak256("snapshot"), URI, 0);
            assertEq(uint8(_submit(id, p)), uint8(RState.Proposed));
            Resolution memory r = _res(id);
            assertEq(uint8(r.proposed), uint8(Outcome.NO));
            assertEq(uint8(r.path), uint8(Path.L2_AUTO));
            assertEq(ro.evidenceURIOf(id), URI);
            vm.prank(watchdog);
            ro.watchdogHeartbeat();
            assertTrue(ro.assertProposal(id));
            assertEq(mvenue.statusOf(_res(id).assertionId).expiresAt, T + 120, "livenessAuto");
        }
        vm.revertToState(snap);
        {
            // test_l2_usesThePinnedSet
            (bytes32 id,) = _l2(true);
            vm.startPrank(gov);
            ro.createTrustSet(_trustSet());
            ro.activateTrustSet(2);
            vm.stopPrank();
            PanelResult memory p = _panel(id, Phase.POST_T, Y, Y, Y);
            assertEq(p.trustSetId, 1);
            p.trustSetId = 2;
            _expectBad(id, p, _bad(4));
            p = _panel(id, Phase.EARLY, Y, Y, Y);
            _expectBad(id, p, _bad(1));
            p = _panel(id, Phase.POST_T, Y, Y, Y);
            assertEq(uint8(_submit(id, p)), uint8(RState.Proposed));
        }
    }

    // ------------------------------------------------------------------ submitPanelProposal and the auto gate

    /// submitPanelProposal and every auto-gate condition on both sides, with the pinned globals.
    function test_gate() public {
        uint256 snap = vm.snapshotState();
        {
            // test_proposal_passes
            (bytes32 id,) = _l2(true);
            PanelResult memory p = _panel(id, Phase.POST_T, Y, Y, Y);
            ro.submitPanelProposal(id, p, URI, _psig(p));
            Resolution memory r = _res(id);
            assertEq(uint8(r.state), uint8(RState.Proposed));
            assertEq(uint8(r.proposed), uint8(Outcome.YES));
            assertEq(uint8(r.path), uint8(Path.L2_AUTO));
        }
        vm.revertToState(snap);
        {
            // test_gate_labels
            (bytes32 id,) = _l2(true);
            _expectGate(id, _panel(id, Phase.POST_T, Y, Y, N), 1);
            _expectGate(id, _panel(id, Phase.POST_T, N, Y, N), 1);
            _expectGate(id, _panel(id, Phase.POST_T, I, I, I), 1);
            _expectGate(id, _panel(id, Phase.POST_T, NY, NY, NY), 1);
            _expectGate(id, _panel(id, Phase.POST_T, AB, AB, AB), 1);
        }
        vm.revertToState(snap);
        {
            // test_gate_confidence
            (bytes32 id,) = _l2(true);
            PanelResult memory p = _panel(id, Phase.POST_T, Y, Y, Y);
            for (uint256 i; i < 3; ++i) {
                p.calibratedBps[i] = 9_099;
                _expectGate(id, p, 2);
                p.calibratedBps[i] = 9_100;
            }
            ro.submitPanelProposal(id, p, URI, _psig(p));
        }
        vm.revertToState(snap);
        {
            // test_gate_category
            (bytes32 id,) = _l2(false);
            PanelResult memory p = _panel(id, Phase.POST_T, Y, Y, Y);
            _expectGate(id, p, 3); // never validated
            vm.prank(gov);
            reg.setCategory(SPORTS, keccak256("another gate"), 200, 150, true);
            _expectGate(id, p, 3); // validated (in the halt block) for another gateHash
            vm.warp(T + 1);
            _validate(200, 150);
            _expectGate(id, p, 3); // validated after this market's halt
        }
        vm.revertToState(snap);
        {
            // test_gate_categoryValidatedAtTheHaltBlock
            (bytes32 id,) = _listNoFeed();
            vm.warp(T);
            _validate(200, 150);
            ro.haltScheduled(id); // validatedAt == haltedAt
            PanelResult memory p = _panel(id, Phase.POST_T, Y, Y, Y);
            ro.submitPanelProposal(id, p, URI, _psig(p));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_gate_categoryLimits
            (bytes32 a,) = _listNoFeed();
            (bytes32 b,) = _listFeed();
            _validate(201, 150); // U95 above Δp_max
            vm.warp(T);
            ro.haltScheduled(a);
            _expectGate(a, _panel(a, Phase.POST_T, Y, Y, Y), 3);
            vm.prank(gov);
            reg.setCategory(SPORTS, _gate(), 200, 149, true); // N below N_min, validated at T
            _expectGate(a, _panel(a, Phase.POST_T, Y, Y, Y), 3);
            _validate(200, 150); // validated at T again
            ro.haltScheduled(b);
            _forceState(b, RState.L2Pending);
            PanelResult memory p = _panel(b, Phase.POST_T, Y, Y, Y);
            ro.submitPanelProposal(b, p, URI, _psig(p));
        }
        vm.revertToState(snap);
        {
            // test_gate_revocationClosesAtOnce
            (bytes32 id,) = _l2(true);
            vm.prank(gov);
            reg.setCategory(SPORTS, _gate(), 200, 150, false);
            _expectGate(id, _panel(id, Phase.POST_T, Y, Y, Y), 3);
            assertEq(uint8(_submit(id, _panel(id, Phase.POST_T, Y, Y, Y))), uint8(RState.Review));
        }
        vm.revertToState(snap);
        {
            // test_gate_reviewLimit
            (bytes32 a, MockResolutionEngine ea) = _listNoFeed();
            (bytes32 b, MockResolutionEngine eb) = _listFeed();
            _validate(200, 150);
            ea.setOiLots(1_668_001); // 1,668,001,000 atoms > 1,668,000,000
            eb.setOiLots(1_668_000); // exactly the limit
            vm.warp(T);
            ro.haltScheduled(a);
            ro.haltScheduled(b);
            _expectGate(a, _panel(a, Phase.POST_T, Y, Y, Y), 4);
            _forceState(b, RState.L2Pending);
            PanelResult memory p = _panel(b, Phase.POST_T, Y, Y, Y);
            ro.submitPanelProposal(b, p, URI, _psig(p));
            assertEq(uint8(_state(b)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_gate_flagsAndEvidence
            (bytes32 id,) = _l2(true);
            PanelResult memory p = _panel(id, Phase.POST_T, Y, Y, Y);
            p.flags = 1;
            _expectGate(id, p, 5);
            p = _panel(id, Phase.POST_T, Y, Y, Y);
            p.evidenceHash = 0;
            _expectGate(id, p, 6);
            assertEq(uint8(_submit(id, p)), uint8(RState.Review), "the result routes to review instead");
        }
        vm.revertToState(snap);
        {
            // test_gate_usesThePinnedGlobals
            (bytes32 id,) = _l2(true);
            Globals memory g = _globals();
            g.nMin = 200;
            g.deltaPmaxBps = 100;
            g.reviewLimitAtoms = 0;
            vm.prank(gov);
            reg.setGlobals(g); // version 2, after the halt
            PanelResult memory p = _panel(id, Phase.POST_T, Y, Y, Y);
            ro.submitPanelProposal(id, p, URI, _psig(p));
            assertEq(uint8(_state(id)), uint8(RState.Proposed), "version 1 still applies");
        }
    }
}
