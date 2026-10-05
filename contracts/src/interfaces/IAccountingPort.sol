// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccountingState} from "../math/RiskTypes.sol";
import {MathTypes} from "../math/MathTypes.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";

/// @title IAccountingPort
/// @notice Person B's internal view of the accounting layer: the calls B's risk, liquidation and
///         settlement controllers make. In the composed engine it is implemented on Person A's
///         real modules by `src/engine/RiskAccountingBridge.sol` (every posting stays in A's
///         functions). B unit tests use the scripted `test/mocks/B/MockAccountingPort.sol`.
///         Shape reconciled with A at integration: docs/merge/interface-reconciliation.md.
/// @dev Units: cash and fees in Q (1e18 per atom), positions in lots, times in seconds. Trader ids
///      are uint32; in the composed engine id = Person A registry index + 1.
abstract contract IAccountingPort {
    struct AccountView {
        int256 cashQ; // settled at the current action cutoff
        int256 lots;
        uint64 orderEpoch; // account order epoch (A storage)
        uint64 positionVersion; // bumps on every sign transition incl. to/from zero
        bool registered;
    }

    struct AccrualView {
        uint64 cutoff; // legal economic cutoff used by every touch in this action
        uint64 accountingEpochId;
        int256 fundingIndex;
        AccountingState state; // READY / ROLLOVER_SWEEP / FLOOR_SWEEP / HALT_SWEEP
        bytes32 premiumTariffHash;
        uint64 marketOrderEpoch;
    }

    struct FillDelta {
        uint32 maker;
        uint32 taker;
        bool takerBuys;
        uint64 lots;
        uint16 tick; // maker tick
        uint256 makerFeeQ;
        uint256 takerFeeQ;
    }

    struct TakeoverAuth {
        uint32 trader;
        uint8 predicate; // 1 fresh E <= 0, 2 floor endpoint deficit, 3 both endpoints <= 0
        uint64 cutoff;
        uint64 riskVersion;
    }

    struct FreezeResult {
        uint64 frozenAccountCount;
        uint64 frozenBookEpoch;
        uint256 oiHaltLots;
        int256 fundingIndexAtHalt;
        uint64 accountingEpochAtHalt;
        uint64 accrualCutoff;
        bytes32 premiumTariffHash;
        bytes32 frozenAccountingState;
    }

    struct JobProgress {
        uint64 cursor;
        uint64 count;
        bool done;
    }

    struct FinishResult {
        bool claimsEnabled;
        bool recoveryRequired;
        uint256 totalTraderPayoutAtoms;
        uint256 reserveContributionAtoms;
    }

    // ---------------------------------------------------------------- trading (A021/A024/A026)

    function _acctBeginAction() internal virtual returns (AccrualView memory);

    function _acctTouch(uint32 trader) internal virtual;

    function _acctAccount(uint32 trader) internal view virtual returns (AccountView memory);

    function _acctPreviewAccount(uint32 trader, uint64) internal view virtual returns (AccountView memory) {
        return _acctAccount(trader);
    }

    /// @dev A's order-aware endpoint deficits (incl. fee caps), per-account cap and both reserve
    ///      inequalities for the account at its current state plus (dCashQ, dLots), with `sums` as
    ///      its reservation set (resting + any permit), after replacing its contribution.
    function _acctCoverage(uint32 trader, OA.OrderSums memory sums, int256 dCashQ, int256 dLots)
        internal
        view
        virtual
        returns (OA.CoverageInput memory);

    function _acctPreviewCoverage(
        uint32 trader,
        OA.OrderSums memory sums,
        int256 dCashQ,
        int256 dLots,
        uint64
    ) internal view virtual returns (OA.CoverageInput memory) {
        return _acctCoverage(trader, sums, dCashQ, dLots);
    }

    function _acctReplaceContribution(uint32 trader, OA.OrderSums memory sums) internal virtual;

    function _acctPostFill(FillDelta memory d) internal virtual;

    function _acctAccountingState() internal view virtual returns (AccountingState);

    function _acctBumpAccountOrderEpoch(uint32 trader) internal virtual returns (uint64 newEpoch);

    function _acctBumpMarketOrderEpoch() internal virtual returns (uint64 newEpoch);

    /// @dev Current market order epoch (A storage; bumped by stage/rollover invalidation).
    function _acctMarketOrderEpoch() internal view virtual returns (uint64);

    /// @dev Projected (unmaterialized) funding debit and premium owed at `atTime` for previews.
    ///      Positive fundingQ = the account pays. View only: never an authorization.
    function _acctProjectedAccrual(uint32 trader, uint64 atTime)
        internal
        view
        virtual
        returns (int256 fundingQ, uint256 premiumQ);

    // ---------------------------------------------------------------- liquidation (A028–A031)

    function _acctTakeover(TakeoverAuth memory auth) internal virtual;

    /// @dev Book-close (forced IOC) fill: the taker is the liquidated account. A posts the fill and
    ///      then charges its own liquidation fee only if a fee <= `allowedFeeQ` keeps the reduction
    ///      predicate; returns the fee actually charged (A029 `_chargeCloseFee`).
    function _acctPostLiquidationFill(FillDelta memory d, uint256 allowedFeeQ, address keeper)
        internal
        virtual
        returns (uint256 chargedFeeQ);

    /// @dev Pair reduction between two eligible accounts at one common tick. `d.takerFeeQ` and
    ///      `d.makerFeeQ` are B's allowed fee per side; A charges its fee on both sides only if
    ///      both are within B's allowance, else none (A029 `_liquidationPair`). Returns total charged.
    function _acctPostPairLiquidation(FillDelta memory d, address keeper)
        internal
        virtual
        returns (uint256 chargedFeeQ);

    /// @dev Begin the bounded backing-floor sweep (A031 `_beginFloor`): stops funding, bumps the
    ///      market order epoch, freezes the participant count and pauses live mutations.
    function _acctFloorBegin() internal virtual returns (uint64 frozenCount);

    /// @dev One page (<= 32 accounts) of A's floor sweep: touch at the floor cutoff and take over
    ///      any account with a negative endpoint (price-free predicate 2). `p.done` once every
    ///      frozen participant was visited; A then marks the market reconciled and READY.
    function _acctFloorPage(uint256 maxAccounts)
        internal
        virtual
        returns (JobProgress memory p, uint64 takeovers);

    function _acctAccountCount() internal view virtual returns (uint64);

    // ---------------------------------------------------------------- settlement (A030, A034–A036)

    function _acctFreeze(uint64 economicHaltAt, uint64 accrualCutoff)
        internal
        virtual
        returns (FreezeResult memory);

    function _acctPrepareSnapshotChunk(uint256 maxAccounts) internal virtual returns (JobProgress memory);

    function _acctPreparePayoutChunk(uint256 maxAccounts, MathTypes.FinalOutcome outcome, uint256 priceWad)
        internal
        virtual
        returns (JobProgress memory);

    function _acctFinishPreparation() internal virtual returns (FinishResult memory);

    /// @notice Exact negative trader equity at the final price, available after the payout scan.
    function _acctTotalDeficitQ() internal view virtual returns (uint256);

    /// @dev Active accounting epoch end and any already-frozen rollover cutoff (0 = none), so the
    ///      halt can use accrualCutoff = min(economicHaltAt, end, frozen) (A025/A030).
    function _acctEpochBounds()
        internal
        view
        virtual
        returns (uint64 activeEpochEnd, uint64 frozenRolloverCutoff);

    /// @dev True once every prepared entitlement has been claimed (A037) -> ClearingPhase.COMPLETE.
    function _acctClaimsComplete() internal view virtual returns (bool);

    /// @dev True once any cash claim was paid (A037); conversion can never start afterwards.
    function _acctAnyCashClaim() internal view virtual returns (bool);

    /// @dev True iff every frozen account incl. the reserve is fully backed at the halt snapshot (A034).
    function _acctAllFullyBackedAtHalt() internal view virtual returns (bool);
}
