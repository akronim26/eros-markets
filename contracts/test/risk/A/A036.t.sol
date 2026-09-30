// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, AccountingHarness, P} from "./AccountingTestBase.sol";
import {SettlementMath as S} from "../../../src/math/SettlementMath.sol";
import {BackstopPool} from "../../../src/vaults/BackstopPool.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {MockRiskDecision} from "../../mocks/A/MockRiskDecision.sol";

/// @dev Counterfactual finalized bad debt. Healthy live coverage cannot create this
/// state. Only this test fixture bypasses snapshot validation to test recovery math
/// and real token transfers; no production emergency ledger setter exists.
contract RecoveryFixture is AccountingHarness {
    constructor(CollateralVault v, MockRiskDecision d, address t, uint64 end_, bool enabled)
        AccountingHarness(v, d, t, end_, enabled, false)
    {}

    function finalizedDeficit(address owner) external {
        require(allocationQ == 200e18 && participants.length == 1);
        halted = true;
        snapshotComplete = true;
        payoutScanComplete = true;
        sweepCount = 1;
        frozenAllocationQ = allocationQ;
        availableTraderQ = allocationQ;
        ordinaryTraderAtoms = 240;
        totalRawClaimQ = 240e18;
        rawClaimQ[owner] = 240e18;
        reserve.cashQ = -40e18;
        frozenReserve = reserve;
        recoveryRequired = true;
    }
}

contract A036Test is AccountingTestBase {
    function testBaselineCannotEnableRecoveryAndRatioFloors() public {
        _trade();
        _finish(0, 32);
        assertFalse(h.recoveryEnabled());
        vm.expectRevert();
        h.listedRecovery();
        assertEq(S.recoveryAtoms(3e18, 10e18, 5e18), 1);
        assertEq(S.recoveryAtoms(7e18, 10e18, 5e18), 3);
        assertEq(S.recoveryAtoms(0, 0, 0), 0);
        assertEq(S.backstopAtoms(100, 1000, 100), 20);
    }

    function testCappedBackstopBecomesRealCustodyBeforeListedRecovery() public {
        RecoveryFixture f = new RecoveryFixture(vault, decision, treasury, end, true);
        vault.registerEngine(address(f));
        BackstopPool pool = new BackstopPool(address(token), address(this));
        f.bindBackstop(address(pool));
        token.mint(address(this), 300);
        token.approve(address(vault), 200);
        vault.deposit(200);
        vault.allocate(address(f), 100, true);
        vault.allocate(address(f), 100, false);
        f.activate(0, P.Tariff(0, 0, 0));
        token.approve(address(pool), 100);
        pool.fund(address(f), 100);
        uint256 recognized = vault.recognizedAtoms();
        f.finalizedDeficit(address(this));
        vm.expectRevert();
        f.allocatePayout(32);
        assertEq(f.applyBackstop(100), 20);
        assertEq(f.applyBackstop(100), 0);
        assertEq(pool.spentAtoms(address(f)), 20);
        assertEq(pool.earmarkedAtoms(address(f)), 80);
        assertEq(vault.recognizedAtoms(), recognized + 20);
        assertEq(vault.marketAtoms(address(f)), 220);
        assertEq(f.availableTraderQ(), 220e18);
        assertTrue(f.recoveryRequired());
        f.listedRecovery();
        f.allocatePayout(32);
        f.prepareReserve(32);
        assertEq(f.traderAtoms(address(this)), 220);
        f.claimTrader(address(this));
        assertEq(vault.marketAtoms(address(f)), 0);
        assertEq(f.allocationQ(), 0);
    }
}
