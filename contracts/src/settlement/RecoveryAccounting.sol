// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {PayoutLedger} from "./PayoutLedger.sol";
import {BackstopPool} from "../vaults/BackstopPool.sol";
import {ICollateralToken} from "../vaults/CollateralVault.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract RecoveryAccounting is PayoutLedger {
    address public backstopPool;

    function _bindBackstop(address pool) internal {
        if (active || backstopPool != address(0) || pool.code.length == 0) revert BadState();
        backstopPool = pool;
    }

    function _applyBackstop(uint256 requestedAtoms) internal returns (uint256 atoms) {
        if (!payoutScanComplete || allocationCursor != 0 || backstopPool == address(0) || !recoveryRequired) {
            revert BadState();
        }
        ICollateralToken token = collateralVault.token();
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 shortage = (ordinaryTraderAtoms * 1e18 - availableTraderQ + 1e18 - 1) / 1e18;
        atoms = BackstopPool(backstopPool).draw(Q.min(requestedAtoms, shortage), reserveCapBaseQ / 1e18);
        if (token.balanceOf(address(this)) - beforeBalance != atoms) revert BadState();
        if (!token.approve(address(collateralVault), atoms)) revert BadState();
        collateralVault.addBackingFromEngine(atoms);
        uint256 cash = atoms * 1e18;
        allocationQ += cash;
        frozenAllocationQ += cash;
        reserve.cashQ = Q.cash(reserve.cashQ + Q.signed(cash));
        frozenReserve.cashQ = reserve.cashQ;
        _assessAvailable();
    }

    function _enableListedRecovery() internal {
        if (!recoveryEnabled || !payoutScanComplete || !recoveryRequired || allocationCursor != 0) {
            revert BadState();
        }
        useRecovery = true;
    }
}
