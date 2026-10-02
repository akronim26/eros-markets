// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {RecoveryAccounting} from "./RecoveryAccounting.sol";

abstract contract ClaimEscrow is RecoveryAccounting {
    mapping(address => bool) public traderClaimed;
    bool public anyCashClaim;

    function _beforeCashClaim() internal virtual {}

    function onCashClaim(address owner, uint256 atoms) external {
        if (msg.sender != address(collateralVault)) revert Unauthorized();
        if (!claimsEnabled || atoms == 0) revert BadState();
        _beforeCashClaim();
        anyCashClaim = true;
        if (!traderClaimed[owner] && traderAtoms[owner] != 0) {
            if (atoms < traderAtoms[owner]) revert BadState();
            traderClaimed[owner] = true;
            --unpaidTraderClaims;
        }
    }

    function allTraderClaimsPaid() public view returns (bool) {
        return claimsEnabled && unpaidTraderClaims == 0;
    }

    function claimTrader(address owner) external nonReentrant returns (uint256) {
        if (!claimsEnabled) revert BadState();
        return collateralVault.claim(address(this), owner);
    }

    function claimableAtoms(address owner) external view returns (uint256) {
        return claimsEnabled ? collateralVault.claimAtoms(address(this), owner) : 0;
    }
}
