// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccountingState, RejectCode} from "../../provisional/MathTypes.sol";
import {LiquidationMath as LM} from "../math/LiquidationMath.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {LiquidationBookAdapter} from "./LiquidationBookAdapter.sol";

/// @title RiskLiquidation
/// @notice Permissionless `liquidate(account, maxLots, maxExaminations, partner)` (spec §5.2;
///         B032). Order: derive stage, touch at the legal cutoff, judge eligibility, and only
///         then cancel commitments; takeover, optional single-partner pair reduction, then a
///         bounded book close. Every cash/position movement is a Person A posting; B only
///         decides and carries the exact authorized predicate and cutoff.
/// @dev No arbitrary price, no unbounded search, no reward for a no-effect call, no ordinary
///      liquidation inside a frozen sweep or after the halt.
abstract contract RiskLiquidation is LiquidationBookAdapter {
    struct LiquidationResult {
        LM.Result result;
        LM.Mode mode;
        uint8 takeoverPredicate;
        uint64 pairedLots;
        uint64 bookLots;
        int256 lotsAfter;
        uint64 cutoff;
        RejectCode reason;
    }

    event LiquidationOutcome(
        uint32 indexed trader,
        address indexed keeper,
        LM.Mode mode,
        LM.Result result,
        uint8 takeoverPredicate,
        uint64 pairedLots,
        uint64 bookLots,
        uint64 cutoff
    );

    function liquidate(uint32 trader, uint64 maxLots, uint16 maxExaminations, uint32 partner)
        external
        returns (LiquidationResult memory r)
    {
        if (maxLots == 0 || maxExaminations == 0 || maxExaminations > MAX_EXAMINED) {
            revert BadWorkBudget();
        }
        RiskSnapshot memory snap = _riskBeginAction();
        RiskContext memory c = _actionCtx;
        r.cutoff = snap.premiumCutoff;
        if (c.halted) return _out(trader, r, RejectCode.HALTED);
        if (_acctAccountingState() != AccountingState.READY) return _out(trader, r, RejectCode.BAD_STAGE);
        _touch(trader);
        Eligibility memory el = _eligibility(trader, c);
        r.mode = el.mode;
        if (el.mode == LM.Mode.NONE) return _out(trader, r, RejectCode.NONE); // no cancel, no reward
        _resCancelAll(trader); // commitments first, only once eligible
        if (el.mode == LM.Mode.TAKEOVER) {
            _takeover(trader, el.takeoverPredicate, snap, r);
            return _out(trader, r, RejectCode.NONE);
        }
        uint64 budget = maxLots;
        if (partner != 0) {
            PairResult memory pr = _pairReduce(trader, partner, budget, c, msg.sender);
            r.pairedLots = pr.lots;
            budget -= pr.lots;
        }
        r.result = budget == 0 ? _continuation(trader, c) : LM.Result.NEEDS_MORE_WORK;
        if (budget != 0 && r.result != LM.Result.DONE) {
            CloseOutcome memory o = _bookClose(trader, budget, maxExaminations, c, msg.sender);
            r.bookLots = o.closedLots;
            r.result = o.result;
        } else if (r.pairedLots != 0) {
            r.result = _continuation(trader, c);
        }
        if (r.result == LM.Result.TAKEOVER_AUTHORIZED) {
            // fresh mark equity reached <= 0 during the reduction: terminal takeover branch
            _takeover(trader, PRED_FRESH_NONPOSITIVE, snap, r);
        }
        return _out(trader, r, RejectCode.NONE);
    }

    function _takeover(uint32 trader, uint8 predicate, RiskSnapshot memory snap, LiquidationResult memory r)
        internal
    {
        _acctTakeover(TakeoverAuth(trader, predicate, snap.premiumCutoff, snap.riskVersion));
        r.takeoverPredicate = predicate;
        r.result = LM.Result.TAKEOVER_AUTHORIZED;
        r.mode = LM.Mode.TAKEOVER;
    }

    function _out(uint32 trader, LiquidationResult memory r, RejectCode reason)
        internal
        returns (LiquidationResult memory)
    {
        r.reason = reason;
        r.lotsAfter = _acctAccount(trader).lots;
        emit LiquidationOutcome(
            trader, msg.sender, r.mode, r.result, r.takeoverPredicate, r.pairedLots, r.bookLots, r.cutoff
        );
        return r;
    }
}
