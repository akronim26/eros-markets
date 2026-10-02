// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ReserveAccounting} from "./ReserveAccounting.sol";
import {AccountingState} from "../math/MathTypes.sol";

abstract contract FeeAccounting is ReserveAccounting {
    function _creditKeeper(address owner, uint256 amountQ) internal {
        if (owner == address(0)) revert BadUnits();
        keeperQ[owner] += amountQ;
        keeperPayableQ += amountQ;
    }

    function withdrawKeeper() external nonReentrant returns (uint256 atoms) {
        if ((halted || work != AccountingState.READY) && !claimsEnabled) revert BadState();
        atoms = keeperQ[msg.sender] / 1e18;
        keeperQ[msg.sender] -= atoms * 1e18;
        keeperPayableQ -= atoms * 1e18;
        allocationQ -= atoms * 1e18;
        collateralVault.release(msg.sender, atoms);
        _publishMarket();
    }
}
