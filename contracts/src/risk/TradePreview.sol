// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Stage, PricingMode, AccountingState, AdmissionMode, RejectCode} from "../math/RiskTypes.sol";
import {MathTypes} from "../math/MathTypes.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {OrderLifecycle} from "./OrderLifecycle.sol";

/// @title TradePreview
/// @notice Authoritative, unit-tagged order/account/release previews (spec §5.4; B026). Previews
///         run the same decision code as execution (`_takerDecision`, `_riskReleaseDecision`) over
///         the context of the current block, so at the same immutable context the accepted cap and
///         required collateral agree with execution. A preview never creates a funding
///         authorization and never mutates state.
/// @dev Units are carried in field-name suffixes: Q (1e18 per atom), Atoms, Lots, Wad, seconds.
///      Unavailable prices are flagged (`markAvailable == false`), never reported as 0.
///      Projected funding/premium are labelled estimates, not withdrawable amounts.
abstract contract TradePreview is OrderLifecycle {
    uint8 public constant PREVIEW_UNITS_VERSION = 1;

    struct PreviewIdentity {
        uint64 asOfTime; // block timestamp the preview was computed at
        uint64 riskVersion;
        bytes32 profileHash;
        uint64 marketOrderEpoch;
        Stage stage;
        PricingMode pricingMode;
        AccountingState accountingState;
        bool indexAvailable;
        uint256 indexWad;
        bool markAvailable;
        uint256 markWad;
    }

    struct OrderPreview {
        PreviewIdentity id;
        RejectCode rejection;
        uint64 acceptedCapLots;
        uint256 feeCapQ;
        AdmissionMode mode;
        bool fullBackingRequired;
        int256 eMinQ; // marked-equity lower bound with the accepted cap included
        uint256 requiredImQ; // IM envelope with the accepted cap included (0 when fully backed)
        uint256 d0AfterQ;
        uint256 d1AfterQ;
        bool marketCoverageAfter;
        uint256 halvingSteps;
    }

    struct AccountPreview {
        PreviewIdentity id;
        int256 cashQ;
        int256 positionLots;
        int256 projectedFundingQ; // estimate; positive = the account pays
        uint256 projectedPremiumQ; // estimate
        bool projectionsAreEstimates;
        int256 e0Q;
        int256 e1Q;
        int256 markEquityQ; // meaningful only when id.markAvailable
        uint256 mmQ;
        uint256 imQ;
        bool fullBackingRequired;
        MarginMath.Status status;
        OA.OrderSums orders;
        uint256 usableReleaseAtoms;
    }

    function _identity(RiskContext memory c) internal view returns (PreviewIdentity memory id) {
        id.asOfTime = c.economicTime;
        id.riskVersion = c.riskVersion;
        id.profileHash = c.profileHash;
        id.marketOrderEpoch = _acctMarketOrderEpoch();
        id.stage = c.stage;
        id.pricingMode = c.pricingMode;
        id.accountingState = _acctAccountingState();
        id.indexAvailable = c.indexOk;
        id.indexWad = c.indexWad;
        id.markAvailable = c.markOk;
        id.markWad = c.markWad;
    }

    /// @notice Same decision as `_riskPrepareTaker` at this block's context.
    function previewOrder(uint32 trader, MathTypes.Side side, uint16 limitTick, uint64 lots, bool reduceOnly)
        external
        view
        returns (OrderPreview memory p)
    {
        RiskContext memory c = _riskContext();
        p.id = _identity(c);
        TakerInput memory t = TakerInput(trader, side == MathTypes.Side.BUY, limitTick, lots, reduceOnly);
        TakerDecision memory d = _takerDecision(c, t);
        (p.rejection, p.acceptedCapLots, p.feeCapQ, p.mode, p.halvingSteps) =
            (d.reason, d.capLots, d.feeCapQ, d.mode, d.steps);
        if (d.capLots == 0) return p;
        OA.OrderSums memory s = _withExtra(trader, t.isBid, limitTick, d.capLots, d.feeCapQ);
        OA.CoverageInput memory cov = _acctCoverage(trader, s, 0, 0);
        (p.d0AfterQ, p.d1AfterQ, p.marketCoverageAfter) = (cov.d0Q, cov.d1Q, cov.marketOk);
        p.fullBackingRequired = _backedOnly(c) || reduceOnly;
        if (c.markOk) {
            OA.Account memory a = _account(trader);
            p.eMinQ = OA.eMinQ(a.cashQ, a.lots, c.markWad, s);
            (uint256 im, bool full) = OA.imUpperQ(a.lots, s, _pricing(c), _effectiveParams(c.economicTime));
            p.requiredImQ = im;
            p.fullBackingRequired = p.fullBackingRequired || full;
        }
    }

    function previewAccount(uint32 trader) external view returns (AccountPreview memory p) {
        RiskContext memory c = _riskContext();
        p.id = _identity(c);
        AccountView memory a = _acctAccount(trader);
        (p.cashQ, p.positionLots) = (a.cashQ, a.lots);
        (p.projectedFundingQ, p.projectedPremiumQ) = _acctProjectedAccrual(trader, c.economicTime);
        p.projectionsAreEstimates = true;
        (p.e0Q, p.e1Q) = MarginMath.endpoints(a.cashQ, a.lots);
        p.orders = _resSums(trader);
        if (c.markOk && a.lots != 0) {
            MarginMath.Margin memory m = MarginMath.sideMargin(
                _absLots(a.lots),
                a.lots > 0,
                c.markWad,
                c.secsToT,
                c.economicTime,
                _effectiveParams(c.economicTime)
            );
            MarginMath.Health memory h = MarginMath.health(a.cashQ, a.lots, c.markWad, m);
            (p.markEquityQ, p.mmQ, p.imQ, p.fullBackingRequired, p.status) =
                (h.markEquityQ, h.mmQ, h.imQ, h.fullBacking, h.status);
        } else if (c.markOk) {
            p.markEquityQ = a.cashQ;
            p.status = a.cashQ >= 0 ? MarginMath.Status.FLAT : MarginMath.Status.NONPOSITIVE;
        }
        p.usableReleaseAtoms = _usableReleaseAtoms(trader, a);
    }

    /// @notice Same decision as the guarded release (A017 -> `_riskReleaseDecision`).
    function previewRelease(uint32 trader, uint256 atoms)
        external
        view
        returns (bool ok, RejectCode reason)
    {
        return _releaseDecision(trader, _acctAccount(trader), atoms);
    }

    function _releaseDecision(uint32 trader, AccountView memory a, uint256 atoms)
        internal
        view
        returns (bool, RejectCode)
    {
        if (_acctAccountingState() != AccountingState.READY) return (false, RejectCode.BAD_STAGE);
        int256 dCash = -int256(atoms * 1e18);
        OA.OrderSums memory s = _resSums(trader);
        return
            _riskReleaseDecision(ReleaseInput(a.cashQ + dCash, a.lots, s, _acctCoverage(trader, s, dCash, 0)));
    }

    /// @dev Largest whole-atom release that passes the same decision (bounded binary search).
    function _usableReleaseAtoms(uint32 trader, AccountView memory a) internal view returns (uint256 best) {
        if (a.cashQ <= 0) return 0;
        uint256 hi = uint256(a.cashQ) / 1e18; // atoms floor: fractional Q is never released
        uint256 lo;
        for (uint256 i; i < 96 && lo < hi; ++i) {
            uint256 mid = (lo + hi + 1) / 2;
            (bool ok,) = _releaseDecision(trader, a, mid);
            if (ok) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }
}
