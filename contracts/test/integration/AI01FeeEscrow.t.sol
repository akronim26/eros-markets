// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {CombinedBase} from "./CombinedBase.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {ReserveVault} from "../../src/vaults/ReserveVault.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {PricingMode} from "../../src/math/RiskTypes.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";

/// @dev Scripted engine double: registered with the vault, forwards fee and custody calls.
contract FeeEngineStub {
    CollateralVault immutable vault;

    constructor(CollateralVault vault_) {
        vault = vault_;
    }

    function onAllocate(address, uint256) external {}
    function onReserveAllocate(address, uint256) external {}

    function claimsEnabled() external pure returns (bool) {
        return true;
    }

    function onCashClaim(address, uint256) external {}

    function reclassify(address beneficiary, uint256 protocolQ, uint256 keeperQ) external {
        vault.reclassifyFees(beneficiary, protocolQ, keeperQ);
    }

    function assign(address keeper, uint256 amountQ) external returns (uint256) {
        return vault.assignKeeperFee(keeper, amountQ);
    }

    function release(address owner, uint256 atoms) external {
        vault.release(owner, atoms);
    }

    function escrow(address owner, uint256 atoms) external {
        vault.escrow(owner, atoms);
    }
}

/// @notice A-I01 (spec "Fee escrow and exceptional recovery"): protocol and keeper fee Q move into
///         global per-beneficiary vault fee escrows by internal bookkeeping; the market allocation
///         falls by exactly those Q; withdrawals pay floor atoms and keep fractions as liabilities.
///         Expected values are hand arithmetic in the comments.
contract AI01VaultFeeEscrowTest is Test {
    uint256 constant Q = 1e18;
    address constant TREASURY = address(0x777);
    address constant KEEPER = address(0xBEEF);
    address constant ALICE = address(0xA11CE);
    MockUSDC token;
    CollateralVault vault;
    FeeEngineStub a;
    FeeEngineStub b;

    function setUp() public {
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        a = new FeeEngineStub(vault);
        b = new FeeEngineStub(vault);
        vault.registerEngine(address(a));
        vault.registerEngine(address(b));
        _allocate(address(a), 10);
        _allocate(address(b), 5);
    }

    function _allocate(address engine, uint256 atoms) internal {
        token.mint(ALICE, atoms);
        vm.startPrank(ALICE);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(engine, atoms, false);
        vm.stopPrank();
    }

    function _marketQ(address engine) internal view returns (uint256) {
        return vault.marketAtoms(engine) * Q - vault.marketDebitQ(engine);
    }

    /// Custody identity across every category, in Q.
    function _assertCustody() internal view {
        address[3] memory owners = [ALICE, TREASURY, KEEPER];
        address[2] memory engines = [address(a), address(b)];
        uint256 sum = vault.totalFeeEscrowQ();
        for (uint256 i; i < owners.length; ++i) {
            sum += vault.freeAtoms(owners[i]) * Q;
            for (uint256 j; j < engines.length; ++j) {
                sum += vault.claimAtoms(engines[j], owners[i]) * Q;
            }
        }
        for (uint256 j; j < engines.length; ++j) {
            sum += _marketQ(engines[j]);
            assertLt(vault.marketDebitQ(engines[j]), Q, "debit below one atom");
        }
        assertEq(sum, vault.recognizedAtoms() * Q, "custody identity");
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
    }

    function test_reclassifyDebitsMarketByExactQ() public {
        // 2.6 + 1.5 = 4.1 atoms of fees out of 10: whole atoms 10 - 4 = 6, debit 0.1 atom.
        a.reclassify(TREASURY, 26e17, 15e17);
        assertEq(vault.marketAtoms(address(a)), 6);
        assertEq(vault.marketDebitQ(address(a)), 1e17);
        assertEq(_marketQ(address(a)), 59e17);
        assertEq(vault.feeEscrowQ(TREASURY), 26e17);
        assertEq(vault.keeperPoolQ(address(a)), 15e17);
        assertEq(vault.totalFeeEscrowQ(), 41e17);
        assertEq(vault.recognizedAtoms(), 15, "no token moved");
        _assertCustody();
    }

    function test_marketCannotPayOutReclassifiedFraction() public {
        a.reclassify(TREASURY, 1e17, 0); // market holds 9.9 atoms: 10 whole, debit 0.1
        assertEq(vault.marketAtoms(address(a)), 10);
        assertEq(vault.marketDebitQ(address(a)), 1e17);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        a.release(ALICE, 10);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        a.escrow(ALICE, 10);
        a.release(ALICE, 9); // 0.9 atom of market allocation remains
        assertEq(_marketQ(address(a)), 9e17);
        _assertCustody();
    }

    function test_floorWithdrawalKeepsFractionAcrossMarkets() public {
        a.reclassify(TREASURY, 6e17, 0);
        b.reclassify(TREASURY, 6e17, 0);
        // 0.6 + 0.6 = 1.2 atoms owned by the treasury: one atom pays, 0.2 stays a liability.
        vm.prank(TREASURY);
        assertEq(vault.withdrawFees(), 1);
        assertEq(vault.freeAtoms(TREASURY), 1);
        assertEq(vault.feeEscrowQ(TREASURY), 2e17);
        assertEq(vault.totalFeeEscrowQ(), 2e17);
        _assertCustody();
        vm.prank(TREASURY);
        assertEq(vault.withdrawFees(), 0, "fraction is not paid");
        vm.prank(TREASURY);
        vault.withdraw(1);
        assertEq(token.balanceOf(TREASURY), 1);
        _assertCustody();
    }

    function test_keeperAssignmentIsExactAndBounded() public {
        a.reclassify(TREASURY, 0, 15e17);
        vm.expectRevert(); // more than the engine's keeper pool
        a.assign(KEEPER, 15e17 + 1);
        assertEq(a.assign(KEEPER, 15e17), 1, "1.5 atoms: one paid");
        assertEq(vault.feeEscrowQ(KEEPER), 5e17);
        assertEq(vault.keeperPoolQ(address(a)), 0);
        assertEq(vault.freeAtoms(KEEPER), 1);
        _assertCustody();
        // The keeper's half atom from a second market completes one more atom.
        b.reclassify(TREASURY, 0, 5e17);
        assertEq(b.assign(KEEPER, 5e17), 1);
        assertEq(vault.feeEscrowQ(KEEPER), 0);
        _assertCustody();
    }

    function test_onlyEnginesReclassifyAndBeneficiaryRequired() public {
        vm.expectRevert(CollateralVault.Unauthorized.selector);
        vault.reclassifyFees(TREASURY, 1, 0);
        vm.expectRevert(CollateralVault.Unauthorized.selector);
        vault.assignKeeperFee(KEEPER, 0);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        a.reclassify(address(0), 1, 0);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        a.assign(address(0), 0);
        vm.expectRevert(); // more than the market holds
        a.reclassify(TREASURY, 10 * Q + 1, 0);
    }
}

/// @notice A-I01 on the real combined engine: fees leave the market allocation before the reserve
///         residual is assigned, LP exits cannot reach them, and fractions survive every exit.
contract AI01CombinedFeeEscrowTest is CombinedBase {
    MathTypes.Side constant BUY = MathTypes.Side.BUY;
    MathTypes.Side constant SELL = MathTypes.Side.SELL;

    function _setup() internal returns (uint256 feesQ) {
        _variant = 1; // 0.1% taker fee
        _deploy(5, 100_000);
        uint256[] memory u = new uint256[](2);
        (u[0], u[1]) = (121, 100);
        _traders(u);
        ReserveVault rv = e.reserveVault();
        vm.prank(LP);
        rv.notice();
        _activate();
        _keep(L0 + 12 hours, 6e17, true);
        _roll(32);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        e.rest(1, SELL, 600, 1);
        assertEq(e.place(_ioc(2, BUY, 600, 1)).filledLots, 1);
        // Taker fees: 0.1% of 600 USDC = 600,000 atoms, plus 0.1% of one lot at .600 = 0.6 atom.
        feesQ = 600_000 * Q + 6e17;
        assertEq(e.protocolFeeQ(), feesQ);
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        oracle.finalize(1); // YES
    }

    function test_feesReclassifiedBeforeReserveResidual() public {
        uint256 feesQ = _setup();
        uint256 marketAtomsBefore = vault.marketAtoms(address(e));
        while (!e.prepareSnapshotChunk(32).done) {}
        uint256 allocationBefore = e.allocationQ();
        while (!e.preparePayoutChunk(32).done) {}
        assertTrue(e.finishPreparation());
        assertTrue(e.feesReclassified());
        assertEq(e.protocolFeeQ(), 0);
        assertEq(e.keeperPayableQ(), 0);
        assertEq(e.reclassifiedProtocolFeeQ(), feesQ);
        assertEq(e.reclassifiedKeeperQ(), 0);
        assertEq(vault.feeEscrowQ(TREASURY), feesQ);
        // 600,000.6 atoms leave the market: 600,000 whole atoms plus a 0.6-atom debit.
        assertEq(vault.marketDebitQ(address(e)), 6e17);
        uint256 traderAtoms = e.totalTraderAtoms();
        assertEq(vault.marketAtoms(address(e)), marketAtomsBefore - 600_000 - traderAtoms);
        assertEq(e.allocationQ(), allocationBefore - feesQ - traderAtoms * Q);
        assertEq(vault.marketAtoms(address(e)) * Q - vault.marketDebitQ(address(e)), e.allocationQ());
        // Only LP atoms and reserve dust remain in the market.
        assertEq(e.outstandingReserveAtoms() * Q + e.treasuryQ(), e.allocationQ());

        // Every other exit first; the fee escrow is untouched by them.
        vm.warp(block.timestamp + 7 days);
        e.redeemReserve(LP);
        e.withdrawTreasury();
        e.claimTrader(_who(1));
        if (e.traderAtoms(_who(2)) != 0) e.claimTrader(_who(2));
        assertEq(vault.feeEscrowQ(TREASURY), feesQ);
        assertEq(e.allocationQ(), e.treasuryQ(), "only the reserve-owned fraction is left");
        assertEq(vault.marketAtoms(address(e)) * Q - vault.marketDebitQ(address(e)), e.allocationQ());

        vm.prank(TREASURY);
        assertEq(vault.withdrawFees(), 600_000);
        assertEq(vault.feeEscrowQ(TREASURY), 6e17, "0.6 atom stays a liability");
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
    }

    function test_keeperWithdrawalAfterReclassificationIsExact() public {
        _setup();
        while (!e.prepareSnapshotChunk(32).done) {}
        while (!e.preparePayoutChunk(32).done) {}
        assertTrue(e.finishPreparation());
        // No keeper fee in this market: assigning zero pays nothing and keeps the ledger at zero.
        vm.prank(KEEPER);
        assertEq(e.withdrawKeeper(), 0);
        assertEq(vault.feeEscrowQ(KEEPER), 0);
        assertEq(vault.keeperPoolQ(address(e)), 0);
    }
}
