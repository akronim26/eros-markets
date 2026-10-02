// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FinalOutcome} from "@eros/interfaces/IResolutionIngress.sol";
import {
    FinalizeStatus,
    FinalReason,
    Globals,
    Ledger,
    Outcome,
    Path,
    Resolution,
    RState
} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {IBondTreasury} from "../../src/interfaces/IBondTreasury.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O14.4: assertions, finalize, reject and void (plan §5.4, §6.4, §6.5; §11.1 "Assertion
///         lifecycle", "Void", "Treasury bookkeeping per final reason", "Liveness fallback").
/// @dev Fixture clocks: halt at T, voidDeadline T + 7,200 s, liveness L1/auto 120 s and reviewed 300 s,
///      retry window 300 s, heartbeat max age 900 s. Bond 11,120,000 atoms; the ASSERTION ledger starts at
///      1,000e6 and the per-market cap is 100e6.
contract OracleAssertionsTest is OracleFixture {
    uint256 internal constant LEDGER = 1_000e6;
    address internal proposer = makeAddr("proposer");

    // ------------------------------------------------------------------ helpers

    /// A no-feed market with a committee proposal of `o` posted with a treasury bond at T.
    function _live(Outcome o) internal returns (bytes32 id, MockResolutionEngine e, bytes32 aid) {
        (id, e) = _listNoFeed();
        _toReview(id);
        _propose(id, uint8(o));
        require(ro.assertProposal(id), "not asserted");
        aid = _res(id).assertionId;
    }

    /// Proposes `o` again from Review (after a rejection) and asserts it once the retry window allows it.
    function _retry(bytes32 id, Outcome o) internal returns (bytes32 aid) {
        _propose(id, uint8(o));
        require(ro.assertProposal(id), "not asserted");
        aid = _res(id).assertionId;
    }

    function _rejectLive(bytes32 id, bytes32 aid) internal {
        mvenue.setResult(aid, false);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.REJECTED));
    }

    function _ledger() internal view returns (uint256) {
        return treasury.balanceOf(Ledger.ASSERTION);
    }

    /// A feed market whose L1 proposal (YES) is recorded, as `onReport` (O15) would leave it.
    function _l1Proposed() internal returns (bytes32 id) {
        (id,) = _listFeed();
        _halt(id);
        Resolution memory r = _res(id);
        r.state = RState.Proposed;
        r.proposed = Outcome.YES;
        r.path = Path.L1;
        r.evidenceHash = keccak256("report");
        r.valueHash = keccak256("3");
        ro.setResolution(id, r);
    }

    // ------------------------------------------------------------------ assertProposal

    function test_assert_teamBond() public {
        (bytes32 id,) = _listNoFeed();
        _toReview(id);
        _propose(id, uint8(Outcome.YES));
        vm.expectEmit(true, false, false, false, address(ro));
        emit IResolutionOracle.Asserted(id, 0, address(0), Outcome.NONE, Path.NONE, 0, 0, 0, address(0));
        vm.prank(keeper);
        assertTrue(ro.assertProposal(id));
        Resolution memory r = _res(id);
        assertEq(uint8(r.state), uint8(RState.Proposed));
        assertEq(r.attempts, 1);
        assertEq(r.bond, BOND);
        assertEq(r.assertionVenue, address(mvenue));
        assertEq(mvenue.statusOf(r.assertionId).asserter, address(treasury), "the treasury is the asserter");
        assertEq(mvenue.statusOf(r.assertionId).expiresAt, T + 300, "reviewed liveness");
        assertEq(treasury.outstanding(id, 0), BOND, "attempt key 0 (ADJ-27)");
        assertEq(_ledger(), LEDGER - BOND);
        assertEq(token.balanceOf(address(mvenue)), BOND, "the venue pulled the bond from the treasury");
        assertEq(ro.renderClaim(id), mvenue.claimOf(r.assertionId), "renderClaim is the asserted claim");
    }

    function test_assert_noOpReturns() public {
        (bytes32 id,) = _listNoFeed();
        _toReview(id);
        assertFalse(ro.assertProposal(id), "Review: nothing recorded");
        _propose(id, uint8(Outcome.YES));
        assertTrue(ro.assertProposal(id));
        assertFalse(ro.assertProposal(id), "already live");
        assertEq(_res(id).attempts, 1);
        vm.expectRevert(IResolutionOracle.UnknownMarket.selector);
        ro.assertProposal(keccak256("nope"));
    }

    function test_assert_guards() public {
        (bytes32 id,) = _listNoFeed();
        _toReview(id);
        _propose(id, uint8(Outcome.YES));
        Resolution memory r = _res(id);
        r.attempts = 3;
        ro.setResolution(id, r);
        vm.expectRevert(IResolutionOracle.MaxAttempts.selector);
        ro.assertProposal(id);
        r.attempts = 2;
        r.rejectedMask = 2; // YES rejected (a state the entry points never produce)
        ro.setResolution(id, r);
        vm.expectRevert(IResolutionOracle.OutcomeNotAllowed.selector);
        ro.assertProposal(id);
    }

    function test_assert_expiryGuard() public {
        (bytes32 id,) = _listNoFeed();
        _toReview(id);
        vm.warp(T + 7_200 - 300 + 1);
        _propose(id, uint8(Outcome.YES));
        vm.expectRevert(IResolutionOracle.ExpiryAfterVoidDeadline.selector);
        ro.assertProposal(id);
        vm.warp(T + 7_200 - 300); // finishes exactly at voidDeadline
        assertTrue(ro.assertProposal(id));
    }

    function test_assert_treasuryShort() public {
        (bytes32 id,) = _listNoFeed();
        _toReview(id);
        _propose(id, uint8(Outcome.YES));
        mvenue.setMinimumBond(LEDGER + 1);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.TreasuryShort.selector, LEDGER + 1, LEDGER));
        ro.assertProposal(id);
        mvenue.setMinimumBond(100e6 + 1); // funded, but above the per-market cap
        vm.expectRevert(IBondTreasury.PerMarketCapExceeded.selector);
        ro.assertProposal(id);
        mvenue.setMinimumBond(100e6);
        assertTrue(ro.assertProposal(id));
        assertEq(_res(id).bond, 100e6);
    }

    function test_assert_ledgerExactlyTheBond() public {
        (bytes32 id,) = _listNoFeed();
        _toReview(id);
        _propose(id, uint8(Outcome.YES));
        vm.prank(gov);
        treasury.withdraw(Ledger.ASSERTION, gov, LEDGER - BOND); // down to the listing commitment
        assertEq(_ledger(), BOND);
        assertTrue(ro.assertProposal(id));
        assertEq(_ledger(), 0);
    }

    // ------------------------------------------------------------------ finalize: true

    function test_finalize_trueYes() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.YES);
        assertEq(treasury.committedListing(id), BOND);
        mvenue.setResult(aid, true);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.Finalized(id, Outcome.YES, FinalReason.ASSERTED_TRUE);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.FINAL));
        Resolution memory r = _res(id);
        assertEq(uint8(r.state), uint8(RState.Final));
        assertEq(uint8(r.outcome), uint8(Outcome.YES));
        assertEq(uint8(r.finalReason), uint8(FinalReason.ASSERTED_TRUE));
        assertFalse(r.voided);
        assertEq(e.settleCalls(), 1);
        assertEq(uint8(e.getSettlementStatus().finalOutcome), uint8(FinalOutcome.YES), "settle(1)");
        assertEq(_ledger(), LEDGER, "onBondReturned credits the returned bond");
        assertEq(treasury.outstanding(id, 0), 0);
        assertEq(token.balanceOf(address(treasury)), LEDGER + 100e6, "ASSERTION + WATCHDOG_FLOAT");
        assertEq(treasury.committedListing(id), 0, "releaseListing");
        assertEq(treasury.totalCommitted(), 0);
    }

    function test_finalize_trueNoAndInvalid() public {
        (bytes32 id2, MockResolutionEngine e2) = _listFeed(); // listed before T
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.NO);
        mvenue.setResult(aid, true);
        ro.finalizeMarket(id);
        assertEq(uint8(e.getSettlementStatus().finalOutcome), uint8(FinalOutcome.NO), "settle(0)");
        assertEq(e.settleCalls(), 1);

        _toReview(id2);
        _propose(id2, uint8(Outcome.INVALID));
        ro.assertProposal(id2);
        mvenue.setResult(_res(id2).assertionId, true);
        ro.finalizeMarket(id2);
        assertEq(uint8(_res(id2).outcome), uint8(Outcome.INVALID));
        assertEq(uint8(e2.getSettlementStatus().finalOutcome), uint8(FinalOutcome.INVALID), "settleInvalid()");
        assertEq(e2.settleCalls(), 1);
    }

    function test_finalize_notReady() public {
        (bytes32 nf,) = _listFeed(); // listed before T
        (bytes32 id, MockResolutionEngine e,) = _live(Outcome.YES);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.NOT_READY), "venue cannot settle yet");
        assertEq(uint8(_state(id)), uint8(RState.Proposed));
        assertEq(e.settleCalls(), 0);
        _toReview(nf);
        assertEq(uint8(ro.finalizeMarket(nf)), uint8(FinalizeStatus.NOT_READY), "no live assertion");
        _propose(nf, uint8(Outcome.YES));
        assertEq(uint8(ro.finalizeMarket(nf)), uint8(FinalizeStatus.NOT_READY), "recorded, not asserted");
    }

    function test_finalize_settledDirectlyOnTheVenue() public {
        (bytes32 id,, bytes32 aid) = _live(Outcome.YES);
        mvenue.settleDirectly(aid, true); // trySettle then finds nothing to do
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.FINAL));
        assertEq(uint8(_state(id)), uint8(RState.Final));
    }

    function test_finalize_engineRevertRollsBack() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.YES);
        mvenue.setResult(aid, true);
        e.setRevertOnSettle(true);
        vm.expectRevert(MockResolutionEngine.MockSettleReverted.selector);
        ro.finalizeMarket(id);
        assertEq(uint8(_state(id)), uint8(RState.Proposed));
        assertEq(treasury.outstanding(id, 0), BOND, "no treasury booking either");
        assertEq(treasury.committedListing(id), BOND);
        e.setRevertOnSettle(false);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.FINAL), "the keeper retries");
    }

    // ------------------------------------------------------------------ disputes

    function test_sync_disputed() public {
        (bytes32 nf,) = _listFeed(); // listed before T
        (bytes32 id,, bytes32 aid) = _live(Outcome.YES);
        assertFalse(ro.syncAssertion(id), "not disputed");
        mvenue.markDisputed(aid, address(0xD1));
        vm.expectEmit(address(ro));
        emit IResolutionOracle.StateChanged(id, RState.Proposed, RState.Disputed);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.Disputed(id, aid);
        assertTrue(ro.syncAssertion(id));
        assertEq(uint8(_state(id)), uint8(RState.Disputed));
        assertFalse(ro.syncAssertion(id), "already Disputed");
        _toReview(nf);
        _propose(nf, uint8(Outcome.YES));
        assertFalse(ro.syncAssertion(nf), "no live assertion");
    }

    function test_finalize_disputedThenTrue() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.NO);
        mvenue.markDisputed(aid, address(0xD1));
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.DISPUTED));
        assertEq(uint8(_state(id)), uint8(RState.Disputed));
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.DISPUTED), "DVM still voting");
        mvenue.setResult(aid, true);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.FINAL));
        assertEq(uint8(_res(id).outcome), uint8(Outcome.NO));
        assertEq(e.settleCalls(), 1);
    }

    // ------------------------------------------------------------------ rejections

    function test_reject_toReview() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.YES);
        mvenue.markDisputed(aid, address(0xD1));
        ro.syncAssertion(id);
        mvenue.setResult(aid, false);
        vm.warp(T + 400);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.AssertionRejected(id, aid, Outcome.YES, 2, T + 400 + 300);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.StateChanged(id, RState.Disputed, RState.Review);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.REJECTED));
        Resolution memory r = _res(id);
        assertEq(uint8(r.state), uint8(RState.Review));
        assertEq(r.rejectedMask, 2);
        assertEq(r.retryOpensAt, T + 700, "now + retry window");
        assertEq(uint8(r.proposed), uint8(Outcome.NONE));
        assertEq(r.assertionId, 0);
        assertEq(r.attempts, 1);
        assertEq(treasury.outstanding(id, 0), 0, "onBondLost clears the record");
        assertEq(_ledger(), LEDGER - BOND, "no credit for a lost bond");
        assertEq(e.settleCalls(), 0);
        assertEq(treasury.committedListing(id), BOND, "still listed");
        assertFalse(ro.openAfterDeadline(id), "committee-only until retryOpensAt");
        vm.warp(T + 700);
        assertTrue(ro.openAfterDeadline(id));
    }

    function test_reject_yesAndNo_voids() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.YES);
        _rejectLive(id, aid);
        bytes32 aid2 = _retry(id, Outcome.NO);
        assertEq(treasury.outstanding(id, 1), BOND, "attempt key 1");
        mvenue.setResult(aid2, false);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.AssertionRejected(id, aid2, Outcome.NO, 6, 0);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.Voided(id, FinalReason.REJECTED_YES_AND_NO);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.Finalized(id, Outcome.INVALID, FinalReason.REJECTED_YES_AND_NO);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.REJECTED));
        Resolution memory r = _res(id);
        assertEq(uint8(r.state), uint8(RState.Final));
        assertEq(uint8(r.outcome), uint8(Outcome.INVALID));
        assertEq(uint8(r.finalReason), uint8(FinalReason.REJECTED_YES_AND_NO));
        assertTrue(r.voided);
        assertEq(r.rejectedMask, 6);
        assertEq(e.settleCalls(), 1);
        assertEq(uint8(e.getSettlementStatus().finalOutcome), uint8(FinalOutcome.INVALID));
        assertEq(_ledger(), LEDGER - 2 * BOND, "each lost bond booked once, no second booking at Final");
        assertEq(treasury.totalOutstanding(), 0);
        assertEq(treasury.committedListing(id), 0, "releaseListing");
    }

    function test_reject_noOnly_staysInReview() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.NO);
        _rejectLive(id, aid);
        assertEq(uint8(_state(id)), uint8(RState.Review), "YES and INVALID remain");
        assertEq(_res(id).rejectedMask, 4);
        assertEq(e.settleCalls(), 0);
    }

    function test_reject_invalidThenYes_staysInReview_thenThirdVoids() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.INVALID);
        _rejectLive(id, aid);
        _rejectLive(id, _retry(id, Outcome.YES));
        Resolution memory r = _res(id);
        assertEq(uint8(r.state), uint8(RState.Review), "NO remains");
        assertEq(r.rejectedMask, 10);
        assertEq(e.settleCalls(), 0);
        _rejectLive(id, _retry(id, Outcome.NO));
        r = _res(id);
        assertEq(r.attempts, 3);
        assertEq(uint8(r.state), uint8(RState.Final), "three rejections");
        assertEq(uint8(r.outcome), uint8(Outcome.INVALID));
        assertEq(uint8(r.finalReason), uint8(FinalReason.REJECTED_YES_AND_NO));
        assertEq(e.settleCalls(), 1);
        assertEq(_ledger(), LEDGER - 3 * BOND);
    }

    // ------------------------------------------------------------------ permissionless booking

    function _permissionlessLive(uint256 reward) internal returns (bytes32 id, bytes32 aid) {
        Globals memory g = _globals();
        g.proposerRewardAtoms = reward;
        vm.prank(gov);
        reg.setGlobals(g);
        (id,) = _listNoFeed();
        _toOpen(id);
        token.mint(proposer, BOND);
        vm.startPrank(proposer);
        token.approve(address(mvenue), BOND);
        aid = ro.proposePermissionless(id, Outcome.YES, URI, keccak256("snapshot"));
        vm.stopPrank();
    }

    function test_permissionless_finalPaysTheReward() public {
        treasury.deposit(Ledger.PROPOSER_REWARD, 10e6);
        (bytes32 id, bytes32 aid) = _permissionlessLive(5e6);
        mvenue.setResult(aid, true);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.FINAL));
        assertEq(token.balanceOf(proposer), BOND + 5e6, "own bond back from the venue, reward from the treasury");
        assertEq(treasury.balanceOf(Ledger.PROPOSER_REWARD), 5e6);
        assertEq(_ledger(), LEDGER, "the team ledger is untouched");
        assertEq(treasury.committedListing(id), 0);
    }

    function test_permissionless_rewardIouNeverBlocksFinal() public {
        (bytes32 id, bytes32 aid) = _permissionlessLive(5e6); // PROPOSER_REWARD is empty
        mvenue.setResult(aid, true);
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.FINAL));
        assertEq(treasury.owed(proposer), 5e6);
        assertEq(token.balanceOf(proposer), BOND);
    }

    function test_permissionless_rejectBooksNothing() public {
        (bytes32 id, bytes32 aid) = _permissionlessLive(5e6);
        vm.expectCall(address(treasury), abi.encodeWithSelector(IBondTreasury.onBondLost.selector), 0);
        _rejectLive(id, aid);
        Resolution memory r = _res(id);
        assertEq(uint8(r.state), uint8(RState.Review));
        assertEq(r.proposer, address(0), "proposer cleared");
        assertEq(r.rewardAtoms, 0);
        assertEq(_ledger(), LEDGER);
        assertEq(treasury.totalOutstanding(), 0);
    }

    // ------------------------------------------------------------------ void

    function test_void_onlyFromTheDeadline() public {
        (bytes32 pre,) = _listFeed();
        (bytes32 id, MockResolutionEngine e) = _listNoFeed();
        vm.warp(T + 100_000);
        assertFalse(ro.voidMarket(pre), "never halted: no voidDeadline");
        _halt(id);
        vm.warp(T + 7_200 - 1);
        assertFalse(ro.voidMarket(id));
        vm.warp(T + 7_200);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.StateChanged(id, RState.L2Pending, RState.Voided);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.Voided(id, FinalReason.VOID_DEADLINE);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.StateChanged(id, RState.Voided, RState.Final);
        assertTrue(ro.voidMarket(id));
        Resolution memory r = _res(id);
        assertEq(uint8(r.state), uint8(RState.Final));
        assertEq(uint8(r.outcome), uint8(Outcome.INVALID));
        assertEq(uint8(r.finalReason), uint8(FinalReason.VOID_DEADLINE));
        assertTrue(r.voided);
        assertEq(e.settleCalls(), 1);
        assertEq(uint8(e.getSettlementStatus().finalOutcome), uint8(FinalOutcome.INVALID));
        assertEq(treasury.committedListing(id), 0);
        assertFalse(ro.voidMarket(id), "Final");
        assertEq(e.settleCalls(), 1);
    }

    function test_void_neverAnsweredDispute_marksStuck() public {
        (bytes32 id,, bytes32 aid) = _live(Outcome.YES);
        vm.prank(watchdog);
        treasury.disputeViaVenue(id);
        assertFalse(treasury.closeDispute(aid), "dispute open");
        vm.warp(T + 7_200);
        assertTrue(ro.voidMarket(id));
        Resolution memory r = _res(id);
        assertEq(uint8(r.finalReason), uint8(FinalReason.VOID_DEADLINE));
        assertEq(treasury.outstanding(id, 0), 0, "markStuck");
        assertEq(treasury.totalOutstanding(), 0);
        assertEq(_ledger(), LEDGER - BOND, "written off, no credit");
        assertTrue(treasury.closeDispute(aid), "the treasury can close the written-off dispute");
    }

    function test_void_appliesASettleableTrueAssertion() public {
        (bytes32 id,, bytes32 aid) = _live(Outcome.YES);
        mvenue.setResult(aid, true);
        vm.warp(T + 7_200);
        assertTrue(ro.voidMarket(id));
        Resolution memory r = _res(id);
        assertEq(uint8(r.outcome), uint8(Outcome.YES));
        assertEq(uint8(r.finalReason), uint8(FinalReason.ASSERTED_TRUE));
        assertFalse(r.voided);
        assertEq(_ledger(), LEDGER, "bond returned, not stuck");
    }

    function test_void_lateRejectionIsBookedThenVoided() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.YES);
        mvenue.setResult(aid, false);
        vm.warp(T + 7_200);
        vm.expectCall(address(treasury), abi.encodeWithSelector(IBondTreasury.markStuck.selector), 0);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.AssertionRejected(id, aid, Outcome.YES, 2, T + 7_200 + 300);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.Voided(id, FinalReason.VOID_DEADLINE);
        assertTrue(ro.voidMarket(id));
        Resolution memory r = _res(id);
        assertEq(r.rejectedMask, 2, "the rejection is recorded");
        assertEq(uint8(r.state), uint8(RState.Final));
        assertEq(uint8(r.finalReason), uint8(FinalReason.VOID_DEADLINE));
        assertEq(_ledger(), LEDGER - BOND, "booked as lost (onBondLost), not stuck");
        assertEq(e.settleCalls(), 1);
    }

    function test_void_livePermissionlessBooksNothing() public {
        (bytes32 id, bytes32 aid) = _permissionlessLive(0);
        mvenue.markDisputed(aid, address(0xD1));
        vm.warp(T + 7_200);
        vm.expectCall(address(treasury), abi.encodeWithSelector(IBondTreasury.markStuck.selector), 0);
        assertTrue(ro.voidMarket(id));
        assertEq(uint8(_res(id).finalReason), uint8(FinalReason.VOID_DEADLINE));
        assertEq(_ledger(), LEDGER);
        assertEq(treasury.totalOutstanding(), 0);
    }

    function test_afterFinal_nothingChanges() public {
        (bytes32 id, MockResolutionEngine e, bytes32 aid) = _live(Outcome.YES);
        mvenue.setResult(aid, true);
        ro.finalizeMarket(id);
        Resolution memory before = _res(id);
        mvenue.markDisputed(aid, address(0xD1));
        assertFalse(ro.assertProposal(id));
        assertFalse(ro.syncAssertion(id));
        assertEq(uint8(ro.finalizeMarket(id)), uint8(FinalizeStatus.NOT_READY));
        vm.warp(T + 7_200);
        assertFalse(ro.voidMarket(id));
        assertFalse(ro.haltScheduled(id));
        assertFalse(ro.openAfterDeadline(id));
        assertEq(keccak256(abi.encode(_res(id))), keccak256(abi.encode(before)));
        assertEq(e.settleCalls(), 1);
    }

    // ------------------------------------------------------------------ liveness fallback and views

    function test_liveness_watchdogFallback() public {
        bytes32 id = _l1Proposed();
        assertEq(ro.livenessFor(id), 300, "never beat: stale");
        vm.prank(watchdog);
        ro.watchdogHeartbeat();
        assertEq(ro.livenessFor(id), 120, "fresh: L1 liveness");
        vm.warp(block.timestamp + 900);
        assertEq(ro.livenessFor(id), 120, "exactly the max age is fresh");
        vm.warp(block.timestamp + 1);
        assertEq(ro.livenessFor(id), 300, "stale: reviewed liveness");
        vm.prank(watchdog);
        ro.watchdogHeartbeat();
        assertTrue(ro.assertProposal(id));
        assertEq(mvenue.statusOf(_res(id).assertionId).expiresAt, block.timestamp + 120);
    }

    function test_liveness_revokedWatchdogFallsBack() public {
        bytes32 id = _l1Proposed();
        vm.prank(watchdog);
        ro.watchdogHeartbeat();
        vm.prank(guardian);
        ro.revokeWatchdog(1);
        assertEq(ro.livenessFor(id), 300);
        assertTrue(ro.assertProposal(id));
        assertEq(mvenue.statusOf(_res(id).assertionId).expiresAt, block.timestamp + 300);
    }

    function test_views() public {
        assertEq(ro.bondFor(keccak256("nope")), 0);
        assertEq(ro.livenessFor(keccak256("nope")), 0);
        assertEq(ro.renderClaim(keccak256("nope")).length, 0);
        (bytes32 id,) = _listNoFeed();
        assertEq(ro.bondFor(id), 0, "nothing pinned before the halt");
        assertEq(ro.livenessFor(id), 300, "no proposal: the reviewed liveness");
        _toReview(id);
        assertEq(ro.bondFor(id), BOND);
        mvenue.setMinimumBond(20e6);
        assertEq(ro.bondFor(id), 20e6, "venue minimum");
        assertEq(ro.renderClaim(id).length, 0, "no proposal");
        _propose(id, uint8(Outcome.YES));
        assertGt(ro.renderClaim(id).length, 0);
    }
}
