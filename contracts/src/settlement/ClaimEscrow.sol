// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {RecoveryAccounting} from "./RecoveryAccounting.sol";

abstract contract ClaimEscrow is RecoveryAccounting {
    function claimTrader(address owner) external nonReentrant returns (uint256) {
        if (!claimsEnabled) revert BadState();
        return collateralVault.claim(address(this), owner);
    }

    function claimableAtoms(address owner) external view returns (uint256) {
        return claimsEnabled ? collateralVault.claimAtoms(address(this), owner) : 0;
    }
}
