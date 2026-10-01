// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccountingState, FinalOutcome} from "./MathTypes.sol";
import {OrderAdmissionMath as OA} from "../src/math/OrderAdmissionMath.sol";

/// @title IAccountingPort (PROVISIONAL B-lane stand-in)
/// @notice B's guess of the internal accounting port Person A freezes at G2/G3 (A021
///         `AccountingPort.sol`), extended with the liquidation (A028–A031) and settlement
///         (A030, A034–A036) job ports B's controllers drive. Every function here is implemented by
///         Person A in the real engine; B only calls them. Listed one by one in
///         docs/merge/B-assumptions.md (S-5). Delete at merge and adapt B call sites to A's names.
/// @dev Units: cash and fees in Q (1e18 per atom), positions in lots, times in seconds.
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

    /// @dev A's order-aware endpoint deficits (incl. fee caps), per-account cap and both reserve
    ///      inequalities for the account at its current state plus (dCashQ, dLots), with `sums` as
    ///      its reservation set (resting + any permit), after replacing its contribution.
    function _acctCoverage(uint32 trader, OA.OrderSums memory sums, int256 dCashQ, int256 dLots)
        internal
        view
        virtual
        returns (OA.CoverageInput memory);

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

    function _acctPostLiquidationFill(FillDelta memory d, uint256 liquidationFeeQ, address keeper)
        internal
        virtual;

    function _acctFloorBegin() internal virtual returns (uint64 frozenCount);

    function _acctFloorTraderAt(uint64 index) internal view virtual returns (uint32 trader);

    function _acctFloorComplete() internal virtual;

    function _acctAccountCount() internal view virtual returns (uint64);

    // ---------------------------------------------------------------- settlement (A030, A034–A036)

    function _acctFreeze(uint64 economicHaltAt, uint64 accrualCutoff)
        internal
        virtual
        returns (FreezeResult memory);

    function _acctPrepareSnapshotChunk(uint256 maxAccounts) internal virtual returns (JobProgress memory);

    function _acctPreparePayoutChunk(uint256 maxAccounts, FinalOutcome outcome, uint256 priceWad)
        internal
        virtual
        returns (JobProgress memory);

    function _acctFinishPreparation() internal virtual returns (FinishResult memory);

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
