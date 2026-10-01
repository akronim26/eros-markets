// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FinalOutcome, ClearingPhase} from "../../provisional/MathTypes.sol";
import {SettlementView} from "../interfaces/IResolutionIngress.sol";
import {LifecycleMath} from "../math/LifecycleMath.sol";
import {InvalidPrice} from "./InvalidPrice.sol";

/// @title SettlementController
/// @notice Drives Person A's frozen snapshot and payout jobs (spec §8.5, DEC-07; B036) with
///         permissionless bounded calls, and reports a settlement status that keeps oracle
///         finality, price readiness, preparation and claim readiness distinct.
/// @dev The oracle callbacks (B034) do no account loop and no token transfer; all account work is
///      in these chunked jobs, which A makes idempotent (a retried chunk never charges twice).
///      Claims open only through `finishPreparation` with complete, reconciled liabilities;
///      oracle status alone never enables them.
abstract contract SettlementController is InvalidPrice {
    error NotHalted();
    error OutcomeOrPricePending();
    error PreparationIncomplete();
    error BadChunk();

    uint256 internal constant MAX_CHUNK = 32;

    JobProgress internal _snapJob;
    JobProgress internal _payJob;
    bool internal _claimsEnabled;
    bool internal _recoveryRequired;
    uint256 internal _totalPayoutAtoms;
    uint256 internal _reserveContributionAtoms;

    event SnapshotPreparationProgress(bytes32 indexed marketId, uint64 cursor, uint64 accountCount);
    event PayoutPreparationProgress(bytes32 indexed marketId, uint64 cursor, uint64 accountCount);
    event ClaimsEnabled(
        bytes32 indexed marketId,
        bytes32 snapshotId,
        FinalOutcome outcome,
        uint256 priceE18,
        uint256 totalTraderPayoutAtoms,
        uint256 reserveContributionAtoms
    );
    event RecoveryRequired(bytes32 indexed marketId, bytes32 snapshotId);

    function _claimsReady() internal view virtual override returns (bool) {
        return _claimsEnabled;
    }

    /// @notice Settlement price for the latched outcome: YES 1e18, NO 0, INVALID the captured
    ///         price. `ready` false while INVALID is still pending.
    function _settlementPrice() internal view returns (bool ready, uint256 priceE18) {
        if (_finalOutcome == FinalOutcome.YES) return (true, 1e18);
        if (_finalOutcome == FinalOutcome.NO) return (true, 0);
        if (_finalOutcome == FinalOutcome.INVALID && _invalidCaptured) return (true, _invalidPriceWad);
        return (false, 0);
    }

    /// @notice Materialize frozen account snapshots (may run before finality and before price).
    function prepareSnapshotChunk(uint256 maxAccounts) external returns (JobProgress memory p) {
        if (maxAccounts == 0 || maxAccounts > MAX_CHUNK) revert BadChunk();
        if (!_halt.halted) revert NotHalted();
        if (_snapJob.done) return _snapJob;
        p = _acctPrepareSnapshotChunk(maxAccounts);
        _snapJob = p;
        emit SnapshotPreparationProgress(_listing.marketId, p.cursor, p.count);
    }

    /// @notice Compute payouts only after finality and the required price exist.
    function preparePayoutChunk(uint256 maxAccounts) external returns (JobProgress memory p) {
        if (maxAccounts == 0 || maxAccounts > MAX_CHUNK) revert BadChunk();
        (bool ready, uint256 price) = _settlementPrice();
        if (!ready) revert OutcomeOrPricePending();
        if (!_snapJob.done) revert PreparationIncomplete();
        if (_payJob.done) return _payJob;
        p = _acctPreparePayoutChunk(maxAccounts, _finalOutcome, price);
        _payJob = p;
        emit PayoutPreparationProgress(_listing.marketId, p.cursor, p.count);
    }

    /// @notice Atomically enable claims once both jobs completed and A reconciled liabilities;
    ///         otherwise RECOVERY_REQUIRED with claims disabled (baseline: no haircut).
    function finishPreparation() external returns (bool claimsEnabled) {
        if (_claimsEnabled) return true;
        if (!_snapJob.done || !_payJob.done) revert PreparationIncomplete();
        FinishResult memory r = _acctFinishPreparation();
        (_recoveryRequired, _totalPayoutAtoms, _reserveContributionAtoms) =
        (r.recoveryRequired, r.totalTraderPayoutAtoms, r.reserveContributionAtoms);
        if (r.recoveryRequired || !r.claimsEnabled) {
            emit RecoveryRequired(_listing.marketId, _halt.snapshotId);
            return false;
        }
        _claimsEnabled = true;
        (, uint256 price) = _settlementPrice();
        emit ClaimsEnabled(
            _listing.marketId,
            _halt.snapshotId,
            _finalOutcome,
            price,
            r.totalTraderPayoutAtoms,
            r.reserveContributionAtoms
        );
        return true;
    }

    function _phase() internal view returns (ClearingPhase) {
        if (!_halt.halted) return ClearingPhase.LIVE;
        if (_claimsEnabled) return _acctClaimsComplete() ? ClearingPhase.COMPLETE : ClearingPhase.READY;
        if (_finalOutcome == FinalOutcome.UNSET) return ClearingPhase.HALTED;
        return ClearingPhase.PREPARING;
    }

    function getSettlementStatus() external view returns (SettlementView memory v) {
        v.phase = _phase();
        v.halted = _halt.halted;
        v.finalOutcome = _finalOutcome;
        v.oracleFinalityAccepted = _finalOutcome != FinalOutcome.UNSET;
        v.invalidPriceReady = _invalidCaptured;
        (bool ready, uint256 price) = _settlementPrice();
        v.settlementPriceE18 = ready ? price : 0;
        v.snapshotId = _halt.snapshotId;
        v.snapshotCursor = _snapJob.cursor;
        v.payoutCursor = _payJob.cursor;
        v.accountCount = _halt.frozenAccountCount;
        v.totalTraderPayoutAtoms = _totalPayoutAtoms;
        v.claimsEnabled = _claimsEnabled;
        v.accountingComplete = _snapJob.done && _payJob.done;
        v.recoveryRequired = _recoveryRequired;
    }

    /// @notice UI label: AWAITING_OUTCOME / ORACLE_FINAL_PRICE_PENDING / ORACLE_FINAL_PREPARING /
    ///         RECOVERY_REQUIRED / CLAIMABLE. CLAIMABLE only when claims are actually enabled.
    function claimsStatus() external view returns (LifecycleMath.ClaimsStatus) {
        (bool ready,) = _settlementPrice();
        LifecycleMath.ClaimsStatus s =
            LifecycleMath.claimsStatus(_finalOutcome, ready, _snapJob.done, _payJob.done, !_recoveryRequired);
        if (s == LifecycleMath.ClaimsStatus.CLAIMABLE && !_claimsEnabled) {
            return LifecycleMath.ClaimsStatus.ORACLE_FINAL_PREPARING;
        }
        return s;
    }
}
