// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibBit} from "solady/utils/LibBit.sol";
import {AdmissionMode, StepStatus, RejectCode} from "./math/RiskTypes.sol";
import {MathTypes} from "./math/MathTypes.sol";
import {IBookRiskHooks} from "./interfaces/IBookRiskHooks.sol";

/// @title Book
/// @notice Fully on-chain price-time CLOB over the 999 ticks 0.001 .. 0.999 (design spec §9) for
///         one market. Risk & Clearing keeps one ledger per market (risk spec §1), so every
///         per-market engine composes exactly one Book.
/// @dev Storage is laid out for Monad's page-priced storage (MIP-8): bitmaps, levels and orders
///      never return to zero once used. The book drives Risk & Clearing through the internal hook
///      seam of `IBookRiskHooks` (risk spec §7.5, §7.7): one action and one taker permit per
///      order, one `_riskTryMatchedFill` per examined maker, and an unrest only for lots that stop
///      resting unfilled. The book never touches accounts and risk never touches the book.
abstract contract Book is IBookRiskHooks {
    // ------------------------------------------------------------------ constants

    // The tick grid is a locked design decision (ticks of 0.001, prices 0.001 .. 0.999) and the
    // storage layout below is sized from it, so it is compile-time; everything else derives from it.
    uint16 internal constant MIN_TICK = 1;
    uint16 internal constant MAX_TICK = 999;
    /// @dev Returned by best-price lookups for an empty side; never a valid tick.
    uint16 internal constant NONE = 0;

    /// @dev Tick bits per bitmap word; below 256 so the top bit is free for the sentinel.
    uint256 internal constant TICKS_PER_WORD = 250;
    uint256 internal constant WORDS = (MAX_TICK + TICKS_PER_WORD - 1) / TICKS_PER_WORD;
    /// @dev levels[] is indexed by tick directly; index 0 is unused.
    uint256 internal constant LEVELS = MAX_TICK + 1;
    /// @dev The top bit of every bitmap word stays set so the word never returns to zero.
    uint256 internal constant SENTINEL = 1 << 255;
    uint256 internal constant TICK_MASK = (1 << TICKS_PER_WORD) - 1;

    /// @dev MathTypes.Side index into levels[tick][side] and bits[side].
    uint8 internal constant ASK = 0;
    uint8 internal constant BID = 1;

    uint8 public constant FLAG_BUY = 1;
    uint8 public constant FLAG_REDUCE_ONLY = 2;
    uint8 public constant FLAG_LIVE = 4;

    /// @dev Public order id = gen << 24 | slot.
    uint256 internal constant SLOT_BITS = 24;
    uint256 internal constant SLOT_MASK = (1 << SLOT_BITS) - 1;
    /// @dev A slot whose generation reached this value is retired instead of recycled, so an id is
    ///      never reissued and a stale cancel can never hit a newer order.
    uint8 internal constant MAX_GEN = type(uint8).max;

    enum CancelReason {
        USER,
        SELF_TRADE, // resting order hit by its own owner
        FAILED_CHECK, // risk pruned the maker: stale epoch or failed readmission
        CLIPPED, // reduce-only maker exhausted its reducible size
        EXPIRED // reached after its expiry block
    }

    struct Place {
        OrderKind kind; // LIMIT: match, rest the remainder; IOC: drop it; POST_ONLY: never match
        bool isBuy;
        bool reduceOnly;
        uint16 tick;
        uint64 size; // lots (0.001 claim)
        uint8 maxFills; // makers the match may examine, counting self-trades and failed makers
        uint32 expiryBlock; // 0 = none; executable while block.number <= expiryBlock
    }

    // ------------------------------------------------------------------ storage

    /// @dev One slot. `used` stays true after first use so the slot never returns to zero.
    struct Level {
        uint32 head; // oldest order slot
        uint32 tail; // newest order slot
        uint96 size; // total resting lots at this tick (wider than one order's uint64)
        bool used;
    }

    /// @dev Three slots. The first is the topology and stays a non-zero tombstone once the order
    ///      is dead (owner/tick/gen are kept); the rest is the record risk returned when the order
    ///      started resting (risk spec §7.2 sidecar). Reuse overwrites all of it, and the
    ///      generation in the public id guards every read.
    struct Order {
        uint32 owner; // trader id
        uint64 size; // remaining lots; 0 = dead
        uint32 next; // next in level; while dead: next free slot
        uint32 prev;
        uint16 tick; // 1..999
        uint8 flags; // FLAG_BUY | FLAG_REDUCE_ONLY | FLAG_LIVE
        uint8 gen; // bumped on every reuse; part of the public id
        uint64 reduceVersion; // position version a reduce-only order was admitted against
        uint64 marketEpoch; // full order epochs the reservation was admitted under
        uint64 accountEpoch;
        uint32 expiryBlock; // 0 = none; executable while block.number <= expiryBlock
        uint256 feeCapQ; // fee reservation still attributable to the remaining lots
    }

    struct BookState {
        uint256[WORDS][2] bits; // [ASK|BID][word]; tick k -> word (k-1)/250, bit (k-1)%250
        uint32 freeHead; // top of the free-slot stack
        uint8 maxFills; // bound on orders a taker may examine; shares freeHead's slot
        Level[2][LEVELS] levels; // [tick][ASK|BID]: a tick's two sides share a page
        Order[] orders; // index = slot; slot 0 = null
    }

    BookState internal _book;

    // ------------------------------------------------------------------ events

    event MaxFillsSet(uint8 maxFills);
    event OrderPlaced(
        uint32 indexed id, uint32 indexed trader, uint16 tick, uint64 size, uint8 flags, uint32 expiryBlock
    );
    event OrderCancelled(uint32 indexed id, uint64 size, CancelReason reason);
    /// @notice Risk admitted nothing for an order; `reason` is its rejection code.
    event OrderRejected(uint32 indexed trader, RejectCode reason);
    /// @notice Every order `trader` placed before this is dead: it stays in the book until a taker
    ///         or its owner reaches it, and it can never fill.
    event AllOrdersCancelled(uint32 indexed trader, uint64 marketEpoch, uint64 accountEpoch);
    event Fill(
        uint32 indexed makerOrder,
        uint32 maker,
        uint32 taker,
        uint16 tick,
        uint64 size,
        uint256 makerFeeQ,
        uint256 takerFeeQ
    );

    // ------------------------------------------------------------------ errors

    error MarketExists();
    error NoMarket();
    error NotLive();
    error NotOwner();
    error BookFull();
    error BadTick();
    error BadSize();
    error BadMaxFills();
    error PostOnlyCrosses();
    error BadExpiry();

    // ------------------------------------------------------------------ engine hook

    /// @dev The engine's trader id for `account`, the key Risk & Clearing keeps accounts under
    ///      (risk spec: the accounting registry's index + 1). Never 0; the book keeps no registry.
    ///      Every other hook is one of `IBookRiskHooks`.
    function _traderOf(address account) internal virtual returns (uint32);

    // ------------------------------------------------------------------ external

    /// @notice Place one order. Returns the resting order's id, or 0 if nothing rests; when risk
    ///         admits nothing, `OrderRejected` carries its reason.
    function placeOrder(Place calldata p) external returns (uint32 id) {
        return _place(_openBook(), _traderOf(msg.sender), p, false);
    }

    /// @notice Requote in one call: every cancel first, then the places in order. Cancelling an
    ///         order that already filled or was cancelled does nothing, and a crossing post-only
    ///         order is skipped with id 0, so a fill landing between a bot's read and its requote
    ///         never reverts the batch.
    function batch(uint32[] calldata cancels, Place[] calldata places)
        external
        returns (uint32[] memory ids)
    {
        BookState storage b = _openBook();
        uint32 trader = _traderOf(msg.sender);
        if (cancels.length != 0) {
            RiskSnapshot memory snap = _riskBeginAction();
            for (uint256 i; i < cancels.length; ++i) {
                _cancelOwn(b, snap, trader, cancels[i]);
            }
        }
        ids = new uint32[](places.length);
        for (uint256 i; i < places.length; ++i) {
            ids[i] = _place(b, trader, places[i], true);
        }
    }

    /// @notice Cancel a live order owned by the caller. Reverts if it is no longer live.
    function cancel(uint32 id) external {
        BookState storage b = _openBook();
        uint32 trader = _traderOf(msg.sender);
        if (!_cancelOwn(b, _riskBeginAction(), trader, id)) revert NotLive();
    }

    /// @notice Cancel every resting order of the caller in O(1): risk moves the account to a new
    ///         order epoch (risk spec §7.5), and the old orders are pruned when reached.
    function cancelAll() external {
        _openBook();
        uint32 trader = _traderOf(msg.sender);
        _riskBeginAction();
        EpochTag memory t = _riskCancelAll(trader);
        emit AllOrdersCancelled(trader, t.marketOrderEpoch, t.accountOrderEpoch);
    }

    // ------------------------------------------------------------------ views

    /// @notice Best bid and best ask ticks; NONE (0) for an empty side.
    function bestBidAsk() external view returns (uint16 bid, uint16 ask) {
        BookState storage b = _openBook();
        return (_bestBid(b), _bestAsk(b));
    }

    /// @notice Best prices and the size resting at each (0 when a side is empty).
    function touch() external view returns (uint16 bid, uint96 bidSize, uint16 ask, uint96 askSize) {
        return _touch();
    }

    /// @notice The level at `tick` on one side; one read, used by the mark's depth filter.
    function getLevel(bool isBuy, uint16 tick) external view returns (Level memory) {
        if (tick < MIN_TICK || tick > MAX_TICK) revert BadTick();
        return _openBook().levels[tick][isBuy ? BID : ASK];
    }

    /// @notice The most orders one taker order may examine.
    function maxFills() external view returns (uint8) {
        return _openBook().maxFills;
    }

    /// @notice The order behind `id`, or an all-zero order if `id` is not live.
    function getOrder(uint32 id) external view returns (Order memory o) {
        BookState storage b = _openBook();
        (uint32 s, bool live) = _liveSlot(b, id);
        if (live) o = b.orders[s];
    }

    // ------------------------------------------------------------------ module interface

    /// @dev Best prices with the size resting there: the mark's inputs, where a best level below
    ///      D_min counts as missing (spec §5.3).
    function _touch() internal view returns (uint16 bid, uint96 bidSize, uint16 ask, uint96 askSize) {
        BookState storage b = _openBook();
        bid = _bestBid(b);
        ask = _bestAsk(b);
        if (bid != NONE) bidSize = b.levels[bid][BID].size;
        if (ask != NONE) askSize = b.levels[ask][ASK].size;
    }

    /// @dev Liquidation's reduce-only IOC (risk spec §5.2 step 2): the ordinary traversal under
    ///      FORCED_REDUCTION, which only the liquidation module can grant. `req` is an IOC.
    ///      Returns the lots filled and the makers examined.
    function _placeForced(OrderRequest memory req) internal returns (uint64 filled, uint256 examined) {
        BookState storage b = _openBook();
        _checkOrder(b, req.limitTick, req.requestedLots, req.maxSteps, req.expiryBlock);
        (, filled, examined) = _execute(b, req, AdmissionMode.FORCED_REDUCTION);
    }

    // ------------------------------------------------------------------ place

    /// @dev In a batch a crossing post-only order returns 0 instead of reverting.
    function _place(BookState storage b, uint32 trader, Place calldata p, bool inBatch)
        internal
        returns (uint32)
    {
        _checkOrder(b, p.tick, p.size, p.maxFills, p.expiryBlock);
        if (p.kind == OrderKind.POST_ONLY && _crosses(b, p.isBuy, p.tick)) {
            if (inBatch) return 0;
            revert PostOnlyCrosses();
        }
        (uint32 id,,) = _execute(
            b,
            OrderRequest(
                trader,
                p.isBuy ? MathTypes.Side.BUY : MathTypes.Side.SELL,
                p.kind,
                p.tick,
                p.size,
                p.expiryBlock,
                p.reduceOnly,
                p.maxFills
            ),
            AdmissionMode.NORMAL
        );
        return id;
    }

    function _checkOrder(BookState storage b, uint16 tick, uint64 size, uint256 maxSteps, uint32 expiryBlock)
        internal
        view
    {
        if (tick < MIN_TICK || tick > MAX_TICK) revert BadTick();
        if (size == 0) revert BadSize();
        if (maxSteps > b.maxFills) revert BadMaxFills();
        if (expiryBlock != 0 && expiryBlock < block.number) revert BadExpiry();
    }

    /// @dev Risk spec §7.7: one action and one taker permit, a bounded match, then a LIMIT or
    ///      POST_ONLY remainder rests by converting the permit (never reserved twice), and the
    ///      permit is released. Returns the resting id, the lots filled and the makers examined.
    function _execute(BookState storage b, OrderRequest memory req, AdmissionMode mode)
        internal
        returns (uint32 id, uint64 filled, uint256 steps)
    {
        RiskSnapshot memory snap = _riskBeginAction();
        (TakerPermit memory permit, RejectCode reason) = _riskPrepareTaker(req, snap, mode);
        uint64 admitted = permit.remainingLots;
        if (admitted == 0) {
            emit OrderRejected(req.trader, reason);
            return (0, 0, 0);
        }
        if (req.kind != OrderKind.POST_ONLY) steps = _match(b, snap, permit, req.limitTick, req.maxSteps);
        filled = admitted - permit.remainingLots;
        // If maxFills ran out while the book still crosses the limit, the remainder is dropped:
        // resting it would leave best bid >= best ask (INV-8).
        if (
            req.kind != OrderKind.IOC && permit.remainingLots != 0
                && !_crosses(b, req.side == MathTypes.Side.BUY, req.limitTick)
        ) {
            id = _rest(b, snap, permit, req.expiryBlock);
        }
        _riskFinishTaker(snap, permit);
    }

    function _crosses(BookState storage b, bool isBuy, uint16 tick) internal view returns (bool) {
        if (isBuy) {
            uint16 ask = _bestAsk(b);
            return ask != NONE && ask <= tick;
        }
        uint16 bid = _bestBid(b);
        return bid != NONE && bid >= tick;
    }

    // ------------------------------------------------------------------ match

    /// @dev Walks the opposite side best price first, oldest first, examining at most `maxSteps`
    ///      makers. Every examined maker uses a step whatever happens to it, so gas stays bounded
    ///      whatever sits at the touch.
    function _match(
        BookState storage b,
        RiskSnapshot memory snap,
        TakerPermit memory permit,
        uint16 limit,
        uint256 maxSteps
    ) internal returns (uint256 steps) {
        bool takerBuys = permit.side == MathTypes.Side.BUY;
        while (permit.remainingLots != 0 && steps < maxSteps) {
            uint16 k = takerBuys ? _bestAsk(b) : _bestBid(b);
            if (k == NONE || (takerBuys ? k > limit : k < limit)) break;
            Level storage lv = b.levels[k][takerBuys ? ASK : BID];
            // Always the level's head: a step removes it, or leaves it partly filled because the
            // permit ran out or risk clipped the fill, and then the next step sees it again.
            for (uint32 s = lv.head; s != 0 && permit.remainingLots != 0 && steps < maxSteps; s = lv.head) {
                ++steps;
                if (_step(b, snap, permit, s)) return steps;
            }
        }
    }

    /// @dev Examines the maker in slot `s`: an expired maker or a self-trade is pruned here,
    ///      everything else is one `_riskTryMatchedFill`. Returns true when risk stops the taker.
    function _step(BookState storage b, RiskSnapshot memory snap, TakerPermit memory permit, uint32 s)
        internal
        returns (bool stop)
    {
        Order storage o = b.orders[s];
        if (o.expiryBlock != 0 && block.number > o.expiryBlock) {
            _cancel(b, snap, s, CancelReason.EXPIRED);
            return false;
        }
        if (o.owner == permit.trader) {
            _cancel(b, snap, s, CancelReason.SELF_TRADE);
            return false;
        }
        uint64 size = o.size;
        StepResult memory r = _riskTryMatchedFill(
            snap, permit, _view(s, o), size < permit.remainingLots ? size : permit.remainingLots
        );
        if (r.status == StepStatus.STOP_TAKER) return true;
        if (r.status == StepStatus.PRUNE_MAKER) {
            _cancel(b, snap, s, CancelReason.FAILED_CHECK);
            return false;
        }
        // Risk already released the filled lots: shrink the order without an unrest for them.
        bool whole = r.filledLots == size;
        if (whole) {
            _unlink(b, s);
        } else {
            uint64 left = size - r.filledLots; // a hook overfill underflows here and reverts
            o.size = left;
            o.feeCapQ = o.feeCapQ * left / size; // the pro-rata attribution risk consumed (M-11)
            b.levels[o.tick][o.flags & FLAG_BUY != 0 ? BID : ASK].size -= r.filledLots;
        }
        emit Fill(_id(s, o.gen), o.owner, permit.trader, o.tick, r.filledLots, r.makerFeeQ, r.takerFeeQ);
        // A reduce-only maker reached zero: only its unfilled rest is released.
        if (!whole && r.removeMakerRemainder) _cancel(b, snap, s, CancelReason.CLIPPED);
    }

    /// @dev The lossless view risk judges a resting order by (risk spec §7.5).
    function _view(uint32 s, Order storage o) internal view returns (OrderView memory v) {
        v.key = OrderKey(s, o.gen);
        v.owner = o.owner;
        v.side = o.flags & FLAG_BUY != 0 ? MathTypes.Side.BUY : MathTypes.Side.SELL;
        v.tick = o.tick;
        v.remainingLots = o.size;
        v.expiryBlock = o.expiryBlock;
        v.admittedAt = EpochTag(o.marketEpoch, o.accountEpoch);
        v.reduceOnly = o.flags & FLAG_REDUCE_ONLY != 0;
        v.reduceVersion = o.reduceVersion;
        v.remainingFeeCapQ = o.feeCapQ;
    }

    // ------------------------------------------------------------------ rest / cancel

    /// @dev Rests the permit's remainder. Risk converts the permit, so the lots are never reserved
    ///      twice, and returns the record the order keeps.
    function _rest(
        BookState storage b,
        RiskSnapshot memory snap,
        TakerPermit memory permit,
        uint32 expiryBlock
    ) internal returns (uint32) {
        Order memory o;
        (o.owner, o.size, o.tick, o.expiryBlock) =
        (permit.trader, permit.remainingLots, permit.limitTick, expiryBlock);
        o.flags =
            (permit.side == MathTypes.Side.BUY ? FLAG_BUY : 0) | (permit.reduceOnly ? FLAG_REDUCE_ONLY : 0);
        EpochTag memory tag;
        (tag, o.reduceVersion, o.feeCapQ) = _riskConvertPermitToRest(snap, permit, o.size, expiryBlock);
        (o.marketEpoch, o.accountEpoch) = (tag.marketOrderEpoch, tag.accountOrderEpoch);
        return _insert(b, o);
    }

    /// @dev Appends `o` at the tail of its level, reusing a free slot when one exists.
    function _insert(BookState storage b, Order memory o) internal returns (uint32 id) {
        uint32 s = b.freeHead;
        if (s != 0) {
            Order storage dead = b.orders[s];
            b.freeHead = dead.next;
            o.gen = dead.gen + 1;
        } else {
            uint256 n = b.orders.length;
            if (n > SLOT_MASK) revert BookFull();
            s = uint32(n);
            b.orders.push();
        }
        uint8 side = o.flags & FLAG_BUY != 0 ? BID : ASK;
        Level storage lv = b.levels[o.tick][side];
        uint32 tail = lv.tail;
        uint8 flags = o.flags;
        (o.next, o.prev, o.flags) = (0, tail, flags | FLAG_LIVE);
        b.orders[s] = o;
        if (tail == 0) {
            lv.head = s;
            _setBit(b, side, o.tick);
        } else {
            b.orders[tail].next = s;
        }
        lv.tail = s;
        lv.size += o.size;
        lv.used = true;
        id = _id(s, o.gen);
        emit OrderPlaced(id, o.owner, o.tick, o.size, flags, o.expiryBlock);
    }

    /// @dev Returns false if `id` is not live; reverts if it is live but not the trader's.
    function _cancelOwn(BookState storage b, RiskSnapshot memory snap, uint32 trader, uint32 id)
        internal
        returns (bool)
    {
        (uint32 s, bool live) = _liveSlot(b, id);
        if (!live) return false;
        if (b.orders[s].owner != trader) revert NotOwner();
        _cancel(b, snap, s, CancelReason.USER);
        return true;
    }

    /// @dev Unlinks a resting order and releases its unfilled lots at their tick and epoch.
    function _cancel(BookState storage b, RiskSnapshot memory snap, uint32 s, CancelReason reason) internal {
        Order storage o = b.orders[s];
        OrderView memory v = _view(s, o);
        emit OrderCancelled(_id(s, o.gen), v.remainingLots, reason);
        _unlink(b, s);
        _riskOnUnrest(snap, v.owner, v.admittedAt, v.side, v.tick, v.remainingLots, v.remainingFeeCapQ);
    }

    /// @dev Unlinks a live order in O(1), clears the tick bit if the level empties, and turns the
    ///      slot into a non-zero tombstone on the free list (or retires it at MAX_GEN).
    function _unlink(BookState storage b, uint32 s) internal {
        Order storage o = b.orders[s];
        uint8 side = o.flags & FLAG_BUY != 0 ? BID : ASK;
        uint16 tick = o.tick;
        Level storage lv = b.levels[tick][side];
        (uint32 prev, uint32 next) = (o.prev, o.next);
        if (prev == 0) lv.head = next;
        else b.orders[prev].next = next;
        if (next == 0) lv.tail = prev;
        else b.orders[next].prev = prev;
        lv.size -= o.size;
        if (lv.head == 0) _clearBit(b, side, tick);

        o.size = 0;
        o.flags = 0;
        o.prev = 0;
        if (o.gen == MAX_GEN) {
            o.next = 0;
        } else {
            o.next = b.freeHead;
            b.freeHead = s;
        }
    }

    // ------------------------------------------------------------------ ids

    function _id(uint32 s, uint8 gen) internal pure returns (uint32) {
        return (uint32(gen) << uint32(SLOT_BITS)) | s;
    }

    function _liveSlot(BookState storage b, uint32 id) internal view returns (uint32 s, bool live) {
        s = uint32(id & SLOT_MASK);
        if (s == 0 || s >= b.orders.length) return (s, false);
        Order storage o = b.orders[s];
        live = o.flags & FLAG_LIVE != 0 && o.gen == uint8(id >> SLOT_BITS);
    }

    // ------------------------------------------------------------------ setup

    /// @dev Opens the book. `maxFills_` bounds the orders one taker order may examine (spec: set
    ///      from measured gas, the UI then requests less); must be at least 1.
    function _initBook(uint8 maxFills_) internal {
        BookState storage b = _book;
        if (_isOpen(b)) revert MarketExists();
        for (uint256 w; w < WORDS; ++w) {
            b.bits[ASK][w] = SENTINEL;
            b.bits[BID][w] = SENTINEL;
        }
        b.orders.push(); // slot 0 is the null order
        _setMaxFills(maxFills_);
    }

    /// @dev Retunes the fill bound; the owning module authorises the caller.
    function _setMaxFills(uint8 maxFills_) internal {
        if (maxFills_ == 0) revert BadMaxFills();
        _openBook().maxFills = maxFills_;
        emit MaxFillsSet(maxFills_);
    }

    function _isOpen(BookState storage b) internal view returns (bool) {
        return b.bits[ASK][0] != 0;
    }

    function _openBook() internal view returns (BookState storage b) {
        b = _book;
        if (!_isOpen(b)) revert NoMarket();
    }

    // ------------------------------------------------------------------ bitmap

    function _setBit(BookState storage b, uint8 side, uint16 tick) internal {
        unchecked {
            uint256 i = tick - 1;
            b.bits[side][i / TICKS_PER_WORD] |= 1 << (i % TICKS_PER_WORD);
        }
    }

    function _clearBit(BookState storage b, uint8 side, uint16 tick) internal {
        unchecked {
            uint256 i = tick - 1;
            b.bits[side][i / TICKS_PER_WORD] &= ~(1 << (i % TICKS_PER_WORD));
        }
    }

    /// @dev Highest set tick bit on the bid side, scanning at most four words.
    function _bestBid(BookState storage b) internal view returns (uint16) {
        unchecked {
            for (uint256 w = WORDS; w != 0;) {
                --w;
                uint256 x = b.bits[BID][w] & TICK_MASK;
                if (x != 0) return uint16(w * TICKS_PER_WORD + LibBit.fls(x) + 1);
            }
        }
        return NONE;
    }

    /// @dev Lowest set tick bit on the ask side, scanning at most four words.
    function _bestAsk(BookState storage b) internal view returns (uint16) {
        unchecked {
            for (uint256 w; w < WORDS; ++w) {
                uint256 x = b.bits[ASK][w] & TICK_MASK;
                if (x != 0) return uint16(w * TICKS_PER_WORD + LibBit.ffs(x) + 1);
            }
        }
        return NONE;
    }
}
