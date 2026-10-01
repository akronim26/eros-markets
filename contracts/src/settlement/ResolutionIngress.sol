// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FinalOutcome} from "../../provisional/MathTypes.sol";
import {IResolutionEngine, HaltView} from "../interfaces/IResolutionIngress.sol";
import {LifecycleMath} from "../math/LifecycleMath.sol";
import {RiskView} from "../risk/RiskView.sol";

/// @title ResolutionIngress
/// @notice Authenticated, immutable finality ingress (spec §8.1–8.3, §8.5, DEC-07; B034).
///         Only the pinned ResolutionOracle may halt early or deliver `settle(Y)` (Y = 0 NO,
///         1 YES) / `settleInvalid()`. Anyone may materialize the scheduled halt at/after T.
///         The halt and the outcome latch are once-only and constant work: no account loop, no
///         token transfer, no TWAP requirement, no callback.
/// @dev Economic halt time is T for a scheduled halt (even if the keeper is late) and the
///      oracle transaction time for an accepted early halt. Accrual cutoff is
///      min(economicHaltAt, active epoch end, frozen rollover cutoff). A conflicting outcome
///      reverts, so an oracle Final transition in the same transaction rolls back rather than
///      silently dropping a failed delivery.
abstract contract ResolutionIngress is RiskView, IResolutionEngine {
    error ScheduledHaltNotYet();

    HaltView internal _halt;
    FinalOutcome internal _finalOutcome;
    uint64 internal _earlyHalt; // 0 = none
    uint64 internal _finalityAcceptedAt;

    event MarketHalted(
        bytes32 indexed marketId,
        bytes32 snapshotId,
        uint64 economicHaltAt,
        uint64 haltRecordedAt,
        uint256 oiHaltLots,
        uint64 frozenAccountCount,
        uint64 frozenBookEpoch
    );
    event OracleFinalityAccepted(bytes32 indexed marketId, bytes32 snapshotId, FinalOutcome outcome);

    function _earlyHaltAt() internal view virtual override returns (uint64) {
        return _earlyHalt;
    }

    // ------------------------------------------------------------------ oracle entry points

    function halt() external returns (HaltView memory) {
        _onlyResolutionAuthority();
        _materializeHalt(true);
        return _halt;
    }

    function materializeScheduledHalt() external returns (HaltView memory) {
        if (block.timestamp < _scheduledT) revert ScheduledHaltNotYet();
        _materializeHalt(false);
        return _halt;
    }

    function settle(uint8 Y) external returns (bool newlyAccepted) {
        _onlyResolutionAuthority();
        return _acceptFinality(LifecycleMath.outcomeFromY(Y));
    }

    function settleInvalid() external returns (bool newlyAccepted) {
        _onlyResolutionAuthority();
        return _acceptFinality(FinalOutcome.INVALID);
    }

    function getHaltSnapshot() external view returns (HaltView memory) {
        return _halt;
    }

    // ------------------------------------------------------------------ internals

    function _acceptFinality(FinalOutcome o) internal returns (bool newlyAccepted) {
        _materializeHalt(true); // no-op if already halted; else the oracle's halt routine
        (_finalOutcome, newlyAccepted) = LifecycleMath.acceptFinality(_finalOutcome, o);
        if (newlyAccepted) {
            _finalityAcceptedAt = uint64(block.timestamp);
            emit OracleFinalityAccepted(_listing.marketId, _halt.snapshotId, o);
        }
    }

    /// @dev Idempotent constant-size freeze. `byOracle` before T is an early halt at block time.
    function _materializeHalt(bool byOracle) internal {
        if (_halt.halted) return;
        uint64 nowTs = uint64(block.timestamp);
        if (byOracle && nowTs < _scheduledT) _earlyHalt = nowTs;
        uint64 haltAt = uint64(LifecycleMath.economicHaltAt(_scheduledT, _earlyHalt));
        (uint64 epochEnd, uint64 frozenRoll) = _acctEpochBounds();
        uint64 cutoff = uint64(LifecycleMath.accrualCutoff(haltAt, epochEnd, frozenRoll));
        uint64 bookEpoch = _invalidateMarketOrders();
        FreezeResult memory f = _acctFreeze(haltAt, cutoff);
        HaltView storage h = _halt;
        h.halted = true;
        h.economicHaltAt = haltAt;
        h.haltRecordedAt = nowTs;
        h.frozenAccountCount = f.frozenAccountCount;
        h.frozenBookEpoch = bookEpoch;
        h.oiHaltLots = f.oiHaltLots;
        h.fundingIndexAtHalt = f.fundingIndexAtHalt;
        h.accountingEpochAtHalt = f.accountingEpochAtHalt;
        h.accrualCutoff = cutoff;
        h.premiumTariffHash = f.premiumTariffHash;
        h.snapshotId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                _listing.marketId,
                haltAt,
                cutoff,
                f.frozenAccountCount,
                bookEpoch,
                f.frozenAccountingState,
                f.oiHaltLots
            )
        );
        emit MarketHalted(
            _listing.marketId, h.snapshotId, haltAt, nowTs, f.oiHaltLots, f.frozenAccountCount, bookEpoch
        );
    }

    function finalOutcome() external view returns (FinalOutcome) {
        return _finalOutcome;
    }
}
