// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HaltView, IResolutionEngine} from "@eros/interfaces/IResolutionIngress.sol";
import {FeedSpec, Globals, Resolution, RState} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O14.2: `haltScheduled`, `requestResolution`, `escalateToL2`, `openAfterDeadline` and
///         `getL1Job` (plan §5.3, §5.4, §6.4, D3, D4, D16, ORC-11, ORC-12), including every no-op return.
/// @dev Expected clocks are hand-derived from the fixture: T = listing + 1,800 s, buffer 60 s, L1 timeout
///      300 s, L2 deadline 600 s, voidSecs 7,200 s, so a scheduled halt gives voidDeadline = T + 7,200.
contract OracleHaltTest is OracleFixture {
    // ------------------------------------------------------------------ haltScheduled

    /// haltScheduled: no-op before T and once halted; L1Pending or L2Pending at T; a late keeper copies economicHaltAt = T; early states; pinning; the snapshot copied as is.
    function test_halt() public {
        uint256 snap = vm.snapshotState();
        {
            // test_halt_beforeTIsANoOp
            (bytes32 id,) = _listFeed();
            vm.warp(T - 1);
            assertFalse(ro.haltScheduled(id));
            assertEq(uint8(_state(id)), uint8(RState.None));
        }
        vm.revertToState(snap);
        {
            // test_halt_atT_feedMarket
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            vm.warp(T);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.HaltRecorded(id, T, OI, T + 7_200, 1, false);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.StateChanged(id, RState.None, RState.L1Pending);
            vm.prank(keeper);
            assertTrue(ro.haltScheduled(id));
            Resolution memory r = _res(id);
            assertEq(uint8(r.state), uint8(RState.L1Pending));
            assertEq(r.haltedAt, T);
            assertEq(r.oiHaltLots, OI);
            assertEq(r.voidDeadline, T + 7_200);
            assertEq(r.trustSetId, 1);
            assertEq(r.globalsVersion, 1);
            assertEq(r.l2StartedAt, 0, "set only for L2");
            assertTrue(e.getHaltSnapshot().halted);
        }
        vm.revertToState(snap);
        {
            // test_halt_lateKeeperCopiesEconomicHaltAt
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            vm.warp(T + 500);
            ro.haltScheduled(id);
            Resolution memory r = _res(id);
            assertEq(r.haltedAt, T, "economicHaltAt, not the late block time (ORC-11)");
            assertEq(r.haltedAt, e.getHaltSnapshot().economicHaltAt);
            assertEq(r.voidDeadline, T + 7_200, "max(haltedAt, T) + voidSecs (ORC-12)");
        }
        vm.revertToState(snap);
        {
            // test_halt_noFeedGoesToL2
            (bytes32 id,) = _listNoFeed();
            vm.warp(T + 30);
            ro.haltScheduled(id);
            Resolution memory r = _res(id);
            assertEq(uint8(r.state), uint8(RState.L2Pending));
            assertEq(r.l2StartedAt, T, "l2StartedAt = haltedAt");
        }
        vm.revertToState(snap);
        {
            // test_halt_onceOnly
            (bytes32 id,) = _listFeed();
            vm.warp(T);
            ro.haltScheduled(id);
            vm.warp(T + 100);
            vm.recordLogs();
            assertFalse(ro.haltScheduled(id));
            assertEq(vm.getRecordedLogs().length, 0);
            assertEq(_res(id).voidDeadline, T + 7_200, "set once");
        }
        vm.revertToState(snap);
        {
            // test_halt_fromEarlyStates
            (bytes32 id,) = _listFeed();
            (bytes32 nf,) = _listNoFeed();
            _forceState(id, RState.EarlyCheck);
            _forceState(nf, RState.EarlyReview);
            vm.warp(T);
            assertTrue(ro.haltScheduled(id));
            assertTrue(ro.haltScheduled(nf));
            assertEq(uint8(_state(id)), uint8(RState.L1Pending), "EarlyCheck -> L1Pending (D4)");
            assertEq(uint8(_state(nf)), uint8(RState.L2Pending), "EarlyReview -> L2Pending without a feed");
        }
        vm.revertToState(snap);
        {
            // test_halt_pinsTrustSetAndGlobalsVersion
            (bytes32 a,) = _listFeed();
            (bytes32 b,) = _listNoFeed();
            vm.warp(T);
            ro.haltScheduled(a);
            vm.startPrank(gov);
            ro.createTrustSet(_trustSet());
            ro.activateTrustSet(2);
            Globals memory g = _globals();
            g.minRequestIntervalSecs = 120;
            reg.setGlobals(g);
            vm.stopPrank();
            ro.haltScheduled(b);
            assertEq(_res(a).trustSetId, 1, "kept after a new set is activated");
            assertEq(_res(a).globalsVersion, 1, "kept after new globals");
            assertEq(_res(b).trustSetId, 2, "a later halt pins the new set");
            assertEq(_res(b).globalsVersion, 2);
        }
        vm.revertToState(snap);
        {
            // test_halt_copiesTheEngineSnapshotAsIs (A misbehaving engine reporting an earlier economic halt is copied as is (ORC-11); the deadline still counts from T.)
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            e.setHaltTimeSkew(-60);
            vm.warp(T);
            ro.haltScheduled(id);
            assertEq(_res(id).haltedAt, T - 60);
            assertEq(_res(id).voidDeadline, T + 7_200);
        }
        vm.revertToState(snap);
        {
            // test_halt_needsAnActiveTrustSet
            (bytes32 id,) = _listFeed();
            ro.setActiveTrustSetId(0); // defensive: governance can never return to 0
            vm.warp(T);
            vm.expectRevert(IResolutionOracle.NoActiveTrustSet.selector);
            ro.haltScheduled(id);
        }
    }

    function test_halt_engineRevertBubbles() public {
        (bytes32 id, MockResolutionEngine e) = _listFeed();
        vm.mockCallRevert(address(e), abi.encodeWithSelector(IResolutionEngine.halt.selector), "engine down");
        vm.warp(T);
        vm.expectRevert(bytes("engine down"));
        ro.haltScheduled(id);
        assertEq(uint8(_state(id)), uint8(RState.None), "nothing recorded");
    }

    function test_halt_unhaltedSnapshotRefused() public {
        (bytes32 id, MockResolutionEngine e) = _listFeed();
        HaltView memory lie;
        vm.mockCall(address(e), abi.encodeWithSelector(IResolutionEngine.halt.selector), abi.encode(lie));
        vm.warp(T);
        vm.expectRevert(IResolutionOracle.EngineCallFailed.selector);
        ro.haltScheduled(id);
    }

    function test_unknownMarketReverts() public {
        bytes32 id = keccak256("never listed");
        vm.expectRevert(IResolutionOracle.UnknownMarket.selector);
        ro.haltScheduled(id);
        vm.expectRevert(IResolutionOracle.UnknownMarket.selector);
        ro.requestResolution(id);
        vm.expectRevert(IResolutionOracle.UnknownMarket.selector);
        ro.escalateToL2(id);
        vm.expectRevert(IResolutionOracle.UnknownMarket.selector);
        ro.openAfterDeadline(id);
    }

    // ------------------------------------------------------------------ requestResolution

    /// requestResolution: NoFeed, TooEarly, halts first and emits, rate limit on the pinned interval, false in other states.
    function test_request() public {
        uint256 snap = vm.snapshotState();
        {
            // test_request_noFeed
            (bytes32 id,) = _listNoFeed();
            vm.warp(T + 60);
            vm.expectRevert(IResolutionOracle.NoFeed.selector);
            ro.requestResolution(id);
        }
        vm.revertToState(snap);
        {
            // test_request_tooEarly
            (bytes32 id,) = _listFeed();
            vm.warp(T + 59); // buffer is 60 s
            vm.expectRevert(IResolutionOracle.TooEarly.selector);
            ro.requestResolution(id);
            assertEq(uint8(_state(id)), uint8(RState.None), "no halt either");
        }
        vm.revertToState(snap);
        {
            // test_request_haltsFirstAndEmits
            (bytes32 id,) = _listFeed();
            vm.warp(T + 60);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.ResolutionRequested(id, T + 60, 1);
            vm.prank(keeper);
            assertTrue(ro.requestResolution(id));
            Resolution memory r = _res(id);
            assertEq(uint8(r.state), uint8(RState.L1Pending));
            assertEq(r.haltedAt, T);
            assertEq(r.lastRequestAt, T + 60);
            assertEq(r.requestCount, 1);
        }
        vm.revertToState(snap);
        {
            // test_request_rateLimited
            (bytes32 id,) = _listFeed();
            vm.warp(T + 60);
            ro.requestResolution(id);
            vm.warp(T + 60 + 59); // minRequestIntervalSecs is 60 s
            vm.recordLogs();
            assertFalse(ro.requestResolution(id));
            assertEq(vm.getRecordedLogs().length, 0);
            vm.warp(T + 60 + 60);
            assertTrue(ro.requestResolution(id));
            assertEq(_res(id).requestCount, 2);
        }
        vm.revertToState(snap);
        {
            // test_request_usesThePinnedInterval
            (bytes32 id,) = _listFeed();
            vm.warp(T + 60);
            ro.requestResolution(id);
            Globals memory g = _globals();
            g.minRequestIntervalSecs = 600;
            vm.prank(gov);
            reg.setGlobals(g);
            vm.warp(T + 120);
            assertTrue(ro.requestResolution(id), "version 1's 60 s still applies");
        }
        vm.revertToState(snap);
        {
            // test_request_otherStatesReturnFalse
            (bytes32 id,) = _listFeed();
            vm.warp(T + 300);
            ro.escalateToL2(id); // pre-halt: nothing to escalate
            ro.requestResolution(id);
            assertTrue(ro.escalateToL2(id));
            vm.warp(T + 400); // past the rate limit, so only the state can refuse
            assertFalse(ro.requestResolution(id), "L2Pending");
            _forceState(id, RState.Final);
            assertFalse(ro.requestResolution(id), "Final");
        }
    }

    // ------------------------------------------------------------------ escalateToL2

    function test_escalate_atL1Timeout() public {
        (bytes32 id,) = _listFeed();
        vm.warp(T + 60);
        ro.requestResolution(id);
        vm.warp(T + 299);
        assertFalse(ro.escalateToL2(id));
        vm.warp(T + 300);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.StateChanged(id, RState.L1Pending, RState.L2Pending);
        assertTrue(ro.escalateToL2(id));
        assertEq(_res(id).l2StartedAt, T + 300, "escalation time");
        assertFalse(ro.escalateToL2(id), "once");
    }

    // ------------------------------------------------------------------ openAfterDeadline

    /// openAfterDeadline: at the L2 deadline, Review with and without retryOpensAt, early-halted markets wait for T, false otherwise.
    function test_open() public {
        uint256 snap = vm.snapshotState();
        {
            // test_open_afterL2Deadline
            (bytes32 id,) = _listNoFeed();
            vm.warp(T);
            ro.haltScheduled(id); // L2Pending, l2StartedAt = T
            vm.warp(T + 599);
            assertFalse(ro.openAfterDeadline(id));
            vm.warp(T + 600);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.StateChanged(id, RState.L2Pending, RState.Open);
            assertTrue(ro.openAfterDeadline(id));
            assertFalse(ro.openAfterDeadline(id), "once");
        }
        vm.revertToState(snap);
        {
            // test_open_reviewUsesRetryOpensAt
            (bytes32 id,) = _listNoFeed();
            vm.warp(T);
            ro.haltScheduled(id);
            Resolution memory r = _res(id);
            r.state = RState.Review;
            r.retryOpensAt = T + 1_000; // after a rejection: committee-only until then
            ro.setResolution(id, r);
            vm.warp(T + 999);
            assertFalse(ro.openAfterDeadline(id), "the L2 deadline has passed but the retry window has not");
            vm.warp(T + 1_000);
            assertTrue(ro.openAfterDeadline(id));
        }
        vm.revertToState(snap);
        {
            // test_open_reviewWithoutRetryUsesL2Deadline
            (bytes32 id,) = _listNoFeed();
            vm.warp(T);
            ro.haltScheduled(id);
            _forceState(id, RState.Review); // a panel result routed to review
            vm.warp(T + 600);
            assertTrue(ro.openAfterDeadline(id));
        }
        vm.revertToState(snap);
        {
            // test_open_earlyHaltedMarketWaitsForT
            (bytes32 id,) = _listNoFeed();
            Resolution memory r;
            r.state = RState.Review; // a rejected early proposal
            r.haltedAt = NOW + 100;
            r.retryOpensAt = NOW + 200;
            r.trustSetId = 1;
            ro.setResolution(id, r);
            vm.warp(T - 1);
            assertFalse(ro.openAfterDeadline(id), "committee-only until T (ORC-15)");
            vm.warp(T);
            assertTrue(ro.openAfterDeadline(id));
        }
        vm.revertToState(snap);
        {
            // test_open_otherStatesReturnFalse
            (bytes32 id,) = _listFeed();
            vm.warp(T + 10_000);
            assertFalse(ro.openAfterDeadline(id), "None");
            ro.haltScheduled(id);
            assertFalse(ro.openAfterDeadline(id), "L1Pending");
        }
    }

    // ------------------------------------------------------------------ getL1Job

    function test_getL1Job() public {
        (bytes32 id,) = _listFeed();
        vm.warp(T);
        ro.haltScheduled(id);
        (uint8 state, FeedSpec memory spec, string[] memory allowList, bytes32 specHash) = ro.getL1Job(id);
        assertEq(state, 3, "L1Pending, as the workflow hard-codes");
        assertEq(keccak256(abi.encode(spec)), keccak256(abi.encode(_feed())));
        assertEq(allowList.length, 2);
        assertEq(allowList[0], HOST);
        assertEq(specHash, keccak256(abi.encode(_feed())));
        (uint8 unknownState,,,) = ro.getL1Job(keccak256("never listed"));
        assertEq(unknownState, 0);
    }
}
