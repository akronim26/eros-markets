// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {AdmissionMode, StepStatus, RejectCode, RemovalReason} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";

/// @title MockBookAdapter (B020)
/// @notice Tiny deterministic mock book for Risk tests (spec §7.8): ordered `OrderView` fixtures,
///         bounded next-maker lookup, size decrease/removal, and captured events. It drives the
///         spec §7.5 hooks exactly as the §7.7 pseudocode does. It is not the production
///         bitmap/FIFO book and holds no economics.
/// @dev Price-time priority by linear scan (fixture sizes only). Every examined node consumes a
///      step. Expiry (inclusive good-til-block) and self-trade are checked here; epoch and
///      reduce-version staleness are reported back by Risk as PRUNE_MAKER.
abstract contract MockBookAdapter is IBookRiskHooks {
    error MockBookBadInput();

    event OrderPlaced(
        uint32 indexed trader,
        uint32 indexed slot,
        uint24 generation,
        MathTypes.Side side,
        uint16 tick,
        uint64 lots,
        uint32 expiryBlock,
        uint64 marketEpoch,
        uint64 accountEpoch,
        bool reduceOnly,
        uint64 reduceVersion
    );
    event OrderRemoved(
        uint32 indexed trader,
        uint32 indexed slot,
        uint24 generation,
        uint16 tick,
        uint64 removedLots,
        RemovalReason reason
    );
    event Fill(
        uint32 indexed maker,
        uint32 indexed taker,
        uint32 makerSlot,
        uint24 makerGeneration,
        MathTypes.Side takerSide,
        uint16 tick,
        uint64 lots,
        uint256 makerFeeQ,
        uint256 takerFeeQ
    );
    event OrderRemainderDropped(uint32 indexed trader, uint64 lots, RemovalReason reason);

    struct BookOrder {
        OrderView v;
        uint64 seq;
        bool live;
    }

    BookOrder[] internal _bk;
    uint64 internal _seq;
    uint256 public lastExamined;
    uint64 public lastFilled;
    uint256 public minRestLots = 1;

    struct PlaceResult {
        uint64 filledLots;
        uint32 restedSlot; // 0 = nothing rested (slot ids start at 1)
        RejectCode rejection;
        bool postOnlySkipped;
    }

    // ---------------------------------------------------------------- views

    function mockOrder(uint32 slot) external view returns (OrderView memory v, bool live) {
        BookOrder storage o = _bk[slot - 1];
        return (o.v, o.live);
    }

    function _best(MathTypes.Side takerSide, uint16 limit) internal view returns (bool found, uint256 idx) {
        bool buy = takerSide == MathTypes.Side.BUY;
        for (uint256 i; i < _bk.length; ++i) {
            BookOrder storage o = _bk[i];
            if (!o.live || o.v.side == takerSide) continue;
            if (buy ? o.v.tick > limit : o.v.tick < limit) continue;
            if (!found) {
                (found, idx) = (true, i);
                continue;
            }
            BookOrder storage b = _bk[idx];
            bool better = buy ? o.v.tick < b.v.tick : o.v.tick > b.v.tick;
            if (better || (o.v.tick == b.v.tick && o.seq < b.seq)) idx = i;
        }
    }

    function _wouldCross(MathTypes.Side side, uint16 limit) internal view returns (bool found) {
        (found,) = _best(side, limit);
    }

    // ---------------------------------------------------------------- actions

    /// @notice placeOrder per spec §7.7 against the mock book.
    function _mockPlace(OrderRequest memory req) internal returns (PlaceResult memory r) {
        return _mockPlaceWithMode(req, AdmissionMode.NORMAL);
    }

    /// @notice Same traversal with an explicit admission mode (liquidation IOC uses FORCED_REDUCTION).
    function _mockPlaceWithMode(OrderRequest memory req, AdmissionMode mode)
        internal
        returns (PlaceResult memory r)
    {
        if (req.limitTick < 1 || req.limitTick > 999 || req.requestedLots == 0 || req.maxSteps > 64) {
            revert MockBookBadInput();
        }
        RiskSnapshot memory snap = _riskBeginAction();
        (TakerPermit memory permit, RejectCode reject) = _riskPrepareTaker(req, snap, mode);
        if (permit.remainingLots == 0) {
            r.rejection = reject;
            return r;
        }
        if (req.kind == OrderKind.POST_ONLY) {
            if (_wouldCross(req.side, req.limitTick)) {
                _riskFinishTaker(snap, permit);
                r.postOnlySkipped = true;
                return r;
            }
        } else {
            r.filledLots = _matchLoop(req, snap, permit);
        }
        if (req.kind != OrderKind.IOC && permit.remainingLots >= minRestLots) {
            r.restedSlot = _restRemainder(req, snap, permit);
        }
        _riskFinishTaker(snap, permit);
        lastFilled = r.filledLots;
    }

    function _restRemainder(OrderRequest memory req, RiskSnapshot memory snap, TakerPermit memory permit)
        internal
        returns (uint32 slot)
    {
        if (_wouldCross(req.side, req.limitTick)) {
            emit OrderRemainderDropped(req.trader, permit.remainingLots, RemovalReason.CROSSED_REMAINDER);
            return 0;
        }
        uint64 rest = permit.remainingLots;
        (EpochTag memory tag, uint64 rv, uint256 fee) =
            _riskConvertPermitToRest(snap, permit, rest, req.expiryBlock);
        slot =
            _append(req.trader, req.side, req.limitTick, rest, req.expiryBlock, tag, req.reduceOnly, rv, fee);
    }

    function _matchLoop(OrderRequest memory req, RiskSnapshot memory snap, TakerPermit memory permit)
        internal
        returns (uint64 filled)
    {
        uint256 steps;
        while (permit.remainingLots > 0 && steps < req.maxSteps) {
            (bool found, uint256 i) = _best(req.side, req.limitTick);
            if (!found) break;
            ++steps;
            BookOrder storage o = _bk[i];
            if (o.v.expiryBlock != 0 && block.number > o.v.expiryBlock) {
                _remove(snap, i, RemovalReason.EXPIRED);
                continue;
            }
            if (o.v.owner == req.trader) {
                _remove(snap, i, RemovalReason.SELF_TRADE);
                continue;
            }
            uint64 proposed =
                o.v.remainingLots < permit.remainingLots ? o.v.remainingLots : permit.remainingLots;
            StepResult memory res = _riskTryMatchedFill(snap, permit, o.v, proposed);
            if (res.status == StepStatus.PRUNE_MAKER) {
                _remove(
                    snap,
                    i,
                    res.reason == RejectCode.STALE_ORDER
                        ? RemovalReason.STALE_ACCOUNT_EPOCH
                        : RemovalReason.FAILED_READMISSION
                );
                continue;
            }
            if (res.status == StepStatus.STOP_TAKER) break;
            // Filled lots were unreserved by Risk inside the fill; no unrest for them.
            uint64 beforeLots = o.v.remainingLots;
            o.v.remainingLots -= res.filledLots;
            // Fee-cap attribution follows the same pro-rata floor rule Risk uses (assumption M-11).
            o.v.remainingFeeCapQ = o.v.remainingFeeCapQ * o.v.remainingLots / beforeLots;
            filled += res.filledLots;
            emit Fill(
                o.v.owner,
                req.trader,
                o.v.key.slot,
                o.v.key.generation,
                req.side,
                o.v.tick,
                res.filledLots,
                res.makerFeeQ,
                res.takerFeeQ
            );
            if (o.v.remainingLots == 0) {
                o.live = false;
                emit OrderRemoved(
                    o.v.owner,
                    o.v.key.slot,
                    o.v.key.generation,
                    o.v.tick,
                    res.filledLots,
                    RemovalReason.FILLED
                );
            } else if (res.removeMakerRemainder) {
                _remove(snap, i, RemovalReason.REDUCE_ONLY_EXHAUSTED);
            }
        }
        lastExamined = steps;
    }

    /// @notice Physically remove a live order and release only its unfilled remainder.
    function _remove(RiskSnapshot memory snap, uint256 i, RemovalReason reason) internal {
        BookOrder storage o = _bk[i];
        o.live = false;
        _riskOnUnrest(
            snap, o.v.owner, o.v.admittedAt, o.v.side, o.v.tick, o.v.remainingLots, o.v.remainingFeeCapQ
        );
        emit OrderRemoved(o.v.owner, o.v.key.slot, o.v.key.generation, o.v.tick, o.v.remainingLots, reason);
    }

    function _append(
        uint32 owner,
        MathTypes.Side side,
        uint16 tick,
        uint64 lots,
        uint32 expiry,
        EpochTag memory tag,
        bool reduceOnly,
        uint64 rv,
        uint256 fee
    ) internal returns (uint32 slot) {
        slot = uint32(_bk.length + 1);
        OrderView memory v =
            OrderView(OrderKey(slot, 0), owner, side, tick, lots, expiry, tag, reduceOnly, rv, fee);
        _bk.push(BookOrder(v, ++_seq, true));
        emit OrderPlaced(
            owner,
            slot,
            0,
            side,
            tick,
            lots,
            expiry,
            tag.marketOrderEpoch,
            tag.accountOrderEpoch,
            reduceOnly,
            rv
        );
    }

    /// @notice Rest directly (post-only path without matching).
    function _mockRest(uint32 owner, MathTypes.Side side, uint16 tick, uint64 lots, uint32 expiry, bool reduceOnly)
        internal
        returns (uint32 slot)
    {
        RiskSnapshot memory snap = _riskBeginAction();
        (EpochTag memory tag, uint64 rv, uint256 fee) =
            _riskAdmitRest(snap, owner, side, tick, lots, expiry, reduceOnly);
        slot = _append(owner, side, tick, lots, expiry, tag, reduceOnly, rv, fee);
    }

    /// @notice Owner cancel: returns false for a dead order (no economic effect).
    function _mockCancel(uint32 slot) internal returns (bool) {
        if (slot == 0 || slot > _bk.length || !_bk[slot - 1].live) return false;
        RiskSnapshot memory snap = _riskBeginAction();
        _remove(snap, slot - 1, RemovalReason.USER_CANCEL);
        return true;
    }

    /// @notice Size-down at unchanged price/permission keeps priority; unrest for the delta only.
    function _mockAmendDown(uint32 slot, uint64 newLots) internal returns (bool) {
        if (slot == 0 || slot > _bk.length || !_bk[slot - 1].live) return false;
        BookOrder storage o = _bk[slot - 1];
        if (newLots == 0 || newLots >= o.v.remainingLots) revert MockBookBadInput();
        RiskSnapshot memory snap = _riskBeginAction();
        uint64 delta = o.v.remainingLots - newLots;
        uint256 feeRelease = o.v.remainingFeeCapQ * delta / o.v.remainingLots;
        _riskOnUnrest(snap, o.v.owner, o.v.admittedAt, o.v.side, o.v.tick, delta, feeRelease);
        o.v.remainingLots = newLots;
        o.v.remainingFeeCapQ -= feeRelease;
        return true;
    }

    /// @notice Test aid: overwrite a dead slot with a new generation (slot reuse).
    function _mockRecycle(uint32 slot, OrderView memory v) internal {
        BookOrder storage o = _bk[slot - 1];
        if (o.live) revert MockBookBadInput();
        v.key = OrderKey(slot, o.v.key.generation + 1);
        o.v = v;
        o.live = true;
        o.seq = ++_seq;
    }
}
