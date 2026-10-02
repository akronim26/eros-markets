// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {Ledger} from "../../src/types/OracleTypes.sol";
import {IBondTreasury} from "../../src/interfaces/IBondTreasury.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";

/// @notice Task O12.1: ledgers, deposits, listing commitments, withdraw and limits (plan §6.6, C.5),
///         ledger isolation, ORC-10 (only the Timelock withdraws, never ASSERTION below the commitments)
///         and ORC-14 (balance ≥ Σ ledgers). Amounts are hand-picked USDC atoms.
contract TreasuryLedgersTest is Test {
    MockUSDC internal usdc;
    BondTreasury internal t;

    address internal oracle = makeAddr("oracle");
    address internal registry = makeAddr("registry");
    address internal gov = makeAddr("timelock");
    address internal feeRouter = makeAddr("fee router");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new MockUSDC();
        t = new BondTreasury(address(usdc), oracle, registry, gov);
        usdc.mint(feeRouter, 1_000_000e6);
        vm.prank(feeRouter);
        usdc.approve(address(t), type(uint256).max);
    }

    function _deposit(Ledger l, uint256 amount) internal {
        vm.prank(feeRouter);
        t.deposit(l, amount);
    }

    function _sum() internal view returns (uint256) {
        return t.balanceOf(Ledger.ASSERTION) + t.balanceOf(Ledger.WATCHDOG_FLOAT) + t.balanceOf(Ledger.PROPOSER_REWARD);
    }

    function _assertSolvent() internal view {
        assertGe(usdc.balanceOf(address(t)), _sum(), "ORC-14");
    }

    function _commit(bytes32 id, uint256 amount) internal {
        vm.prank(registry);
        t.commitListing(id, amount);
    }

    // ------------------------------------------------------------------ constructor and limits

    function test_constructorAndInitialState() public view {
        assertEq(t.usdc(), address(usdc));
        assertEq(t.oracle(), oracle);
        assertEq(t.registry(), registry);
        assertEq(t.governance(), gov);
        assertEq(t.maxPerMarket(), 0, "limits start at 0");
        assertEq(t.maxOpenDisputes(), 0);
        assertEq(t.totalCommitted(), 0);
        assertEq(_sum(), 0);
    }

    function test_setLimits() public {
        vm.expectEmit(address(t));
        emit IBondTreasury.LimitsSet(100e6, 20);
        vm.prank(gov);
        t.setLimits(100e6, 20);
        assertEq(t.maxPerMarket(), 100e6);
        assertEq(t.maxOpenDisputes(), 20);
    }

    // ------------------------------------------------------------------ deposits

    function test_deposit_creditsOnlyItsLedger() public {
        vm.expectEmit(address(t));
        emit IBondTreasury.Deposited(Ledger.ASSERTION, feeRouter, 1_000e6);
        _deposit(Ledger.ASSERTION, 1_000e6);
        _deposit(Ledger.WATCHDOG_FLOAT, 300e6);
        _deposit(Ledger.PROPOSER_REWARD, 5e6);
        assertEq(t.balanceOf(Ledger.ASSERTION), 1_000e6);
        assertEq(t.balanceOf(Ledger.WATCHDOG_FLOAT), 300e6);
        assertEq(t.balanceOf(Ledger.PROPOSER_REWARD), 5e6);
        assertEq(usdc.balanceOf(address(t)), 1_305e6);
        assertEq(usdc.balanceOf(feeRouter), 1_000_000e6 - 1_305e6);
    }

    function test_deposit_byAnyone() public {
        usdc.mint(stranger, 7e6);
        vm.startPrank(stranger);
        usdc.approve(address(t), 7e6);
        t.deposit(Ledger.WATCHDOG_FLOAT, 7e6);
        vm.stopPrank();
        assertEq(t.balanceOf(Ledger.WATCHDOG_FLOAT), 7e6);
    }

    function test_deposit_withoutAllowanceReverts() public {
        usdc.mint(stranger, 7e6);
        vm.prank(stranger);
        vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
        t.deposit(Ledger.ASSERTION, 7e6);
    }

    /// MockUSDC's taxed mode delivers one atom less: the ledger is credited with what arrived.
    function test_deposit_creditsWhatArrived() public {
        usdc.configure(address(0), true);
        vm.expectEmit(address(t));
        emit IBondTreasury.Deposited(Ledger.ASSERTION, feeRouter, 10e6 - 1);
        _deposit(Ledger.ASSERTION, 10e6);
        assertEq(t.balanceOf(Ledger.ASSERTION), 10e6 - 1);
        assertEq(usdc.balanceOf(address(t)), _sum(), "ORC-14 with equality");
    }

    // ------------------------------------------------------------------ listing commitments

    function test_commit_recordsAndEmits() public {
        _deposit(Ledger.ASSERTION, 100e6);
        vm.expectEmit(address(t));
        emit IBondTreasury.ListingCommitted(keccak256("a"), 60e6);
        _commit(keccak256("a"), 60e6);
        assertEq(t.committedListing(keccak256("a")), 60e6);
        assertEq(t.totalCommitted(), 60e6);
        assertEq(t.balanceOf(Ledger.ASSERTION), 100e6, "a commitment moves no money");
    }

    function test_commit_mustCoverEveryOpenCommitment() public {
        _deposit(Ledger.ASSERTION, 100e6);
        _commit(keccak256("a"), 60e6);
        vm.prank(registry);
        vm.expectRevert(abi.encodeWithSelector(IBondTreasury.BelowCommitments.selector, 101e6, 100e6));
        t.commitListing(keccak256("b"), 41e6);
        _commit(keccak256("b"), 40e6); // exactly at the balance
        assertEq(t.totalCommitted(), 100e6);
    }

    function test_commit_onlyAssertionLedgerCounts() public {
        _deposit(Ledger.WATCHDOG_FLOAT, 500e6);
        _deposit(Ledger.PROPOSER_REWARD, 500e6);
        vm.prank(registry);
        vm.expectRevert(abi.encodeWithSelector(IBondTreasury.BelowCommitments.selector, 1, 0));
        t.commitListing(keccak256("a"), 1);
    }

    function test_commit_oncePerMarket() public {
        _deposit(Ledger.ASSERTION, 100e6);
        _commit(keccak256("a"), 0); // a zero commitment still counts as made
        vm.prank(registry);
        vm.expectRevert(IBondTreasury.AlreadyCommitted.selector);
        t.commitListing(keccak256("a"), 1);
    }

    function test_commit_registryOnly() public {
        _deposit(Ledger.ASSERTION, 100e6);
        address[4] memory callers = [oracle, gov, stranger, feeRouter];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.commitListing(keccak256("a"), 1);
        }
    }

    // ------------------------------------------------------------------ releaseListing

    function test_release_freesTheCommitment() public {
        _deposit(Ledger.ASSERTION, 100e6);
        _commit(keccak256("a"), 60e6);
        _commit(keccak256("b"), 40e6);
        vm.expectEmit(address(t));
        emit IBondTreasury.ListingReleased(keccak256("a"), 60e6);
        vm.prank(oracle);
        t.releaseListing(keccak256("a"));
        assertEq(t.committedListing(keccak256("a")), 0);
        assertEq(t.totalCommitted(), 40e6);
        _commit(keccak256("c"), 60e6); // the freed room is usable again
    }

    function test_release_isANoOpWithoutAnOpenCommitment() public {
        _deposit(Ledger.ASSERTION, 100e6);
        _commit(keccak256("a"), 60e6);
        vm.startPrank(oracle);
        t.releaseListing(keccak256("a"));
        vm.recordLogs();
        t.releaseListing(keccak256("a")); // second release
        t.releaseListing(keccak256("never committed"));
        vm.stopPrank();
        assertEq(vm.getRecordedLogs().length, 0, "no event, no revert");
        assertEq(t.totalCommitted(), 0);
    }

    function test_release_releasedMarketCannotCommitAgain() public {
        _deposit(Ledger.ASSERTION, 100e6);
        _commit(keccak256("a"), 60e6);
        vm.prank(oracle);
        t.releaseListing(keccak256("a"));
        vm.prank(registry);
        vm.expectRevert(IBondTreasury.AlreadyCommitted.selector);
        t.commitListing(keccak256("a"), 1);
    }

    function test_release_oracleOnly() public {
        _deposit(Ledger.ASSERTION, 100e6);
        _commit(keccak256("a"), 60e6);
        address[3] memory callers = [registry, gov, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.releaseListing(keccak256("a"));
        }
    }

    // ------------------------------------------------------------------ withdraw (ORC-10)

    function test_withdraw_assertionDownToCommitments() public {
        _deposit(Ledger.ASSERTION, 100e6);
        _commit(keccak256("a"), 60e6);
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(IBondTreasury.BelowCommitments.selector, 60e6 + 40e6 + 1, 100e6));
        t.withdraw(Ledger.ASSERTION, gov, 40e6 + 1);
        vm.expectEmit(address(t));
        emit IBondTreasury.Withdrawn(Ledger.ASSERTION, gov, 40e6);
        vm.prank(gov);
        t.withdraw(Ledger.ASSERTION, gov, 40e6);
        assertEq(t.balanceOf(Ledger.ASSERTION), 60e6);
        assertEq(usdc.balanceOf(gov), 40e6);
        _assertSolvent();
    }

    function test_withdraw_otherLedgersDownToZero() public {
        _deposit(Ledger.ASSERTION, 100e6);
        _commit(keccak256("a"), 100e6); // commitments never bind the other ledgers
        _deposit(Ledger.WATCHDOG_FLOAT, 30e6);
        _deposit(Ledger.PROPOSER_REWARD, 5e6);
        vm.startPrank(gov);
        t.withdraw(Ledger.WATCHDOG_FLOAT, gov, 30e6);
        t.withdraw(Ledger.PROPOSER_REWARD, gov, 5e6);
        vm.stopPrank();
        assertEq(t.balanceOf(Ledger.WATCHDOG_FLOAT), 0);
        assertEq(t.balanceOf(Ledger.PROPOSER_REWARD), 0);
        assertEq(t.balanceOf(Ledger.ASSERTION), 100e6, "isolation");
        assertEq(usdc.balanceOf(gov), 35e6);
    }

    function test_withdraw_aboveLedgerReverts() public {
        _deposit(Ledger.WATCHDOG_FLOAT, 30e6);
        _deposit(Ledger.ASSERTION, 500e6); // other ledgers never fund a withdrawal
        vm.prank(gov);
        vm.expectRevert(
            abi.encodeWithSelector(IBondTreasury.InsufficientLedger.selector, Ledger.WATCHDOG_FLOAT, 30e6 + 1, 30e6)
        );
        t.withdraw(Ledger.WATCHDOG_FLOAT, gov, 30e6 + 1);
    }

    function test_governanceOnly() public {
        _deposit(Ledger.WATCHDOG_FLOAT, 30e6);
        address[4] memory callers = [oracle, registry, stranger, feeRouter];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.withdraw(Ledger.WATCHDOG_FLOAT, callers[i], 1);
            vm.expectRevert(IBondTreasury.Unauthorized.selector);
            t.setLimits(1, 1);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ fuzz: isolation and solvency

    /// Deposits into all three ledgers, then one withdrawal from ledger `k`: only `k` changes, by exactly
    /// the amount, and the treasury stays solvent with equality (no stray balance).
    function testFuzz_isolationAndSolvency(uint64 a0, uint64 a1, uint64 a2, uint8 k, uint64 w) public {
        uint256[3] memory dep = [uint256(a0) % 1e12, uint256(a1) % 1e12, uint256(a2) % 1e12];
        usdc.mint(feeRouter, 3e12); // enough for any three deposits
        for (uint256 i; i < 3; ++i) {
            _deposit(Ledger(i), dep[i]);
        }
        uint256 j = k % 3;
        uint256 amount = dep[j] == 0 ? 0 : uint256(w) % (dep[j] + 1);
        vm.prank(gov);
        t.withdraw(Ledger(j), stranger, amount);
        for (uint256 i; i < 3; ++i) {
            assertEq(t.balanceOf(Ledger(i)), i == j ? dep[i] - amount : dep[i]);
        }
        assertEq(usdc.balanceOf(address(t)), _sum());
        assertEq(usdc.balanceOf(stranger), amount);
    }
}
