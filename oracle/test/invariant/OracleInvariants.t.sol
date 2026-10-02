// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {FinalOutcome} from "@eros-provisional/MathTypes.sol";
import {HaltView} from "@eros/interfaces/IResolutionIngress.sol";
import {
    FinalReason,
    GroupState,
    Ledger,
    MarketCore,
    Outcome,
    Resolution,
    RState
} from "../../src/types/OracleTypes.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";
import {OracleHandler} from "./OracleHandler.sol";

/// @notice Oracle invariants ORC-1 to ORC-15 (plan §5.5, D20, §11.1; tasks O17.1 handler, O17.2 invariants).
///         One `invariant_` function per ORC row. Facts that only show between two calls (a field that
///         changed, a report accepted in the wrong state, a ledger decrease) are latched by the handler's
///         ghosts after every action and read here; the rest are checked on the state itself.
/// @dev The handler deploys and wires the real ResolutionOracle, MarketRegistry and BondTreasury (with the
///      sim set 1 active and the production set 2 created) and is the only fuzz target. Two markets are
///      listed before the run so the first calls have something to act on. Profiles: default 64 runs x 64
///      calls, `ci` 256 x 128 (foundry.toml).
contract OracleInvariantsTest is Test {
    OracleHandler internal h;
    ResolutionOracle internal ro;
    MarketRegistry internal reg;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1_800_000_000);
        h = new OracleHandler();
        h.createMarket(0); // a no-feed market
        h.createMarket(1 << 32 | 1); // a feed market in the exclusive group
        ro = h.ro();
        reg = h.reg();
        targetContract(address(h));
    }

    // ------------------------------------------------------------------ ORC-1 to ORC-15 (plan §5.5)

    /// ORC-1: no MarketRegistry field changes after `createMarket`.
    function invariant_ORC1_registryFieldsImmutable() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            (bytes32 atListing,,,,,,,,) = h.ghost(id);
            assertEq(h.registryHash(id), atListing, "registry views changed");
            _noFlag(id, 1);
        }
    }

    /// ORC-2: the engine is settled at most once per market, and only by `_final`: a market is Final
    /// exactly when its engine was settled once, with the outcome the oracle finalized.
    function invariant_ORC2_settleOnceOnlyInFinal() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            Resolution memory r = ro.getResolution(id);
            MockResolutionEngine e = h.engineOf(id);
            assertLe(e.settleCalls(), 1, "settled more than once");
            assertEq(e.settleCalls() == 1, r.state == RState.Final, "settled iff Final");
            if (r.state == RState.Final) {
                assertEq(uint8(e.getSettlementStatus().finalOutcome), uint8(_engineOutcome(r.outcome)));
            }
        }
    }

    /// ORC-3: Final only through an assertion settled true on the venue, or through Voided (the void
    /// deadline, or YES and NO both rejected), which is always INVALID.
    function invariant_ORC3_finalOnlyByTruthOrVoid() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            Resolution memory r = ro.getResolution(id);
            if (r.state != RState.Final) {
                assertEq(uint8(r.finalReason), uint8(FinalReason.NONE), "a reason before Final");
                continue;
            }
            if (r.finalReason == FinalReason.ASSERTED_TRUE) {
                assertFalse(r.voided);
                assertEq(uint8(r.outcome), uint8(r.proposed), "the asserted outcome");
                bytes32[] memory a = h.assertionsOf(id);
                assertGt(a.length, 0);
                IAssertionVenue.AssertionStatus memory st = h.assertionVenue().statusOf(a[a.length - 1]);
                assertTrue(st.settled && st.truthful, "settled true on the venue");
            } else {
                assertTrue(r.voided, "through Voided");
                assertEq(uint8(r.outcome), uint8(Outcome.INVALID));
                if (r.finalReason == FinalReason.VOID_DEADLINE) {
                    assertGe(block.timestamp, r.voidDeadline);
                } else {
                    assertEq(uint8(r.finalReason), uint8(FinalReason.REJECTED_YES_AND_NO));
                    assertEq(r.rejectedMask & 6, 6, "YES and NO both rejected");
                }
            }
        }
    }

    /// ORC-4: `onReport` changes state only in L1Pending; any later report reverts.
    function invariant_ORC4_reportOnlyInL1Pending() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            _noFlag(h.markets(i), 4);
        }
    }

    /// ORC-5: at most one live assertion per market, and `attempts <= 3`: every assertion the oracle
    /// opened counts one attempt, and the live one is the last opened.
    function invariant_ORC5_oneLiveAssertion() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            Resolution memory r = ro.getResolution(id);
            bytes32[] memory a = h.assertionsOf(id);
            assertLe(r.attempts, 3, "attempts");
            assertEq(a.length, r.attempts, "one attempt per assertion");
            if (r.assertionId != 0) assertEq(r.assertionId, a[a.length - 1], "the live one is the last");
            _noFlag(id, 5);
        }
    }

    /// ORC-6: no outcome is proposed after it was rejected; `rejectedMask` is monotone.
    function invariant_ORC6_noRejectedOutcomeProposed() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            Resolution memory r = ro.getResolution(id);
            if (r.proposed != Outcome.NONE) {
                assertEq(r.rejectedMask & (uint8(1) << uint8(r.proposed)), 0, "proposed a rejected outcome");
            }
            assertEq(r.rejectedMask & ~uint8(14), 0, "only outcome bits (YES, NO, INVALID)"); // NONE never asserted
            _noFlag(id, 6);
        }
    }

    /// ORC-7: in an exclusive group at most one member is Final YES, and at most one member holds the
    /// YES lock: the holder is the only member with a live YES assertion, or the Final YES member.
    function invariant_ORC7_groupHasOneYes() public view {
        bytes32 g = h.GROUP();
        GroupState memory gs = ro.groupState(g);
        uint256 finalYes;
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            if (reg.getMarketCore(id).groupId != g) continue;
            Resolution memory r = ro.getResolution(id);
            if (r.state == RState.Final && r.outcome == Outcome.YES) {
                ++finalYes;
                assertEq(gs.finalYes, id, "finalYes records the member");
                assertEq(gs.yesLockHolder, id, "a Final YES keeps the lock");
            }
            bool liveYes = (r.state == RState.Proposed || r.state == RState.Disputed) && r.proposed == Outcome.YES
                && r.assertionId != 0;
            if (liveYes) assertEq(gs.yesLockHolder, id, "a live YES holds the lock");
            if (gs.yesLockHolder == id) {
                assertTrue(liveYes || (r.state == RState.Final && r.outcome == Outcome.YES), "a stale lock");
            }
        }
        assertLe(finalYes, 1, "two Final YES in one group");
        if (finalYes == 0) assertEq(gs.finalYes, bytes32(0));
    }

    /// ORC-8: calls after Final change nothing.
    function invariant_ORC8_finalIsFrozen() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            Resolution memory r = ro.getResolution(id);
            (,,,, bytes32 finalHash,,,,) = h.ghost(id);
            if (r.state == RState.Final) assertEq(keccak256(abi.encode(r)), finalHash, "changed after Final");
            _noFlag(id, 8);
        }
    }

    /// ORC-9: every halted non-Final market reaches Final at `voidDeadline`, and every unhalted market is
    /// halted at T, through permissionless calls by a stranger. Tried on a snapshot, then undone. The
    /// engine's test knob that makes `settle` revert is switched off first: a reverting engine blocks
    /// every Final by design (S-02), which is not a privileged path.
    function invariant_ORC9_finalWithoutPrivilege() public {
        address stranger = makeAddr("stranger");
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            if (ro.getResolution(id).state == RState.Final) continue;
            uint256 snap = vm.snapshotState();
            h.engineOf(id).setRevertOnSettle(false);
            if (ro.getResolution(id).haltedAt == 0) {
                uint64 tau = reg.getMarketCore(id).tau;
                if (block.timestamp < tau) vm.warp(tau);
                vm.prank(stranger);
                assertTrue(ro.haltScheduled(id), "halted at T");
            }
            uint64 deadline = ro.getResolution(id).voidDeadline;
            if (block.timestamp < deadline) vm.warp(deadline);
            vm.prank(stranger);
            ro.voidMarket(id);
            assertEq(uint8(ro.getResolution(id).state), uint8(RState.Final), "Final at voidDeadline");
            vm.revertToState(snap);
        }
    }

    /// ORC-10: each ledger pays out only through its own path (ASSERTION to the venue in assertProposal,
    /// the float in disputeViaVenue, rewards to a Final permissionless proposer) or the Timelock's
    /// withdraw, which never takes ASSERTION below the listing commitments.
    function invariant_ORC10_ledgerOutflows() public view {
        assertEq(h.globalFlags() & (1 << 10), 0, "a ledger decreased outside its path");
    }

    /// ORC-11: `haltedAt` and `oiHaltLots` equal the engine's halt snapshot.
    function invariant_ORC11_haltMatchesEngine() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            Resolution memory r = ro.getResolution(id);
            HaltView memory hv = h.engineOf(id).getHaltSnapshot();
            if (r.haltedAt == 0) continue;
            assertTrue(hv.halted);
            assertEq(r.haltedAt, hv.economicHaltAt, "haltedAt");
            assertEq(r.oiHaltLots, hv.oiHaltLots, "oiHaltLots");
        }
    }

    /// ORC-12: `voidDeadline` is set once, at the halt, to `max(haltedAt, T) + voidSecs`, and never changes.
    function invariant_ORC12_voidDeadline() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            Resolution memory r = ro.getResolution(id);
            if (r.haltedAt == 0) {
                assertEq(r.voidDeadline, 0, "set before the halt");
            } else {
                MarketCore memory c = reg.getMarketCore(id);
                uint64 base = r.haltedAt > c.tau ? r.haltedAt : c.tau;
                assertEq(r.voidDeadline, base + c.voidSecs, "max(haltedAt, T) + voidSecs");
            }
            _noFlag(id, 12);
        }
    }

    /// ORC-13: `trustSetId` is pinned at the halt and never changes; after `lockProduction`, a market pinned
    /// to a non-production set accepts no report.
    function invariant_ORC13_trustSetPinned() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            bytes32 id = h.markets(i);
            Resolution memory r = ro.getResolution(id);
            assertEq(r.trustSetId != 0, r.haltedAt != 0, "pinned exactly at the halt");
            _noFlag(id, 13);
        }
        if (h.productionLocked()) assertFalse(ro.simMode(), "the lock ends sim mode");
    }

    /// ORC-14: treasury solvency: the token balance covers every ledger.
    function invariant_ORC14_treasurySolvent() public view {
        BondTreasury t = h.treasury();
        uint256 ledgers =
            t.balanceOf(Ledger.ASSERTION) + t.balanceOf(Ledger.WATCHDOG_FLOAT) + t.balanceOf(Ledger.PROPOSER_REWARD);
        assertGe(h.token().balanceOf(address(t)), ledgers, "insolvent");
    }

    /// ORC-15: early proposals are always REVIEWED; L2_AUTO never happens before T.
    function invariant_ORC15_earlyIsReviewed() public view {
        for (uint256 i; i < h.marketsLength(); ++i) {
            _noFlag(h.markets(i), 15);
        }
    }

    /// D20: no admin path moves a market; no restricted entry point ever accepted an outsider.
    function invariant_D20_noUnauthorizedCall() public view {
        assertEq(h.globalFlags() & 1, 0, "an unauthorized call succeeded");
    }

    // ------------------------------------------------------------------ helpers

    /// The handler latched no violation of ORC-`rule` for this market.
    function _noFlag(bytes32 id, uint256 rule) internal view {
        assertEq(h.flagsOf(id) & (1 << rule), 0, string.concat("ORC-", vm.toString(rule), " ghost flag"));
    }

    /// The engine's FinalOutcome for an oracle outcome (the engine orders NO before YES; never a cast).
    function _engineOutcome(Outcome o) internal pure returns (FinalOutcome) {
        if (o == Outcome.YES) return FinalOutcome.YES;
        if (o == Outcome.NO) return FinalOutcome.NO;
        return FinalOutcome.INVALID;
    }

    // ------------------------------------------------------------------ handler reach

    uint256 internal constant DRIVER_RUNS = 64;
    uint256 internal constant DRIVER_DEPTH = 128; // the `ci` profile's depth

    /// Totals over the driver's runs.
    struct Tally {
        uint256[30] calls;
        uint256[30] reverted;
        uint256[30] noops;
        uint256[11] states;
        uint256[4] reasons;
        bytes4[64] errors;
        uint256[30][64] byError;
        uint256 nErrors;
        uint256 rejections;
        uint256 l1Proposals;
        uint256 locks;
        uint256 flags; // ghost flags raised (bit n = ORC-n; bit 0 an unauthorized success), all runs
    }

    /// The handler's reach, measured the way the fuzzer drives it (uniform actions, random inputs) but
    /// deterministically: 64 runs of 128 calls (the `ci` depth) from the setUp state. Logs, per action, the calls, the share
    /// that acted and the share that reverted inside, and the errors behind at least a tenth of an
    /// action's calls. Fails if a state or a final reason stops being reachable, or if reverts dominate.
    function test_handlerReach() public {
        vm.pauseGasMetering(); // a measurement of 8,192 handler calls, not a gas test
        Tally memory t;
        uint256 snap = vm.snapshotState();
        for (uint256 run; run < DRIVER_RUNS; ++run) {
            for (uint256 k; k < DRIVER_DEPTH; ++k) {
                uint256 seed = uint256(keccak256(abi.encode(run, k)));
                _step(seed, seed >> 8, seed >> 128);
            }
            _accumulate(t);
            vm.revertToState(snap);
        }
        _report(t);
    }

    function _accumulate(Tally memory t) internal view {
        for (uint256 i; i < 30; ++i) {
            t.calls[i] += h.calls(i);
            t.reverted[i] += h.reverts(i);
            t.noops[i] += h.noops(i);
        }
        for (uint256 e; e < h.errorsSeenLength(); ++e) {
            bytes4 sel = h.errorsSeen(e);
            uint256 j;
            while (j < t.nErrors && t.errors[j] != sel) ++j;
            if (j == 64) continue;
            if (j == t.nErrors) t.errors[t.nErrors++] = sel;
            for (uint256 i; i < 30; ++i) {
                t.byError[j][i] += h.revertsBy(i, sel);
            }
        }
        for (uint256 i; i < 11; ++i) {
            t.states[i] += h.stateReached(i);
        }
        for (uint256 i; i < 4; ++i) {
            t.reasons[i] += h.finalReasonReached(i);
        }
        t.rejections += h.rejections();
        t.l1Proposals += h.l1Proposals();
        t.locks += h.locks();
        t.flags |= h.globalFlags();
        for (uint256 i; i < h.marketsLength(); ++i) {
            t.flags |= h.flagsOf(h.markets(i));
        }
    }

    function _report(Tally memory t) internal pure {
        string[30] memory names = _names();
        uint256 total;
        uint256 totalReverted;
        for (uint256 i; i < 30; ++i) {
            total += t.calls[i];
            totalReverted += t.reverted[i];
            if (t.calls[i] == 0) continue;
            console.log(
                string.concat(names[i], ": calls, acted %, reverted %"),
                t.calls[i],
                100 * (t.calls[i] - t.reverted[i] - t.noops[i]) / t.calls[i],
                100 * t.reverted[i] / t.calls[i]
            );
        }
        for (uint256 j; j < t.nErrors; ++j) {
            for (uint256 i; i < 30; ++i) {
                uint256 n = t.byError[j][i];
                if (n != 0 && n * 10 >= t.calls[i]) {
                    console.log(
                        string.concat(names[i], " reverts with ", vm.toString(abi.encodePacked(t.errors[j]))), n
                    );
                }
            }
        }
        for (uint256 i; i < 11; ++i) {
            console.log("state entered", i, t.states[i]);
        }
        for (uint256 i = 1; i < 4; ++i) {
            console.log("final reason", i, t.reasons[i]);
        }
        console.log("rejections", t.rejections);
        console.log("Layer 1 proposals", t.l1Proposals);
        console.log("production locks", t.locks);
        console.log("ghost flags raised", t.flags);
        console.log("reverted inner calls %", 100 * totalReverted / total);
        for (uint256 i; i < 11; ++i) {
            if (i != 9) assertGt(t.states[i], 0, "every state is reached"); // 9 Voided is transient
        }
        for (uint256 i = 1; i < 4; ++i) {
            assertGt(t.reasons[i], 0, "every final reason is reached");
        }
        assertGt(t.l1Proposals, 0, "Layer 1 reports are accepted");
        assertGt(t.locks, 0, "production gets locked");
        assertLt(totalReverted * 2, total, "reverts do not dominate");
    }

    /// The handler's sixteen fuzzed selectors, chosen uniformly as the fuzzer does.
    function _step(uint256 action, uint256 a, uint256 b) internal {
        action %= 16;
        if (action == 0) h.createMarket(a);
        else if (action == 1) h.warp(a);
        else if (action == 2) h.keeper(b, a);
        else if (action == 3) h.keeperTick(a);
        else if (action == 4) h.requestEarlyCheck(a);
        else if (action == 5) h.report(a, b);
        else if (action == 6) h.submitPanel(a, b);
        else if (action == 7) h.submitReviewedProposal(a, b);
        else if (action == 8) h.proposePermissionless(a, b);
        else if (action == 9) h.watchdogHeartbeat(a);
        else if (action == 10) h.venueOutcome(a, b);
        else if (action == 11) h.disputeViaVenue(a);
        else if (action == 12) h.closeDispute(a);
        else if (action == 13) h.pokeFinal(a, b);
        else if (action == 14) h.treasuryAction(a);
        else h.admin(b, a, b >> 64);
    }

    function _names() internal pure returns (string[30] memory) {
        return [
            "create",
            "warp",
            "halt",
            "request",
            "escalate",
            "earlyCheck",
            "expireEarly",
            "open",
            "report",
            "panel",
            "committee",
            "permissionless",
            "assert",
            "sync",
            "finalize",
            "void",
            "heartbeat",
            "venue",
            "dispute",
            "closeDispute",
            "treasury",
            "category",
            "globals",
            "registryGov",
            "oracleGov",
            "guardian",
            "engine",
            "intruder",
            "keeperTick",
            "pokeFinal"
        ];
    }
}
