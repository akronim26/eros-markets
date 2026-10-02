// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ReserveAccounting} from "./ReserveAccounting.sol";
import {AccountingState} from "../math/MathTypes.sol";

abstract contract FeeAccounting is ReserveAccounting {
    /// @notice True once protocol and keeper fee Q have left this market for vault fee escrows.
    bool public feesReclassified;
    uint256 public reclassifiedProtocolFeeQ;
    uint256 public reclassifiedKeeperQ;

    function _creditKeeper(address owner, uint256 amountQ) internal {
        if (owner == address(0) || feesReclassified) revert BadUnits();
        keeperQ[owner] += amountQ;
        keeperPayableQ += amountQ;
    }

    /// @dev A-I01 (spec "Fee escrow and exceptional recovery"): before the reserve residual is
    ///      assigned, move exact protocolFeeQ and keeperPayableQ into the vault's fee escrows and
    ///      reduce allocationQ by exactly those Q. No token transfer, no rounding. `keeperQ` keeps
    ///      recording which keeper owns each part of the vault's keeper pool for this market.
    function _reclassifyFees() internal {
        if (feesReclassified) revert BadState();
        uint256 protocolQ = protocolFeeQ;
        uint256 keeperFeeQ = keeperPayableQ;
        feesReclassified = true;
        reclassifiedProtocolFeeQ = protocolQ;
        reclassifiedKeeperQ = keeperFeeQ;
        protocolFeeQ = 0;
        keeperPayableQ = 0;
        allocationQ -= protocolQ + keeperFeeQ;
        collateralVault.reclassifyFees(treasury, protocolQ, keeperFeeQ);
        emit FeesReclassified(protocolQ, keeperFeeQ);
        _publishMarket();
    }

    /// @notice Before reclassification: pay whole atoms from the market and keep the fraction.
    ///         After it: move the caller's exact Q to their global vault fee escrow, which pays
    ///         whole atoms to their free balance and keeps the fraction as a liability.
    function withdrawKeeper() external nonReentrant returns (uint256 atoms) {
        if (feesReclassified) {
            uint256 amountQ = keeperQ[msg.sender];
            keeperQ[msg.sender] = 0;
            return collateralVault.assignKeeperFee(msg.sender, amountQ);
        }
        if (halted || work != AccountingState.READY) revert BadState();
        atoms = keeperQ[msg.sender] / 1e18;
        keeperQ[msg.sender] -= atoms * 1e18;
        keeperPayableQ -= atoms * 1e18;
        allocationQ -= atoms * 1e18;
        collateralVault.release(msg.sender, atoms);
        _publishMarket();
    }
}
