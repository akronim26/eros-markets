// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Book} from "../src/Book.sol";
import {Side, AdmissionMode, StepStatus, RejectCode} from "../provisional/MathTypes.sol";

/// @notice Stand-in for the engine's trader registry: ids from 1 in first-use order.
abstract contract TraderIds is Book {
    mapping(address account => uint32) public traderId;
    uint32 public traderCount;

    event TraderRegistered(address indexed account, uint32 indexed trader);

    function _traderOf(address account) internal override returns (uint32 id) {
        id = traderId[account];
        if (id == 0) {
            id = ++traderCount;
            traderId[account] = id;
            emit TraderRegistered(account, id);
        }
    }
}

/// @notice Book over a scripted stand-in for Risk & Clearing's hooks, plus read access to
///         internals, for tests only. It keeps positions and resting reservations so tests can
///         check the book drives every hook exactly once per lot, and lets tests script stages,
///         a minimum size, failing makers, a stopping taker and a rejecting finish. No economics.
contract BookHarness is TraderIds {
    function createMarket(uint8 maxFills_) external {
        _initBook(maxFills_);
    }

    function setMaxFills(uint8 maxFills_) external {
        _setMaxFills(maxFills_);
    }

    /// @dev Rests an order without matching (the post-only path, without its crossing check).
    function rest(bool isBuy, uint16 tick, uint64 size) external returns (uint32) {
        OrderRequest memory req = OrderRequest(
            _traderOf(msg.sender), isBuy ? Side.BUY : Side.SELL, OrderKind.POST_ONLY, tick, size, 0, false, 0
        );
        return _execute(_openBook(), req, AdmissionMode.NORMAL);
    }

    // ------------------------------------------------------------------ risk stand-in

    error TakerRejected();
    error NotCalledByBook();

    /// @dev Stand-in for the market stage the risk lifecycle derives.
    enum Stage {
        Open,
        ReduceOnly,
        Halted
    }

    /// @dev Signed position per trader; + is long.
    mapping(uint32 => int256) public position;
    /// @dev Current-epoch resting lots per (trader, isBuy): rests add them, fills and unrests take
    ///      them off, and cancel-all clears them by moving the trader to a new order epoch.
    mapping(uint32 => mapping(bool => uint256)) public reserved;
    mapping(uint32 => uint64) public accountEpoch;
    mapping(uint32 => bool) public failMaker;
    bool public stopTaker;
    bool public rejectTaker;
    Stage public stage;
    uint64 public minSize;
    uint256 public takerDoneCalls;
    uint256 public unrestCalls;
    uint8 public lastRestFlags;
    uint32 public lastRestExpiry;
    uint8 public lastUnrestFlags; // side only: an unrest carries no reduce-only flag

    /// @dev Snapshot echo: every action loads `snapshotMark`; later hooks record what they saw.
    uint256 public snapshotMark = 555;
    uint256 public makerSawMark;
    uint256 public doneSawMark;
    /// @dev The last order's totals as its fills reported them: lots, and lots x maker tick.
    uint64 public doneFilled;
    uint256 public doneCost;

    /// @dev The record a rest gets back, and what the hooks later receive for an order.
    struct Unrest {
        uint32 owner;
        EpochTag tag;
        Side side;
        uint16 tick;
        uint64 lots;
        uint256 feeCapQ;
    }

    uint64 internal _restMarketEpoch;
    uint64 internal _restReduceVersion;
    uint256 internal _restFeeCapQ;
    OrderView internal _lastMaker;
    Unrest internal _lastUnrest;

    function setRestRecord(uint64 marketEpoch, uint64 reduceVersion, uint256 feeCapQ) external {
        (_restMarketEpoch, _restReduceVersion, _restFeeCapQ) = (marketEpoch, reduceVersion, feeCapQ);
    }

    function _tag(uint32 trader) internal view returns (EpochTag memory) {
        return EpochTag(_restMarketEpoch, accountEpoch[trader]);
    }

    function _current(uint32 trader, EpochTag memory t) internal view returns (bool) {
        return t.accountOrderEpoch == accountEpoch[trader];
    }

    function lastMaker() external view returns (OrderView memory) {
        return _lastMaker;
    }

    function lastUnrest() external view returns (Unrest memory) {
        return _lastUnrest;
    }

    function setPosition(uint32 trader, int256 pos) external {
        position[trader] = pos;
    }

    function setFailMaker(uint32 trader, bool fail) external {
        failMaker[trader] = fail;
    }

    function setStopTaker(bool stop) external {
        stopTaker = stop;
    }

    function setSnapshotMark(uint256 mark) external {
        snapshotMark = mark;
    }

    function setRejectTaker(bool reject) external {
        rejectTaker = reject;
    }

    function setStage(Stage s) external {
        stage = s;
    }

    function setMinSize(uint64 size) external {
        minSize = size;
    }

    function _reducible(uint32 trader, bool isBuy) internal view returns (uint256) {
        int256 p = position[trader];
        if (isBuy) return p < 0 ? uint256(-p) : 0;
        return p > 0 ? uint256(p) : 0;
    }

    function _apply(uint32 trader, bool isBuy, uint64 lots) internal {
        position[trader] += isBuy ? int256(uint256(lots)) : -int256(uint256(lots));
    }

    function _flags(Side side, bool reduceOnly) internal pure returns (uint8) {
        return (side == Side.BUY ? FLAG_BUY : 0) | (reduceOnly ? FLAG_REDUCE_ONLY : 0);
    }

    function _riskBeginAction() internal view override returns (RiskSnapshot memory s) {
        s.markWad = snapshotMark;
    }

    function _riskTouchAccount(uint32, RiskSnapshot memory) internal pure override {}

    /// @dev Stage and size gates answer with codes; a reduce-only taker is clipped to its position.
    function _riskPrepareTaker(OrderRequest memory req, RiskSnapshot memory, AdmissionMode)
        internal
        override
        returns (TakerPermit memory p, RejectCode reason)
    {
        (doneFilled, doneCost) = (0, 0);
        (p.trader, p.side, p.limitTick, p.reduceOnly) = (req.trader, req.side, req.limitTick, req.reduceOnly);
        if (stage == Stage.Halted) return (p, RejectCode.HALTED);
        if (stage == Stage.ReduceOnly && !req.reduceOnly) return (p, RejectCode.BAD_STAGE);
        if (req.requestedLots < minSize) return (p, RejectCode.BELOW_MIN_SIZE);
        uint256 lots = req.requestedLots;
        if (req.reduceOnly) {
            uint256 r = _reducible(req.trader, req.side == Side.BUY);
            if (r == 0) return (p, RejectCode.NO_REDUCIBLE_POSITION);
            if (r < lots) lots = r;
        }
        p.remainingLots = uint64(lots);
    }

    /// @dev A failing maker is pruned; a reduce-only maker is clipped to its position and a clip
    ///      removes its remainder. Both legs post at the maker's tick.
    function _riskTryMatchedFill(
        RiskSnapshot memory snap,
        TakerPermit memory permit,
        OrderView memory maker,
        uint64 proposedLots
    ) internal override returns (StepResult memory r) {
        makerSawMark = snap.markWad;
        _lastMaker = maker;
        if (stopTaker) {
            r.status = StepStatus.STOP_TAKER;
            return r;
        }
        bool makerBuys = maker.side == Side.BUY;
        uint64 lots = proposedLots;
        if (maker.reduceOnly) {
            uint256 m = _reducible(maker.owner, makerBuys);
            if (m < lots) lots = uint64(m);
        }
        if (failMaker[maker.owner] || lots == 0 || !_current(maker.owner, maker.admittedAt)) {
            r.status = StepStatus.PRUNE_MAKER;
            return r;
        }
        _apply(maker.owner, makerBuys, lots);
        _apply(permit.trader, !makerBuys, lots);
        reserved[maker.owner][makerBuys] -= lots;
        permit.remainingLots -= lots;
        doneFilled += lots;
        doneCost += uint256(lots) * maker.tick;
        r.filledLots = lots;
        r.makerRemainingLots = maker.remainingLots - lots;
        r.removeMakerRemainder = lots < proposedLots;
    }

    function _riskAdmitRest(RiskSnapshot memory, uint32, Side, uint16, uint64, uint32, bool)
        internal
        pure
        override
        returns (EpochTag memory, uint64, uint256)
    {
        revert NotCalledByBook(); // every rest converts a taker permit
    }

    function _riskConvertPermitToRest(
        RiskSnapshot memory,
        TakerPermit memory permit,
        uint64 lots,
        uint32 expiry
    ) internal override returns (EpochTag memory, uint64, uint256) {
        lastRestExpiry = expiry;
        permit.remainingLots -= lots;
        reserved[permit.trader][permit.side == Side.BUY] += lots;
        lastRestFlags = _flags(permit.side, permit.reduceOnly);
        return (_tag(permit.trader), _restReduceVersion, _restFeeCapQ);
    }

    function _riskOnUnrest(
        RiskSnapshot memory,
        uint32 owner,
        EpochTag memory tag,
        Side side,
        uint16 tick,
        uint64 lots,
        uint256 feeCapQ
    ) internal override {
        _lastUnrest = Unrest(owner, tag, side, tick, lots, feeCapQ);
        if (_current(owner, tag)) reserved[owner][side == Side.BUY] -= lots; // an old epoch is a no-op
        lastUnrestFlags = _flags(side, false);
        ++unrestCalls;
    }

    function _riskCancelAll(uint32 trader) internal override returns (EpochTag memory) {
        ++accountEpoch[trader];
        (reserved[trader][true], reserved[trader][false]) = (0, 0);
        return _tag(trader);
    }

    function _riskFinishTaker(RiskSnapshot memory snap, TakerPermit memory) internal override {
        if (rejectTaker) revert TakerRejected();
        ++takerDoneCalls;
        doneSawMark = snap.markWad;
    }

    // ------------------------------------------------------------------ internals

    function orderAt(uint32 slot) external view returns (Order memory) {
        return _book.orders[slot];
    }

    function freeHead() external view returns (uint32) {
        return _book.freeHead;
    }

    // ------------------------------------------------------------------ INV-8

    /// @dev Full structural check of the book; reverts with the first violation.
    ///      `traders` bounds the reservation check to ids 1..traders; only current-epoch orders
    ///      are reserved (cancel-all leaves the old ones resting until they are reached).
    function checkInvariants(uint32 traders) external view {
        BookState storage b = _book;
        uint256 n = b.orders.length;
        uint256[2][] memory resting = new uint256[2][](traders + 1);
        uint256 linked;

        for (uint8 side; side < 2; ++side) {
            for (uint256 w; w < WORDS; ++w) {
                uint256 word = b.bits[side][w];
                require(word & SENTINEL != 0, "sentinel cleared");
                require(word & ~(SENTINEL | TICK_MASK) == 0, "stray high bit");
            }
            // Bits for ticks past MAX_TICK in the last word must never be set.
            uint256 used = (MAX_TICK - 1) % TICKS_PER_WORD + 1;
            require(b.bits[side][WORDS - 1] & TICK_MASK & ~((1 << used) - 1) == 0, "bit past MAX_TICK set");
            for (uint16 k = MIN_TICK; k <= MAX_TICK; ++k) {
                Level storage lv = b.levels[k][side];
                uint256 i = k - 1;
                bool bit = b.bits[side][i / TICKS_PER_WORD] & (1 << (i % TICKS_PER_WORD)) != 0;
                require(bit == (lv.head != 0), "bit != non-empty");
                require((lv.head == 0) == (lv.tail == 0), "head/tail mismatch");
                require(lv.head == 0 || lv.used, "live level not marked used");
                uint256 sum;
                uint32 prev;
                for (uint32 s = lv.head; s != 0; s = b.orders[s].next) {
                    require(s < n, "link out of range");
                    require(++linked <= n, "cycle");
                    Order storage o = b.orders[s];
                    require(o.flags & FLAG_LIVE != 0, "dead order linked");
                    require(o.size != 0, "empty live order");
                    require(o.tick == k, "wrong tick");
                    require((o.flags & FLAG_BUY != 0) == (side == BID), "wrong side");
                    require(o.prev == prev, "prev link");
                    require(o.owner != 0 && o.owner <= traders, "bad owner");
                    if (o.accountEpoch == accountEpoch[o.owner]) resting[o.owner][side] += o.size;
                    sum += o.size;
                    prev = s;
                }
                require(prev == lv.tail, "tail link");
                require(sum == lv.size, "level size != sum of orders");
            }
        }

        // Every live slot is linked exactly once; every dead recyclable slot is on the free list.
        uint256 live;
        uint256 recyclable;
        for (uint256 s = 1; s < n; ++s) {
            Order storage o = b.orders[s];
            require(o.owner != 0, "slot returned to zero");
            if (o.flags & FLAG_LIVE != 0) ++live;
            else if (o.gen != MAX_GEN) ++recyclable;
            if (o.flags & FLAG_LIVE == 0) require(o.size == 0 && o.flags == 0, "tombstone not cleared");
        }
        require(live == linked, "live orders != linked orders");
        uint256 free;
        for (uint32 s = b.freeHead; s != 0; s = b.orders[s].next) {
            require(++free <= n, "free-list cycle");
            require(b.orders[s].flags == 0, "live order on free list");
            require(b.orders[s].gen != MAX_GEN, "retired slot on free list");
        }
        require(free == recyclable, "free list incomplete");

        for (uint32 t = 1; t <= traders; ++t) {
            require(reserved[t][false] == resting[t][ASK], "ask reservation");
            require(reserved[t][true] == resting[t][BID], "bid reservation");
        }

        uint16 bid = _bestBid(b);
        uint16 ask = _bestAsk(b);
        require(bid == NONE || ask == NONE || bid < ask, "crossed book");
    }

    function setBit(bool isBuy, uint16 tick) external {
        _setBit(_openBook(), isBuy ? BID : ASK, tick);
    }

    function clearBit(bool isBuy, uint16 tick) external {
        _clearBit(_openBook(), isBuy ? BID : ASK, tick);
    }

    function bitWord(bool isBuy, uint256 w) external view returns (uint256) {
        return _book.bits[isBuy ? BID : ASK][w];
    }

    function orderSlots() external view returns (uint256) {
        return _book.orders.length;
    }
}
