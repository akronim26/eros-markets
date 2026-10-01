// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {SnapshotLedger} from "./SnapshotLedger.sol";
import {SettlementMath as S} from "../math/SettlementMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract PayoutLedger is SnapshotLedger {
    bool public priceReady;
    uint256 public settlementPriceWad;
    bytes32 public finalityId;
    bool public payoutScanComplete;
    bool public recoveryRequired;
    bool public useRecovery;
    uint256 public payoutCursor;
    uint256 public allocationCursor;
    uint256 public totalRawClaimQ;
    uint256 public totalTraderAtoms;
    uint256 public ordinaryTraderAtoms;
    uint256 public availableTraderQ;
    uint256 public reserveResidualQ;
    mapping(address => uint256) public rawClaimQ;
    mapping(address => uint256) public traderAtoms;
    bool public payoutsAllocated;

    /// @notice B supplies an authenticated immutable price after its INVALID policy completes.
    function _acceptSettlementPrice(uint256 price, bytes32 id) internal returns (bool newlyAccepted) {
        if (!halted || price > 1e18 || id == bytes32(0)) revert BadState();
        if (priceReady) {
            if (price != settlementPriceWad || id != finalityId) revert BadState();
            return false;
        }
        settlementPriceWad = price;
        finalityId = id;
        priceReady = true;
        return true;
    }

    function _scanPayoutPage(uint8 maximum) internal returns (bool complete) {
        if (!snapshotComplete || !priceReady || maximum == 0 || maximum > 32) revert BadState();
        if (payoutScanComplete) return true;
        uint256 end = Q.min(payoutCursor + maximum, sweepCount);
        while (payoutCursor < end) {
            address owner = participants[payoutCursor++];
            uint256 raw = S.rawClaimQ(frozen[owner], settlementPriceWad);
            rawClaimQ[owner] = raw;
            totalRawClaimQ += raw;
            ordinaryTraderAtoms += raw / 1e18;
        }
        complete = payoutCursor == sweepCount;
        if (complete) {
            payoutScanComplete = true;
            _assessAvailable();
        }
    }

    function _assessAvailable() internal {
        availableTraderQ = frozenAllocationQ - frozenFeeQ;
        recoveryRequired = ordinaryTraderAtoms * 1e18 > availableTraderQ;
    }

    function _allocatePayoutPage(uint8 maximum) internal returns (bool complete) {
        if (!payoutScanComplete || maximum == 0 || maximum > 32 || (recoveryRequired && !useRecovery)) {
            revert BadState();
        }
        if (payoutsAllocated) return true;
        uint256 end = Q.min(allocationCursor + maximum, sweepCount);
        while (allocationCursor < end) {
            address owner = participants[allocationCursor++];
            uint256 atoms = useRecovery
                ? S.recoveryAtoms(rawClaimQ[owner], totalRawClaimQ, availableTraderQ)
                : rawClaimQ[owner] / 1e18;
            traderAtoms[owner] = atoms;
            totalTraderAtoms += atoms;
            allocationQ -= atoms * 1e18;
            if (atoms != 0) collateralVault.escrow(owner, atoms);
        }
        complete = allocationCursor == sweepCount;
        if (complete) {
            payoutsAllocated = true;
            reserveResidualQ = availableTraderQ - totalTraderAtoms * 1e18;
            emit ClaimsPrepared(totalTraderAtoms, reserveResidualQ);
        }
    }
}
