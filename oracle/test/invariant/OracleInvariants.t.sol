// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {OracleHandler} from "./OracleHandler.sol";

/// @notice Oracle invariants (plan §5.5, §11.1). Task O17.1: the stateful handler and a smoke invariant;
///         the fifteen ORC invariants are task O17.2.
/// @dev The handler deploys and wires the real ResolutionOracle, MarketRegistry and BondTreasury (with the
///      sim set 1 active and the production set 2 created) and is the only fuzz target. Two markets are
///      listed before the run so the first calls have something to act on. Profiles: default 64 runs x 64
///      calls, `ci` 256 x 128 (foundry.toml).
contract OracleInvariantsTest is Test {
    OracleHandler internal h;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1_800_000_000);
        h = new OracleHandler();
        h.createMarket(0); // a no-feed market
        h.createMarket(1 << 32 | 1); // a feed market in the exclusive group
        targetContract(address(h));
    }

    /// Smoke: the handler runs without reverting and the system stays callable.
    function invariant_smoke() public pure {
        assertTrue(true);
    }

    // ------------------------------------------------------------------ handler reach

    uint256 internal constant DRIVER_RUNS = 32;
    uint256 internal constant DRIVER_DEPTH = 128; // the `ci` profile's depth

    /// Totals over the driver's runs.
    struct Tally {
        uint256[29] calls;
        uint256[29] reverted;
        uint256[29] noops;
        uint256[11] states;
        uint256[4] reasons;
        bytes4[64] errors;
        uint256[29][64] byError;
        uint256 nErrors;
        uint256 rejections;
        uint256 l1Proposals;
        uint256 locks;
        uint256 flags; // ghost flags raised (bit n = ORC-n; bit 0 an unauthorized success), all runs
    }

    /// The handler's reach, measured the way the fuzzer drives it (uniform actions, random inputs) but
    /// deterministically: 32 runs of 128 calls (the `ci` depth) from the setUp state. Logs, per action, the calls, the share
    /// that acted and the share that reverted inside, and the errors behind at least a tenth of an
    /// action's calls. Fails if a state or a final reason stops being reachable, or if reverts dominate.
    function test_handlerReach() public {
        vm.pauseGasMetering(); // a measurement of 4,096 handler calls, not a gas test
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
        for (uint256 i; i < 29; ++i) {
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
            for (uint256 i; i < 29; ++i) {
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
        string[29] memory names = _names();
        uint256 total;
        uint256 totalReverted;
        for (uint256 i; i < 29; ++i) {
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
            for (uint256 i; i < 29; ++i) {
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

    /// The handler's fourteen fuzzed selectors, chosen uniformly as the fuzzer does.
    function _step(uint256 action, uint256 a, uint256 b) internal {
        action %= 14;
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
        else h.admin(b, a, b >> 64);
    }

    function _names() internal pure returns (string[29] memory) {
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
            "keeperTick"
        ];
    }
}
