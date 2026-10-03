pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {AccountingHarness} from "../harness/A/AccountingHarness.sol";
import {FeeEngineStub} from "../integration/AI01FeeEscrow.t.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {MockRiskDecision} from "../mocks/A/MockRiskDecision.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {BackstopPool} from "../../src/vaults/BackstopPool.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {AccountingState} from "../../src/math/MathTypes.sol";
import {PremiumMath} from "../../src/math/PremiumMath.sol";

contract AI01RecoveryReviewHarness is AccountingHarness {
    constructor(CollateralVault vault, MockRiskDecision decision, address treasury, uint64 end, bool recovery)
        AccountingHarness(vault, decision, treasury, end, recovery, false)
    {}

    function stageCounterfactualFrozenDeficit(address trader, address keeper) external {
        require(allocationQ == 200e18 && participants.length == 1 && !halted);
        protocolFeeQ = 26e17;
        _creditKeeper(keeper, 15e17);
        accounts[trader].value.cashQ = 240e18;
        reserve.cashQ = -441e17;
        frozen[trader] = accounts[trader].value;
        frozenReserve = reserve;
        snapshotCashQ = 240e18;
        frozenAllocationQ = allocationQ;
        frozenFeeQ = protocolFeeQ + keeperPayableQ;
        halted = true;
        work = AccountingState.HALT_SWEEP;
        epoch.stopped = true;
        epoch.stop = epoch.last;
        snapshotComplete = true;
        sweepCount = 1;
    }
}

contract AI01DeltaReviewTest is Test {
    address private constant TREASURY = address(0x700);
    address private constant KEEPER = address(0x701);
    address private constant TRADER = address(0x702);
    address private constant LP = address(0x703);
    MockUSDC private token;
    CollateralVault private vault;
    AI01RecoveryReviewHarness private engine;
    BackstopPool private backstop;

    function testActualFeeScanBackstopAndRecoveryPreserveEveryFraction() public {
        _setupFrozenFees(true);
        assertTrue(engine.scanPayout(1));
        _assertInitialReclassification();
        assertEq(engine.applyBackstop(100), 20);
        assertEq(engine.applyBackstop(100), 0);
        assertTrue(engine.scanPayout(1));
        assertEq(backstop.spentAtoms(address(engine)), 20);
        assertEq(engine.availableTraderQ(), 2159e17);
        assertEq(engine.allocationQ(), 2159e17);
        assertEq(vault.marketAtoms(address(engine)), 216);
        assertEq(vault.marketDebitQ(address(engine)), 1e17);
        assertEq(vault.feeEscrowQ(TREASURY), 26e17);
        assertEq(vault.keeperPoolQ(address(engine)), 15e17);
        assertEq(vault.totalFeeEscrowQ(), 41e17);
        assertEq(engine.reclassifiedProtocolFeeQ() + engine.reclassifiedKeeperQ(), 41e17);
        engine.listedRecovery();
        assertTrue(engine.allocatePayout(1));
        assertTrue(engine.prepareReserve(1));
        assertEq(engine.traderAtoms(TRADER), 215);
        assertEq(engine.reserveResidualQ(), 9e17);
        assertEq(engine.treasuryQ(), 9e17);
        assertEq(engine.claimTrader(TRADER), 215);
        _withdrawFeeOwners();
        assertEq(token.balanceOf(TRADER), 215);
        assertEq(token.balanceOf(TREASURY), 2);
        assertEq(token.balanceOf(KEEPER), 1);
        assertEq(vault.feeEscrowQ(TREASURY), 6e17);
        assertEq(vault.feeEscrowQ(KEEPER), 5e17);
        assertEq(vault.keeperPoolQ(address(engine)), 0);
        assertEq(vault.totalFeeEscrowQ(), 11e17);
        assertEq(engine.allocationQ(), 9e17);
        assertEq(vault.marketAtoms(address(engine)) * 1e18 - vault.marketDebitQ(address(engine)), 9e17);
        assertEq(token.balanceOf(address(vault)), 2);
        assertEq(vault.recognizedAtoms() * 1e18, engine.allocationQ() + vault.totalFeeEscrowQ());
    }

    function testBaselineRecoveryStaysBlockedAfterFeeOwnersExit() public {
        _setupFrozenFees(false);
        assertTrue(engine.scanPayout(1));
        _assertInitialReclassification();
        vm.expectRevert(RiskStorage.BadState.selector);
        engine.listedRecovery();
        vm.expectRevert(RiskStorage.BadState.selector);
        engine.allocatePayout(1);
        vm.expectRevert(RiskStorage.BadState.selector);
        engine.claimTrader(TRADER);
        _withdrawFeeOwners();
        assertFalse(engine.claimsEnabled());
        assertTrue(engine.recoveryRequired());
        assertFalse(engine.useRecovery());
        assertEq(engine.availableTraderQ(), 1959e17);
        assertEq(engine.allocationQ(), 1959e17);
        assertEq(engine.totalRawClaimQ(), 240e18);
        assertEq(vault.totalFeeEscrowQ(), 11e17);
        assertEq(vault.recognizedAtoms(), 197);
        assertEq(token.balanceOf(address(vault)), 197);
        assertEq(vault.recognizedAtoms() * 1e18, engine.allocationQ() + vault.totalFeeEscrowQ());
        assertEq(token.balanceOf(TRADER), 0);
    }

    function testSuccessiveFractionalDebitsAndFailedExitsRollBackExactly() public {
        _newVault();
        FeeEngineStub source = _stubWithAllocation(10);
        source.reclassify(TREASURY, 6e17, 1e17);
        source.reclassify(TREASURY, 5e17, 3e17);
        source.reclassify(TREASURY, 1e17, 2e17);
        assertEq(vault.marketAtoms(address(source)), 9);
        assertEq(vault.marketDebitQ(address(source)), 8e17);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        source.reclassify(TREASURY, 82e17 + 1, 0);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        source.release(address(this), 9);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        source.escrow(address(this), 9);
        vm.expectRevert();
        source.assign(KEEPER, 6e17 + 1);
        assertEq(vault.marketAtoms(address(source)), 9);
        assertEq(vault.marketDebitQ(address(source)), 8e17);
        assertEq(vault.feeEscrowQ(TREASURY), 12e17);
        assertEq(vault.keeperPoolQ(address(source)), 6e17);
        assertEq(vault.feeEscrowQ(KEEPER), 0);
        assertEq(vault.freeAtoms(address(this)), 0);
        assertEq(vault.claimAtoms(address(source), address(this)), 0);
        assertEq(vault.totalFeeEscrowQ(), 18e17);
        source.release(address(this), 8);
        vault.withdraw(8);
        source.reclassify(TREASURY, 2e17, 0);
        assertEq(vault.marketAtoms(address(source)), 0);
        assertEq(vault.marketDebitQ(address(source)), 0);
        assertEq(vault.feeEscrowQ(TREASURY), 14e17);
        assertEq(vault.keeperPoolQ(address(source)), 6e17);
        assertEq(vault.totalFeeEscrowQ(), 2e18);
        assertEq(vault.recognizedAtoms(), 2);
        assertEq(token.balanceOf(address(vault)), 2);
        assertEq(token.balanceOf(address(this)), 8);
    }

    function testSharedBeneficiaryAggregatesFeesWithoutBorrowingAnotherKeeperPool() public {
        _newVault();
        FeeEngineStub first = _stubWithAllocation(10);
        FeeEngineStub second = _stubWithAllocation(5);
        first.reclassify(KEEPER, 6e17, 4e17);
        second.reclassify(KEEPER, 6e17, 9e17);
        assertEq(first.assign(KEEPER, 4e17), 1);
        vm.expectRevert();
        first.assign(KEEPER, 1);
        assertEq(vault.keeperPoolQ(address(first)), 0);
        assertEq(vault.keeperPoolQ(address(second)), 9e17);
        assertEq(vault.feeEscrowQ(KEEPER), 6e17);
        assertEq(second.assign(KEEPER, 9e17), 1);
        assertEq(first.assign(KEEPER, 0), 0);
        vm.prank(TRADER);
        assertEq(vault.withdrawFees(), 0);
        assertEq(vault.freeAtoms(KEEPER), 2);
        assertEq(vault.feeEscrowQ(KEEPER), 5e17);
        assertEq(vault.totalFeeEscrowQ(), 5e17);
        vm.prank(KEEPER);
        vault.withdraw(2);
        uint256 remainingMarketQ = vault.marketAtoms(address(first)) * 1e18
            - vault.marketDebitQ(address(first)) + vault.marketAtoms(address(second)) * 1e18
            - vault.marketDebitQ(address(second));
        assertEq(remainingMarketQ, 125e17);
        assertEq(remainingMarketQ + vault.totalFeeEscrowQ(), vault.recognizedAtoms() * 1e18);
        assertEq(token.balanceOf(address(vault)), 13);
        assertEq(token.balanceOf(KEEPER), 2);
    }

    function _newVault() private {
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
    }

    function _setupFrozenFees(bool recoveryEnabled) private {
        _newVault();
        MockRiskDecision decision = new MockRiskDecision();
        engine = new AI01RecoveryReviewHarness(
            vault, decision, TREASURY, uint64(block.timestamp + 10 days), recoveryEnabled
        );
        vault.registerEngine(address(engine));
        backstop = new BackstopPool(address(token), address(this));
        engine.bindBackstop(address(backstop));
        _allocateEngine(LP, 100, true);
        _allocateEngine(TRADER, 100, false);
        engine.activate(0, PremiumMath.Tariff(0, 0, 0));
        token.mint(address(this), 100);
        token.approve(address(backstop), 100);
        backstop.fund(address(engine), 100);
        engine.stageCounterfactualFrozenDeficit(TRADER, KEEPER);
        assertTrue(engine.finalPrice(0, bytes32(uint256(1))));
        assertFalse(engine.payoutScanComplete());
    }

    function _allocateEngine(address owner, uint256 atoms, bool reserve) private {
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(engine), atoms, reserve);
        vm.stopPrank();
    }

    function _stubWithAllocation(uint256 atoms) private returns (FeeEngineStub source) {
        source = new FeeEngineStub(vault);
        vault.registerEngine(address(source));
        token.mint(address(this), atoms);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(source), atoms, false);
    }

    function _assertInitialReclassification() private view {
        assertTrue(engine.feesReclassified());
        assertTrue(engine.recoveryRequired());
        assertEq(engine.reclassifiedProtocolFeeQ(), 26e17);
        assertEq(engine.reclassifiedKeeperQ(), 15e17);
        assertEq(engine.protocolFeeQ(), 0);
        assertEq(engine.keeperPayableQ(), 0);
        assertEq(engine.availableTraderQ(), 1959e17);
        assertEq(engine.allocationQ(), 1959e17);
        assertEq(vault.marketAtoms(address(engine)), 196);
        assertEq(vault.marketDebitQ(address(engine)), 1e17);
        assertEq(vault.feeEscrowQ(TREASURY), 26e17);
        assertEq(vault.keeperPoolQ(address(engine)), 15e17);
        assertEq(vault.totalFeeEscrowQ(), 41e17);
        assertEq(vault.recognizedAtoms(), 200);
    }

    function _withdrawFeeOwners() private {
        vm.startPrank(KEEPER);
        assertEq(engine.withdrawKeeper(), 1);
        vault.withdraw(1);
        vm.stopPrank();
        vm.startPrank(TREASURY);
        assertEq(vault.withdrawFees(), 2);
        vault.withdraw(2);
        vm.stopPrank();
    }
}
