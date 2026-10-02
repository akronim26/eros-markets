// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {Ledger, Resolution, RState, FinalReason} from "../../src/types/OracleTypes.sol";
import {IBondTreasury} from "../../src/interfaces/IBondTreasury.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";
import {MockOracleView} from "../mocks/MockOracleView.sol";

/// @notice Task O12.3: watchdog disputes, closeDispute and skim (plan §6.6, C.5), ORC-10 (the float
///         leaves only through `disputeViaVenue`) and ORC-14 (books never exceed the balance; skim never
///         credits an in-flight bond twice). Amounts are hand-picked USDC atoms.
contract TreasuryDisputesTest is Test {
    bytes32 internal constant M = keccak256("market-1");
    bytes32 internal constant M2 = keccak256("market-2");

    MockUSDC internal usdc;
    MockOracleView internal oracle;
    MockAssertionVenue internal venue;
    BondTreasury internal t;

    address internal gov = makeAddr("timelock");
    address internal watchdog = makeAddr("watchdog");
    address internal proposer = makeAddr("proposer");
    address internal publicDisputer = makeAddr("public disputer");

    function setUp() public {
        usdc = new MockUSDC();
        oracle = new MockOracleView();
        venue = new MockAssertionVenue(address(usdc), 2e6);
        t = new BondTreasury(address(usdc), address(oracle), makeAddr("registry"), gov);
        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(t), type(uint256).max);
        t.deposit(Ledger.ASSERTION, 1_000e6);
        t.deposit(Ledger.WATCHDOG_FLOAT, 100e6);
        vm.prank(gov);
        t.setLimits(100e6, 2);
        oracle.setWatchdog(M, watchdog);
        oracle.setWatchdog(M2, watchdog);
    }

    // ------------------------------------------------------------------ helpers

    /// A permissionless proposer's live assertion on the venue, recorded as the market's live assertion.
    function _proposal(bytes32 market, uint256 bond) internal returns (bytes32 aid) {
        usdc.mint(proposer, bond);
        vm.prank(proposer);
        usdc.approve(address(venue), bond);
        aid = venue.assertOutcome(IAssertionVenue.AssertRequest(market, "claim", proposer, proposer, 7200, bond));
        Resolution memory r;
        r.state = RState.Proposed;
        r.assertionId = aid;
        r.assertionVenue = address(venue);
        r.bond = bond;
        oracle.setResolution(market, r);
    }

    function _dispute(bytes32 market) internal {
        vm.prank(watchdog);
        t.disputeViaVenue(market);
    }

    function _sum() internal view returns (uint256) {
        return t.balanceOf(Ledger.ASSERTION) + t.balanceOf(Ledger.WATCHDOG_FLOAT) + t.balanceOf(Ledger.PROPOSER_REWARD);
    }

    function _setFinal(bytes32 market, FinalReason reason) internal {
        Resolution memory r = oracle.getResolution(market);
        r.state = RState.Final;
        r.finalReason = reason;
        oracle.setResolution(market, r);
    }

    // ------------------------------------------------------------------ interface

    function test_implementsIBondTreasury() public view {
        IBondTreasury i = IBondTreasury(address(t));
        assertEq(i.maxOpenDisputes(), 2);
        assertEq(i.openDisputes(), 0);
    }

    // ------------------------------------------------------------------ disputeViaVenue

    /// disputeViaVenue: debits the float by the venue's bond and records the dispute, never another ledger.
    function test_dispute_records() public {
        uint256 snap = vm.snapshotState();
        {
            // test_dispute_debitsFloatAndRecords
            bytes32 aid = _proposal(M, 5e6);
            vm.expectEmit(address(t));
            emit IBondTreasury.DisputeFunded(M, aid, 5e6);
            _dispute(M);
            assertEq(t.balanceOf(Ledger.WATCHDOG_FLOAT), 95e6);
            assertEq(t.openDisputes(), 1);
            assertEq(t.openDisputeBonds(), 5e6);
            (bytes32 market, address v, uint256 bond) = t.disputes(aid);
            assertEq(market, M);
            assertEq(v, address(venue));
            assertEq(bond, 5e6);
            IAssertionVenue.AssertionStatus memory s = venue.statusOf(aid);
            assertTrue(s.disputed);
            assertEq(s.disputer, address(t), "winnings return to the treasury");
            assertEq(usdc.balanceOf(address(venue)), 10e6, "both bonds at the venue");
            assertEq(usdc.allowance(address(t), address(venue)), 0);
            assertGe(usdc.balanceOf(address(t)), _sum(), "ORC-14");
        }
        vm.revertToState(snap);
        {
            // test_dispute_bondIsTheVenuesFigure
            _proposal(M, 5e6);
            Resolution memory r = oracle.getResolution(M);
            r.bond = 1; // the oracle's record disagrees; the venue pulls its own figure
            oracle.setResolution(M, r);
            _dispute(M);
            assertEq(t.balanceOf(Ledger.WATCHDOG_FLOAT), 95e6);
            assertEq(t.openDisputeBonds(), 5e6);
        }
        vm.revertToState(snap);
        {
            // test_dispute_floatOnlyNeverOtherLedgers
            _proposal(M, 5e6);
            _dispute(M);
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6, "ORC-10: only the float pays disputes");
            assertEq(t.balanceOf(Ledger.PROPOSER_REWARD), 0);
        }
    }

    /// disputeViaVenue refusals: watchdog only, revoked watchdog, no or unknown or settled or disputed or expired assertion, cap, float short.
    function test_dispute_refusals() public {
        uint256 snap = vm.snapshotState();
        {
            // test_dispute_watchdogOnly
            _proposal(M, 5e6);
            address[4] memory callers = [gov, address(oracle), proposer, makeAddr("other watchdog")];
            for (uint256 i; i < callers.length; ++i) {
                vm.prank(callers[i]);
                vm.expectRevert(IBondTreasury.Unauthorized.selector);
                t.disputeViaVenue(M);
            }
        }
        vm.revertToState(snap);
        {
            // test_dispute_revokedWatchdogCannot
            _proposal(M, 5e6);
            oracle.setWatchdog(M, address(0)); // watchdogOf returns 0 once revoked
            vm.prank(watchdog);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.disputeViaVenue(M);
        }
        vm.revertToState(snap);
        {
            // test_dispute_noLiveAssertion
            vm.prank(watchdog);
            vm.expectRevert(IBondTreasury.NoLiveAssertion.selector);
            t.disputeViaVenue(M);
        }
        vm.revertToState(snap);
        {
            // test_dispute_unknownAssertionRefused
            Resolution memory r;
            r.state = RState.Proposed;
            r.assertionId = keccak256("not on the venue");
            r.assertionVenue = address(venue);
            oracle.setResolution(M, r);
            vm.prank(watchdog);
            vm.expectRevert(IBondTreasury.NoLiveAssertion.selector);
            t.disputeViaVenue(M);
        }
        vm.revertToState(snap);
        {
            // test_dispute_settledAssertionRefused
            bytes32 aid = _proposal(M, 5e6);
            venue.settleDirectly(aid, true);
            vm.prank(watchdog);
            vm.expectRevert(IBondTreasury.NoLiveAssertion.selector);
            t.disputeViaVenue(M);
        }
        vm.revertToState(snap);
        {
            // test_dispute_alreadyDisputedRefused
            bytes32 aid = _proposal(M, 5e6);
            venue.markDisputed(aid, publicDisputer);
            vm.prank(watchdog);
            vm.expectRevert(IBondTreasury.NoLiveAssertion.selector);
            t.disputeViaVenue(M);
            assertEq(t.balanceOf(Ledger.WATCHDOG_FLOAT), 100e6, "no float spent");
        }
        vm.revertToState(snap);
        {
            // test_dispute_onlyWhileLivenessRuns
            _proposal(M, 5e6);
            uint256 expiresAt = block.timestamp + 7200;
            vm.warp(expiresAt);
            vm.prank(watchdog);
            vm.expectRevert(IBondTreasury.NoLiveAssertion.selector);
            t.disputeViaVenue(M);
            vm.warp(expiresAt - 1);
            _dispute(M);
        }
        vm.revertToState(snap);
        {
            // test_dispute_cappedByMaxOpenDisputes
            _proposal(M, 5e6);
            _proposal(M2, 5e6);
            bytes32 m3 = keccak256("market-3");
            oracle.setWatchdog(m3, watchdog);
            _proposal(m3, 5e6);
            _dispute(M);
            _dispute(M2);
            vm.prank(watchdog);
            vm.expectRevert(IBondTreasury.TooManyOpenDisputes.selector);
            t.disputeViaVenue(m3);
        }
        vm.revertToState(snap);
        {
            // test_dispute_limitsStartAtZero
            BondTreasury fresh = new BondTreasury(address(usdc), address(oracle), address(1), gov);
            usdc.approve(address(fresh), type(uint256).max);
            fresh.deposit(Ledger.WATCHDOG_FLOAT, 100e6);
            _proposal(M, 5e6);
            vm.prank(watchdog);
            vm.expectRevert(IBondTreasury.TooManyOpenDisputes.selector);
            fresh.disputeViaVenue(M);
        }
        vm.revertToState(snap);
        {
            // test_dispute_floatShort
            _proposal(M, 100e6 + 1);
            vm.prank(watchdog);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IBondTreasury.InsufficientLedger.selector, Ledger.WATCHDOG_FLOAT, 100e6 + 1, 100e6
                )
            );
            t.disputeViaVenue(M);
        }
    }

    // ------------------------------------------------------------------ closeDispute

    /// closeDispute: only recorded disputes, once settled on the venue or written off at a VOID_DEADLINE Final.
    function test_close() public {
        uint256 snap = vm.snapshotState();
        {
            // test_close_unrecordedReturnsFalse
            bytes32 aid = _proposal(M, 5e6); // live, but never disputed by the treasury
            venue.settleDirectly(aid, true);
            assertFalse(t.closeDispute(aid));
            assertFalse(t.closeDispute(keccak256("unknown")));
        }
        vm.revertToState(snap);
        {
            // test_close_waitsForTheVenue
            bytes32 aid = _proposal(M, 5e6);
            _dispute(M);
            assertFalse(t.closeDispute(aid), "unsettled and the market is not Final");
            _setFinal(M, FinalReason.ASSERTED_TRUE);
            assertFalse(t.closeDispute(aid), "only VOID_DEADLINE writes an unsettled dispute off");
            assertEq(t.openDisputes(), 1);
        }
        vm.revertToState(snap);
        {
            // test_close_onceSettledOnTheVenue
            bytes32 aid = _proposal(M, 5e6);
            _dispute(M);
            venue.setResult(aid, false);
            venue.trySettle(aid);
            vm.expectEmit(address(t));
            emit IBondTreasury.DisputeClosed(aid);
            assertTrue(t.closeDispute(aid));
            assertEq(t.openDisputes(), 0);
            assertEq(t.openDisputeBonds(), 0);
            (, address v,) = t.disputes(aid);
            assertEq(v, address(0), "record deleted");
            assertFalse(t.closeDispute(aid), "a second call returns false");
            assertEq(t.openDisputes(), 0);
        }
        vm.revertToState(snap);
        {
            // test_close_writeOffNeedsTheMarketFinal
            bytes32 aid = _proposal(M, 5e6);
            _dispute(M);
            Resolution memory r = oracle.getResolution(M);
            r.finalReason = FinalReason.VOID_DEADLINE; // a reason without the Final state is not enough
            oracle.setResolution(M, r);
            assertFalse(t.closeDispute(aid));
        }
        vm.revertToState(snap);
        {
            // test_close_afterVoidDeadlineWriteOff
            bytes32 aid = _proposal(M, 5e6);
            _dispute(M);
            _setFinal(M, FinalReason.VOID_DEADLINE); // the vote never answered
            assertTrue(t.closeDispute(aid));
            assertEq(t.openDisputes(), 0);
            assertEq(t.openDisputeBonds(), 0);
            _proposal(M2, 5e6);
            _dispute(M2); // the freed slot is usable
        }
    }

    // ------------------------------------------------------------------ skim

    /// skim: 0 when nothing is unaccounted, donations and winnings to the float, never an in-flight bond.
    function test_skim() public {
        uint256 snap = vm.snapshotState();
        {
            // test_skim_nothingToCredit
            vm.recordLogs();
            assertEq(t.skim(), 0);
            assertEq(vm.getRecordedLogs().length, 0);
        }
        vm.revertToState(snap);
        {
            // test_skim_creditsDonationsToTheFloat
            t.deposit(Ledger.PROPOSER_REWARD, 10e6); // every ledger is held back, the reward ledger included
            usdc.mint(address(t), 3e6);
            vm.expectEmit(address(t));
            emit IBondTreasury.Skimmed(3e6);
            assertEq(t.skim(), 3e6);
            assertEq(t.balanceOf(Ledger.WATCHDOG_FLOAT), 103e6);
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6);
            assertEq(t.skim(), 0, "credited once");
            assertEq(usdc.balanceOf(address(t)), _sum());
        }
        vm.revertToState(snap);
        {
            // test_skim_neverCreditsAnInFlightBondReturn (A team bond returned by the venue before the oracle books it is never credited by skim.)
            address oracleAddr = address(oracle);
            vm.prank(oracleAddr);
            t.fundAssertion(M, 0, address(venue), 5e6);
            bytes32 aid =
                venue.assertOutcome(IAssertionVenue.AssertRequest(M, "claim", address(t), address(t), 7200, 5e6));
            assertEq(t.skim(), 0, "returns 0 while a bond is out");
            venue.setResult(aid, true);
            venue.trySettle(aid); // 5e6 back in the treasury's balance, not yet booked
            assertEq(t.skim(), 0, "the in-flight return is not surplus");
            vm.prank(oracleAddr);
            t.onBondReturned(M, 0);
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6, "booked once, by the oracle");
            assertEq(t.skim(), 0);
            assertEq(usdc.balanceOf(address(t)), _sum());
        }
        vm.revertToState(snap);
        {
            // test_skim_winningsAfterClose (Winnings of a won dispute (2B minus the burn) are credited once the dispute is closed.)
            bytes32 aid = _proposal(M, 5e6);
            _dispute(M);
            venue.setResult(aid, false);
            venue.trySettle(aid);
            usdc.mint(address(t), 7_500_000); // OOv3 pays the disputer 2B - 50% burn = 7.5 USDC
            assertEq(t.skim(), 2_500_000, "while open, the dispute bond is still held back");
            assertTrue(t.closeDispute(aid));
            assertEq(t.skim(), 5_000_000, "the rest once the dispute is closed");
            assertEq(t.balanceOf(Ledger.WATCHDOG_FLOAT), 95e6 + 7_500_000);
            assertEq(usdc.balanceOf(address(t)), _sum());
        }
    }

    /// Whatever arrives or leaves, skim never reverts and never credits more than the true surplus.
    function testFuzz_skimNeverOverCredits(uint64 donation, uint64 bond, bool dispute, bool fundTeamBond) public {
        uint256 b = bound(bond, 1, 50e6);
        if (fundTeamBond) {
            vm.prank(address(oracle));
            t.fundAssertion(M2, 0, address(venue), b);
            venue.assertOutcome(IAssertionVenue.AssertRequest(M2, "c", address(t), address(t), 7200, b));
        }
        if (dispute) {
            _proposal(M, b);
            _dispute(M);
        }
        usdc.mint(address(t), donation);
        uint256 credited = t.skim();
        // Each bond out (a team bond, or an open dispute) left the balance and is held back once.
        uint256 out = (dispute ? b : 0) + (fundTeamBond ? b : 0);
        assertEq(credited, donation > out ? donation - out : 0);
        assertGe(usdc.balanceOf(address(t)), _sum(), "ORC-14");
    }
}
