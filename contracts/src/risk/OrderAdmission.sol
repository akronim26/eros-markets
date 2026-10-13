// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Stage, AccountingState, AdmissionMode, RejectCode} from "../math/RiskTypes.sol";
import {MathTypes} from "../math/MathTypes.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {LiquidationMath} from "../math/LiquidationMath.sol";
import {LifecycleMath} from "../math/LifecycleMath.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {MonitorPolicy} from "./MonitorPolicy.sol";
import {OrderRisk} from "./OrderRisk.sol";

/// @title OrderAdmission
/// @notice Maker/taker admission decisions (spec §7.3, §7.5; B023). Issues all-prefix taker
///         permits with the certified envelope and a bounded halving search, re-admits each maker
///         at the current mark after Person A touched it, preflights each paired fill, and keeps
///         reduction modes explicit.
/// @dev Decisions are views over the frozen RiskContext and Person A's current account/coverage
///      values, so previews (B026) run the same code as execution. The temporary taker commitment
///      lives in `_permit`, separate from resting sums, and is included in the account's
///      contribution while the action runs.
abstract contract OrderAdmission is MonitorPolicy, OrderRisk {
    uint256 internal constant MAX_HALVINGS = 64;

    struct TakerInput {
        uint32 trader;
        bool isBid;
        uint16 limitTick;
        uint64 requestedLots;
        bool reduceOnly;
    }

    struct TakerDecision {
        uint64 capLots;
        uint256 feeCapQ;
        AdmissionMode mode;
        RejectCode reason;
        uint64 reduceVersion;
        uint256 steps;
    }

    struct MakerDecision {
        bool prune;
        bool cancelAll; // account-specific risk failure: invalidate every resting commitment
        bool removeRemainder; // reduce-only exhausted after this fill
        RejectCode reason;
        uint64 allowedLots;
    }

    mapping(uint32 trader => OA.OrderSums) internal _permit;

    /// @dev Trading fee cap for `lots` at worst `tick` in Q. Zero in the initial profile (DEC-11);
    ///      Person A's FeeMath supplies the real value at merge (assumption S-8).
    function _feeCapQ(uint64, uint16) internal view virtual returns (uint256) {
        return 0;
    }

    function _pricing(RiskContext memory c) internal pure returns (OA.Pricing memory) {
        return OA.Pricing(c.markWad, c.secsToT, c.economicTime);
    }

    function _account(uint32 trader, uint64 atTime) internal view returns (OA.Account memory) {
        AccountView memory a = _acctPreviewAccount(trader, atTime);
        return OA.Account(a.cashQ, a.lots);
    }

    /// @notice Commitments the account would hold with `extra` added: resting + permit + extra.
    function _withExtra(uint32 trader, bool isBid, uint16 tick, uint64 lots, uint256 fee)
        internal
        view
        returns (OA.OrderSums memory s)
    {
        s = _combined(trader);
        if (lots != 0) s = OA.addOrder(s, isBid, lots, tick, fee);
    }

    function _combined(uint32 trader) internal view returns (OA.OrderSums memory s) {
        s = _resSums(trader);
        OA.OrderSums memory p = _permit[trader];
        if (p.bidLots != 0) {
            s.bidLots += p.bidLots;
            s.bidValueQ += p.bidValueQ;
            if (p.maxBidTick > s.maxBidTick) s.maxBidTick = p.maxBidTick;
        }
        if (p.askLots != 0) {
            s.askLots += p.askLots;
            s.askValueQ += p.askValueQ;
            if (p.minAskTick < s.minAskTick) s.minAskTick = p.minAskTick;
        }
        s.feeCapQ += p.feeCapQ;
    }

    // ------------------------------------------------------------------ gates shared with rests

    function _gate(RiskContext memory c, TakerInput memory t) internal view returns (RejectCode) {
        if (c.halted || c.stage == Stage.HALTED || c.stage == Stage.CLAIMS_READY) return RejectCode.HALTED;
        if (_acctAccountingState() != AccountingState.READY) return RejectCode.BAD_STAGE;
        if (c.stage == Stage.REDUCE_ONLY && !t.reduceOnly) return RejectCode.BAD_STAGE;
        if (t.limitTick < 1 || t.limitTick > 999) return RejectCode.INVALID_PRICE_OR_SIZE;
        if (t.requestedLots < _listing.minOrderLots) return RejectCode.BELOW_MIN_SIZE;
        if (t.requestedLots > _listing.maxOrderLots) return RejectCode.INVALID_PRICE_OR_SIZE;
        if (c.admission == LifecycleMath.Admission.NONE) return RejectCode.INVALID_PRICE_OR_SIZE;
        return RejectCode.NONE;
    }

    /// @notice True when only exactly backed commitments may be admitted now.
    function _backedOnly(RiskContext memory c) internal pure returns (bool) {
        return c.admission != LifecycleMath.Admission.LEVERAGED || c.fullBackingByTime;
    }

    // ------------------------------------------------------------------ taker

    function _takerDecision(RiskContext memory c, TakerInput memory t)
        internal
        view
        returns (TakerDecision memory d)
    {
        d.reason = _gate(c, t);
        if (d.reason != RejectCode.NONE) return d;
        AccountView memory acct = _acctPreviewAccount(t.trader, c.economicTime);
        uint64 want = t.requestedLots;
        if (t.reduceOnly) {
            want = uint64(OA.reduceOnlyCap(acct.lots, t.isBid, want));
            if (want == 0) {
                d.reason = RejectCode.NO_REDUCIBLE_POSITION;
                return d;
            }
            d.reduceVersion = acct.positionVersion;
            d.mode = AdmissionMode.VOLUNTARY_REDUCTION;
        }
        if (_backedOnly(c) && c.admission == LifecycleMath.Admission.BACKED_ONLY && !t.reduceOnly) {
            if (!_inBand(c, t.limitTick)) {
                d.reason = RejectCode.OUTSIDE_BAND;
                return d;
            }
        }
        (d.capLots, d.steps, d.reason) = _halve(c, t, want);
        if (d.capLots != 0) d.feeCapQ = _feeCapQ(d.capLots, t.limitTick);
    }

    /// @notice Index warm-up rest (Monad testnet BOOTSTRAP before the first complete INDEX
    ///         window): the ordinary exactly backed path, banded around the latest authenticated
    ///         INDEX point. The caller admits it only for an order that cannot match (POST_ONLY);
    ///         every fill still requires a valid INDEX window. Otherwise the ordinary decision.
    function _warmupRestDecision(RiskContext memory c, TakerInput memory t)
        internal
        view
        returns (TakerDecision memory d)
    {
        (bool warmup,) = _warmupIndexPoint(c);
        if (!warmup || t.reduceOnly || c.admission != LifecycleMath.Admission.NONE) {
            return _takerDecision(c, t);
        }
        c.admission = LifecycleMath.Admission.BACKED_ONLY;
        d = _takerDecision(c, t);
        c.admission = LifecycleMath.Admission.NONE;
    }

    function _inBand(RiskContext memory c, uint16 tick) internal view returns (bool) {
        (bool ok, uint256 centre) = _bandReference(c);
        if (!ok) return false;
        uint256 p = uint256(tick) * 1e15;
        uint256 band = _bootstrapBandWad;
        return p + band >= centre && p <= centre + band;
    }

    /// @dev Bounded halving: every returned cap passes the all-prefix predicate with the whole
    ///      commitment (resting + permit + candidate at the worst limit) included.
    function _halve(RiskContext memory c, TakerInput memory t, uint64 want)
        internal
        view
        returns (uint64 cap, uint256 steps, RejectCode reason)
    {
        cap = want;
        reason = RejectCode.BELOW_MIN_SIZE;
        while (cap != 0 && cap >= _listing.minOrderLots) {
            bool ok;
            (ok, reason) = _admitWith(c, t, cap);
            if (ok) return (cap, steps, RejectCode.NONE);
            if (steps == MAX_HALVINGS) break;
            cap /= 2;
            ++steps;
        }
        if (reason == RejectCode.NONE) reason = RejectCode.BELOW_MIN_SIZE;
        return (0, steps, reason);
    }

    function _admitWith(RiskContext memory c, TakerInput memory t, uint64 lots)
        internal
        view
        returns (bool ok, RejectCode reason)
    {
        OA.OrderSums memory trial =
            _withExtra(t.trader, t.isBid, t.limitTick, lots, _feeCapQ(lots, t.limitTick));
        OA.CoverageInput memory cov = _acctPreviewCoverage(t.trader, trial, 0, 0, c.economicTime);
        if (!cov.marketOk) return (false, RejectCode.MARKET_COVERAGE);
        if (t.reduceOnly) {
            // Reduction: never raise either endpoint deficit versus the current commitment set.
            OA.CoverageInput memory base =
                _acctPreviewCoverage(t.trader, _combined(t.trader), 0, 0, c.economicTime);
            if (cov.d0Q <= base.d0Q && cov.d1Q <= base.d1Q) return (true, RejectCode.NONE);
            return (false, RejectCode.TAKER_CAPACITY);
        }
        if (cov.d0Q > cov.deficitCapQ || cov.d1Q > cov.deficitCapQ) {
            return (false, RejectCode.ACCOUNT_DEFICIT_CAP);
        }
        if (_backedOnly(c)) {
            if (cov.d0Q == 0 && cov.d1Q == 0) return (true, RejectCode.NONE);
            return (false, RejectCode.TAKER_CAPACITY);
        }
        return OA.admit(
            _account(t.trader, c.economicTime), trial, _pricing(c), _effectiveParams(c.economicTime), cov
        );
    }

    // ------------------------------------------------------------------ permit bookkeeping

    function _permitReserve(uint32 trader, bool isBid, uint16 tick, uint64 lots, uint256 fee) internal {
        _permit[trader] = OA.addOrder(_permit[trader], isBid, lots, tick, fee);
        _acctReplaceContribution(trader, _combined(trader));
    }

    function _permitConsume(uint32 trader, bool isBid, uint16 tick, uint64 lots, uint256 fee) internal {
        _permit[trader] = OA.removeOrder(_permit[trader], isBid, lots, tick, fee);
    }

    function _permitRelease(uint32 trader) internal {
        delete _permit[trader];
        _acctReplaceContribution(trader, _resSums(trader));
    }

    // ------------------------------------------------------------------ maker readmission

    struct MakerInput {
        uint32 owner;
        bool isBid;
        uint64 marketEpoch;
        uint64 accountEpoch;
        bool reduceOnly;
        uint64 reduceVersion;
        uint64 proposed;
    }

    /// @notice Re-admit a maker at the current mark after A touched it (spec §7.5 steps 2–3).
    function _makerDecision(RiskContext memory c, MakerInput memory mi)
        internal
        view
        returns (MakerDecision memory d)
    {
        if (!_isCurrent(mi.owner, mi.marketEpoch, mi.accountEpoch)) {
            d.prune = true;
            d.reason = RejectCode.STALE_ORDER;
            return d;
        }
        if (c.stage == Stage.REDUCE_ONLY && !mi.reduceOnly) {
            d.prune = true;
            d.reason = RejectCode.BAD_STAGE;
            return d;
        }
        AccountView memory acct = _acctPreviewAccount(mi.owner, c.economicTime);
        if (mi.reduceOnly) return _reduceOnlyMaker(acct, mi);
        d.allowedLots = mi.proposed;
        OA.OrderSums memory rest = _resSums(mi.owner);
        OA.CoverageInput memory cov = _acctPreviewCoverage(mi.owner, rest, 0, 0, c.economicTime);
        if (_backedOnly(c)) {
            if (cov.d0Q != 0 || cov.d1Q != 0) {
                (d.prune, d.cancelAll, d.reason) = (true, true, RejectCode.MAKER_BELOW_IM);
            }
            return d;
        }
        if (_belowMm(c, acct)) {
            (d.prune, d.cancelAll, d.reason) = (true, true, RejectCode.MAKER_BELOW_MM);
            return d;
        }
        // Maker readmission judges only the maker's own margin and per-account cap. A global
        // reserve shortfall is not the maker's fault: the fill preflight stops the taker instead.
        if (cov.d0Q > cov.deficitCapQ || cov.d1Q > cov.deficitCapQ) {
            (d.prune, d.cancelAll, d.reason) = (true, true, RejectCode.ACCOUNT_DEFICIT_CAP);
            return d;
        }
        cov.marketOk = true;
        (bool ok,) = OA.admit(
            OA.Account(acct.cashQ, acct.lots), rest, _pricing(c), _effectiveParams(c.economicTime), cov
        );
        if (!ok) (d.prune, d.cancelAll, d.reason) = (true, true, RejectCode.MAKER_BELOW_IM);
    }

    function _reduceOnlyMaker(AccountView memory acct, MakerInput memory mi)
        internal
        pure
        returns (MakerDecision memory d)
    {
        if (mi.reduceVersion != acct.positionVersion) {
            d.prune = true;
            d.reason = RejectCode.STALE_ORDER;
            return d;
        }
        uint64 cap = uint64(OA.reduceOnlyCap(acct.lots, mi.isBid, mi.proposed));
        if (cap == 0) {
            d.prune = true;
            d.reason = RejectCode.NO_REDUCIBLE_POSITION;
            return d;
        }
        d.allowedLots = cap;
        d.removeRemainder = uint256(cap) == _absLots(acct.lots);
    }

    function _belowMm(RiskContext memory c, AccountView memory acct) internal view returns (bool) {
        if (acct.lots == 0) return false;
        MarginMath.Margin memory m = MarginMath.sideMargin(
            _absLots(acct.lots),
            acct.lots > 0,
            c.markWad,
            c.secsToT,
            c.economicTime,
            _effectiveParams(c.economicTime)
        );
        MarginMath.Status st = MarginMath.health(acct.cashQ, acct.lots, c.markWad, m).status;
        return st == MarginMath.Status.BELOW_MM || st == MarginMath.Status.NONPOSITIVE;
    }

    function _absLots(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function _voluntaryReductionAllowed(
        uint32 trader,
        bool buys,
        uint64 lots,
        uint16 tick,
        uint256 feeQ,
        RiskContext memory context
    ) internal view returns (bool) {
        AccountView memory accountBefore = _acctAccount(trader);
        int256 lotChange = buys ? int256(uint256(lots)) : -int256(uint256(lots));
        int256 cashChange = int256(uint256(lots) * tick * 1e18);
        int256 cashAfter = accountBefore.cashQ + (buys ? -cashChange : cashChange) - int256(feeQ);
        int256 lotsAfter = accountBefore.lots + lotChange;
        if (_absLots(lotsAfter) >= _absLots(accountBefore.lots)) return false;
        if (lotsAfter != 0 && (lotsAfter > 0) != (accountBefore.lots > 0)) return false;
        if (!context.markOk) {
            (int256 endpointNo, int256 endpointYes) = MarginMath.endpoints(cashAfter, lotsAfter);
            return endpointNo >= 0 && endpointYes >= 0;
        }
        return LiquidationMath.allowedReduction(
            _snapAt(accountBefore.cashQ, accountBefore.lots, context), _snapAt(cashAfter, lotsAfter, context)
        );
    }

    function _snapAt(int256 cashQ, int256 lots, RiskContext memory context)
        internal
        view
        returns (LiquidationMath.Snap memory snapshot)
    {
        snapshot.xLots = lots;
        (snapshot.e0Q, snapshot.e1Q) = MarginMath.endpoints(cashQ, lots);
        snapshot.emQ = MarginMath.markEquityQ(cashQ, lots, context.markWad);
        if (lots != 0) {
            snapshot.mmQ =
            MarginMath.sideMargin(
                _absLots(lots),
                lots > 0,
                context.markWad,
                context.secsToT,
                context.economicTime,
                _effectiveParams(context.economicTime)
            )
            .mmQ;
        }
    }

    // ------------------------------------------------------------------ fill preflight

    struct FillPlan {
        uint32 taker;
        uint32 maker;
        bool takerBuys;
        uint16 makerTick;
        uint64 lots;
        uint256 takerFeeQ;
        uint256 makerFeeQ;
        uint16 permitTick; // taker worst limit (permit reservation tick)
        uint256 takerPermitFeeUsedQ;
        uint256 makerFeeCapUsedQ;
    }

    /// @notice Preflight both accounts after the candidate fill using A's coverage values.
    ///         `makerCapOk` is the maker's account-specific test (per-account deficit cap) -> a
    ///         failure prunes the maker. `takerCapOk` and `marketOk` (both reserve inequalities)
    ///         failing stop the taker; a valid maker is never cancelled for a global shortfall.
    function _preflight(FillPlan memory f)
        internal
        view
        returns (bool takerCapOk, bool makerCapOk, bool marketOk)
    {
        return _preflight(f, false, false);
    }

    function _preflight(FillPlan memory f, bool takerReduces, bool makerReduces)
        internal
        view
        returns (bool takerCapOk, bool makerCapOk, bool marketOk)
    {
        int256 notional = int256(uint256(f.lots) * f.makerTick * 1e18);
        int256 dx = f.takerBuys ? int256(uint256(f.lots)) : -int256(uint256(f.lots));
        OA.OrderSums memory ts = _combined(f.taker);
        ts = OA.removeOrder(ts, f.takerBuys, f.lots, f.permitTick, f.takerPermitFeeUsedQ);
        OA.CoverageInput memory tc =
            _acctCoverage(f.taker, ts, (f.takerBuys ? -notional : notional) - int256(f.takerFeeQ), dx);
        OA.OrderSums memory ms =
            OA.removeOrder(_resSums(f.maker), !f.takerBuys, f.lots, f.makerTick, f.makerFeeCapUsedQ);
        OA.CoverageInput memory mc =
            _acctCoverage(f.maker, ms, (f.takerBuys ? notional : -notional) - int256(f.makerFeeQ), -dx);
        takerCapOk = _withinCapOrReducing(f.taker, _combined(f.taker), tc, takerReduces);
        makerCapOk = _withinCapOrReducing(f.maker, _resSums(f.maker), mc, makerReduces);
        marketOk = tc.marketOk && mc.marketOk;
    }

    function _withinCapOrReducing(
        uint32 trader,
        OA.OrderSums memory sums,
        OA.CoverageInput memory afterCoverage,
        bool reduces
    ) private view returns (bool) {
        if (!reduces) {
            return afterCoverage.d0Q <= afterCoverage.deficitCapQ
                && afterCoverage.d1Q <= afterCoverage.deficitCapQ;
        }
        OA.CoverageInput memory beforeCoverage = _acctCoverage(trader, sums, 0, 0);
        return afterCoverage.d0Q <= beforeCoverage.d0Q && afterCoverage.d1Q <= beforeCoverage.d1Q;
    }
}
