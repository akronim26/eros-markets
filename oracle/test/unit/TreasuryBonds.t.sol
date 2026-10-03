// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {Ledger} from "../../src/types/OracleTypes.sol";
import {IBondTreasury} from "../../src/interfaces/IBondTreasury.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";

/// @notice Task O12.2: bond flows and proposer rewards (plan §5.4 `_final`/`_reject`, §6.6, C.5, ADJ-27).
///         Bonds move through `MockAssertionVenue` with real token transfers, so the treasury's books are
///         checked against its actual USDC balance (ORC-14). Amounts are hand-picked USDC atoms.
contract TreasuryBondsTest is Test {
    bytes32 internal constant M = keccak256("market-1");

    MockUSDC internal usdc;
    BondTreasury internal t;
    MockAssertionVenue internal venue;

    address internal oracle = makeAddr("oracle");
    address internal gov = makeAddr("timelock");
    address internal proposer = makeAddr("proposer");
    address internal disputer = makeAddr("disputer");

    function setUp() public {
        usdc = new MockUSDC();
        t = new BondTreasury(address(usdc), oracle, makeAddr("registry"), gov);
        venue = new MockAssertionVenue(address(usdc), 2e6);
        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(t), type(uint256).max);
        t.deposit(Ledger.ASSERTION, 1_000e6);
        t.deposit(Ledger.PROPOSER_REWARD, 10e6);
        vm.prank(gov);
        t.setLimits(100e6, 20);
    }

    // ------------------------------------------------------------------ helpers

    /// The oracle's assertProposal: fund, then the venue pulls the bond with the treasury as asserter.
    function _assert(uint8 attempt, uint256 bond) internal returns (bytes32 assertionId) {
        vm.prank(oracle);
        t.fundAssertion(M, attempt, address(venue), bond);
        assertionId = venue.assertOutcome(IAssertionVenue.AssertRequest(M, "claim", address(t), address(t), 7200, bond));
    }

    function _sum() internal view returns (uint256) {
        return t.balanceOf(Ledger.ASSERTION) + t.balanceOf(Ledger.WATCHDOG_FLOAT) + t.balanceOf(Ledger.PROPOSER_REWARD);
    }

    /// With nothing in flight the books equal the balance exactly; with bonds out, the balance covers
    /// the ledgers (ORC-14).
    function _assertBooks() internal view {
        assertGe(usdc.balanceOf(address(t)), _sum(), "ORC-14");
        if (t.totalOutstanding() == 0) assertEq(usdc.balanceOf(address(t)), _sum(), "no stray balance");
    }

    // ------------------------------------------------------------------ fundAssertion

    /// fundAssertion: debit, approval, record, venue pull, ledger and per-market cap, attempts add up.
    function test_fund() public {
        uint256 snap = vm.snapshotState();
        {
            // test_fund_debitsApprovesAndRecords
            vm.expectEmit(address(t));
            emit IBondTreasury.AssertionFunded(M, 0, address(venue), 11_120_000);
            vm.prank(oracle);
            t.fundAssertion(M, 0, address(venue), 11_120_000);
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6 - 11_120_000);
            assertEq(t.outstanding(M, 0), 11_120_000);
            assertEq(t.fundedTotal(M), 11_120_000);
            assertEq(t.totalOutstanding(), 11_120_000);
            assertEq(usdc.allowance(address(t), address(venue)), 11_120_000, "exactly the bond");
            assertEq(usdc.balanceOf(address(t)), 1_010e6, "nothing moves until the venue pulls");
        }
        vm.revertToState(snap);
        {
            // test_fund_venuePullsTheBond
            _assert(0, 5e6);
            assertEq(usdc.balanceOf(address(venue)), 5e6);
            assertEq(usdc.allowance(address(t), address(venue)), 0);
            _assertBooks();
        }
        vm.revertToState(snap);
        {
            // test_fund_insufficientLedger
            vm.prank(oracle);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IBondTreasury.InsufficientLedger.selector, Ledger.ASSERTION, 1_000e6 + 1, 1_000e6
                )
            );
            t.fundAssertion(M, 0, address(venue), 1_000e6 + 1);
        }
        vm.revertToState(snap);
        {
            // test_fund_perMarketCap
            _assert(0, 60e6);
            _assert(1, 40e6); // exactly at maxPerMarket
            vm.prank(oracle);
            vm.expectRevert(IBondTreasury.PerMarketCapExceeded.selector);
            t.fundAssertion(M, 2, address(venue), 1);
            vm.prank(oracle);
            t.fundAssertion(keccak256("market-2"), 0, address(venue), 1); // the cap is per market
        }
        vm.revertToState(snap);
        {
            // test_fund_capCountsReturnedBondsToo
            bytes32 a = _assert(0, 60e6);
            venue.setResult(a, true);
            venue.trySettle(a);
            vm.prank(oracle);
            t.onBondReturned(M, 0);
            vm.prank(oracle);
            vm.expectRevert(IBondTreasury.PerMarketCapExceeded.selector);
            t.fundAssertion(M, 1, address(venue), 40e6 + 1); // fundedTotal never decreases
        }
        vm.revertToState(snap);
        {
            // test_fund_limitsStartAtZero
            BondTreasury fresh = new BondTreasury(address(usdc), oracle, address(1), gov);
            usdc.approve(address(fresh), type(uint256).max);
            fresh.deposit(Ledger.ASSERTION, 10e6);
            vm.prank(oracle);
            vm.expectRevert(IBondTreasury.PerMarketCapExceeded.selector);
            fresh.fundAssertion(M, 0, address(venue), 1);
        }
        vm.revertToState(snap);
        {
            // test_fund_sameAttemptAddsUp
            vm.startPrank(oracle);
            t.fundAssertion(M, 0, address(venue), 3e6);
            t.fundAssertion(M, 0, address(venue), 4e6);
            vm.stopPrank();
            assertEq(t.outstanding(M, 0), 7e6);
            assertEq(t.totalOutstanding(), 7e6);
            assertEq(t.fundedTotal(M), 7e6);
        }
    }

    // ------------------------------------------------------------------ settlement hooks

    /// Booking hooks: returned credits, lost and stuck do not, no-ops with nothing outstanding, attempts independent.
    function test_bookingHooks() public {
        uint256 snap = vm.snapshotState();
        {
            // test_returned_creditsAssertion
            bytes32 a = _assert(0, 5e6);
            venue.setResult(a, true);
            assertTrue(venue.trySettle(a)); // the venue pays the bond back to the treasury (asserter)
            vm.expectEmit(address(t));
            emit IBondTreasury.BondReturned(M, 0, 5e6);
            vm.prank(oracle);
            t.onBondReturned(M, 0);
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6);
            assertEq(t.outstanding(M, 0), 0);
            assertEq(t.totalOutstanding(), 0);
            _assertBooks();
        }
        vm.revertToState(snap);
        {
            // test_lost_noCredit
            bytes32 a = _assert(0, 5e6);
            venue.setResult(a, false);
            venue.trySettle(a);
            vm.expectEmit(address(t));
            emit IBondTreasury.BondLost(M, 0, 5e6);
            vm.prank(oracle);
            t.onBondLost(M, 0);
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6 - 5e6);
            assertEq(t.totalOutstanding(), 0);
            _assertBooks();
        }
        vm.revertToState(snap);
        {
            // test_stuck_noCredit
            _assert(0, 5e6); // never answered
            vm.expectEmit(address(t));
            emit IBondTreasury.BondStuck(M, 0, 5e6);
            vm.prank(oracle);
            t.markStuck(M, 0);
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6 - 5e6);
            assertEq(t.outstanding(M, 0), 0);
            assertEq(t.totalOutstanding(), 0);
            _assertBooks();
        }
        vm.revertToState(snap);
        {
            // test_hooks_areNoOpsWithNothingOutstanding
            _assert(0, 5e6);
            vm.startPrank(oracle);
            t.onBondReturned(M, 0);
            vm.recordLogs();
            t.onBondReturned(M, 0); // second time
            t.onBondLost(M, 0);
            t.markStuck(M, 0);
            t.onBondReturned(M, 1); // never funded
            t.onBondLost(keccak256("other"), 0);
            vm.stopPrank();
            assertEq(vm.getRecordedLogs().length, 0, "no event, no revert");
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6, "credited once");
        }
        vm.revertToState(snap);
        {
            // test_attemptsAreIndependent
            bytes32 a0 = _assert(0, 6e6);
            venue.setResult(a0, false);
            venue.trySettle(a0);
            vm.prank(oracle);
            t.onBondLost(M, 0);
            bytes32 a1 = _assert(1, 7e6);
            venue.setResult(a1, true);
            venue.trySettle(a1);
            vm.prank(oracle);
            t.onBondReturned(M, 1);
            assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6 - 6e6);
            assertEq(t.fundedTotal(M), 13e6);
            _assertBooks();
        }
    }

    // ------------------------------------------------------------------ proposer rewards

    /// Proposer reward: paid, IOU on a short ledger or failed transfer, exact ledger pays, zero is trivial.
    function test_reward() public {
        uint256 snap = vm.snapshotState();
        {
            // test_reward_paid
            vm.expectEmit(address(t));
            emit IBondTreasury.RewardPaid(M, proposer, 5e6);
            vm.prank(oracle);
            assertTrue(t.payProposerReward(M, proposer, 5e6));
            assertEq(usdc.balanceOf(proposer), 5e6);
            assertEq(t.balanceOf(Ledger.PROPOSER_REWARD), 5e6);
            assertEq(t.owed(proposer), 0);
            _assertBooks();
        }
        vm.revertToState(snap);
        {
            // test_reward_shortLedgerRecordsIou
            vm.expectEmit(address(t));
            emit IBondTreasury.RewardOwed(M, proposer, 10e6 + 1);
            vm.prank(oracle);
            assertFalse(t.payProposerReward(M, proposer, 10e6 + 1));
            assertEq(t.owed(proposer), 10e6 + 1);
            assertEq(usdc.balanceOf(proposer), 0);
            assertEq(t.balanceOf(Ledger.PROPOSER_REWARD), 10e6, "untouched");
        }
        vm.revertToState(snap);
        {
            // test_reward_exactLedgerPays
            vm.prank(oracle);
            assertTrue(t.payProposerReward(M, proposer, 10e6));
            assertEq(t.balanceOf(Ledger.PROPOSER_REWARD), 0);
        }
        vm.revertToState(snap);
        {
            // test_reward_failedTransferRecordsIou
            usdc.configure(proposer, false); // the token refuses transfers to the proposer (e.g. blacklisted)
            vm.expectEmit(address(t));
            emit IBondTreasury.RewardOwed(M, proposer, 5e6);
            vm.prank(oracle);
            assertFalse(t.payProposerReward(M, proposer, 5e6));
            assertEq(t.owed(proposer), 5e6);
            assertEq(t.balanceOf(Ledger.PROPOSER_REWARD), 10e6, "re-credited");
            assertEq(usdc.balanceOf(address(t)), _sum());
        }
        vm.revertToState(snap);
        {
            // test_reward_zeroIsPaidTrivially
            vm.recordLogs();
            vm.prank(oracle);
            assertTrue(t.payProposerReward(M, proposer, 0));
            assertEq(vm.getRecordedLogs().length, 0);
        }
    }

    /// Never reverts, whatever the ledger and the token do; the reward is either paid or owed, never both.
    function testFuzz_reward_neverReverts(uint64 ledger, uint64 amount, bool blocked) public {
        BondTreasury r = new BondTreasury(address(usdc), oracle, address(1), gov);
        usdc.mint(address(this), ledger);
        usdc.approve(address(r), type(uint256).max);
        r.deposit(Ledger.PROPOSER_REWARD, ledger);
        if (blocked) usdc.configure(proposer, false);
        uint256 before = usdc.balanceOf(proposer);
        vm.prank(oracle);
        bool paid = r.payProposerReward(M, proposer, amount);
        assertEq(paid, amount == 0 || (amount <= ledger && !blocked));
        assertEq(usdc.balanceOf(proposer) - before, paid ? amount : 0);
        assertEq(r.owed(proposer), paid ? 0 : amount);
        assertEq(usdc.balanceOf(address(r)), r.balanceOf(Ledger.PROPOSER_REWARD));
    }

    // ------------------------------------------------------------------ claimOwed

    /// claimOwed: pays the whole IOU or nothing; a no-op when nothing is owed.
    function test_claimOwed() public {
        uint256 snap = vm.snapshotState();
        {
            // test_claimOwed_paysTheWholeIou
            vm.prank(oracle);
            t.payProposerReward(M, proposer, 15e6);
            t.deposit(Ledger.PROPOSER_REWARD, 5e6); // ledger now 15e6
            vm.expectEmit(address(t));
            emit IBondTreasury.OwedClaimed(proposer, 15e6);
            vm.prank(proposer);
            t.claimOwed();
            assertEq(usdc.balanceOf(proposer), 15e6);
            assertEq(t.owed(proposer), 0);
            assertEq(t.balanceOf(Ledger.PROPOSER_REWARD), 0);
            vm.recordLogs();
            vm.prank(proposer);
            t.claimOwed(); // nothing left: quiet no-op
            assertEq(vm.getRecordedLogs().length, 0);
        }
        vm.revertToState(snap);
        {
            // test_claimOwed_allOrNothing
            vm.prank(oracle);
            t.payProposerReward(M, proposer, 15e6);
            vm.prank(proposer);
            vm.expectRevert(
                abi.encodeWithSelector(IBondTreasury.InsufficientLedger.selector, Ledger.PROPOSER_REWARD, 15e6, 10e6)
            );
            t.claimOwed();
            assertEq(t.owed(proposer), 15e6);
        }
        vm.revertToState(snap);
        {
            // test_claimOwed_nothingOwedIsANoOp
            vm.recordLogs();
            vm.prank(disputer);
            t.claimOwed();
            assertEq(vm.getRecordedLogs().length, 0);
        }
    }

    // ------------------------------------------------------------------ access

    function test_oracleOnly() public {
        address[3] memory callers = [gov, proposer, makeAddr("registry")];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.fundAssertion(M, 0, address(venue), 1);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.onBondReturned(M, 0);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.onBondLost(M, 0);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.markStuck(M, 0);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.payProposerReward(M, callers[i], 1);
            vm.stopPrank();
        }
    }
}
