// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ClaimEscrow} from "./ClaimEscrow.sol";
import {SettlementMath as S} from "../math/SettlementMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract ReserveClaims is ClaimEscrow {
    uint256 public reserveCursor;
    uint256 public lpAtomsAllocated;
    uint256 public treasuryQ;
    uint256 public outstandingReserveAtoms;

    function _prepareReservePage(uint8 maximum) internal returns (bool complete) {
        if (!payoutsAllocated || maximum == 0 || maximum > 32) revert BadState();
        if (claimsEnabled) return true;
        uint256 count = reserveVault.holderCount();
        uint256 end = Q.min(reserveCursor + maximum, count);
        while (reserveCursor < end) {
            address owner = reserveVault.holders(reserveCursor++);
            uint256 atoms =
                S.shareAtoms(reserveResidualQ / 1e18, reserveVault.shares(owner), reserveVault.totalShares());
            lpAtomsAllocated += atoms;
            reserveVault.prepare(owner, atoms);
        }
        complete = reserveCursor == count;
        if (complete) {
            treasuryQ = reserveResidualQ - lpAtomsAllocated * 1e18 + protocolFeeQ;
            protocolFeeQ = 0;
            outstandingReserveAtoms = lpAtomsAllocated;
            reserveVault.finish();
            claimsEnabled = true;
            if (outstandingReserveAtoms * 1e18 + treasuryQ + keeperPayableQ != allocationQ) {
                revert BadState();
            }
        }
    }

    function redeemReserve(address owner) external nonReentrant returns (uint256 atoms) {
        if (!claimsEnabled) revert BadState();
        atoms = reserveVault.consume(owner);
        outstandingReserveAtoms -= atoms;
        allocationQ -= atoms * 1e18;
        if (atoms != 0) collateralVault.escrow(owner, atoms);
    }

    function withdrawTreasury() external nonReentrant returns (uint256 atoms) {
        if (!claimsEnabled) revert BadState();
        atoms = treasuryQ / 1e18;
        treasuryQ -= atoms * 1e18;
        allocationQ -= atoms * 1e18;
        if (atoms != 0) collateralVault.escrow(treasury, atoms);
    }
}
