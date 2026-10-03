pragma solidity ^0.8.30;

import {LibBit} from "solady/utils/LibBit.sol";
import {Book} from "../Book.sol";
import {RiskContext} from "./RiskPricing.sol";

abstract contract BookDepthSampler is Book {
    uint16 internal constant MAX_DEPTH_EXAMINED = 64;

    struct BookDepthQuote {
        uint256 bidWad;
        uint256 askWad;
        uint256 bidDepthLots;
        uint256 askDepthLots;
        uint16 examined;
        bytes32 fingerprint;
    }

    struct SideDepth {
        uint256 lots;
        uint256 notionalWad;
    }

    function _depthOrderEligibility(Order storage order, RiskContext memory context)
        internal
        view
        virtual
        returns (bool eligible, bytes32 accountFingerprint);

    function _scanBookDepth(uint256 targetLots, RiskContext memory context)
        internal
        view
        returns (BookDepthQuote memory quote)
    {
        if (targetLots == 0) return quote;
        SideDepth memory bids = _scanDepthSide(quote, true, targetLots, context);
        SideDepth memory asks = _scanDepthSide(quote, false, targetLots, context);
        quote.bidDepthLots = bids.lots;
        quote.askDepthLots = asks.lots;
        if (bids.lots == targetLots) quote.bidWad = bids.notionalWad / targetLots;
        if (asks.lots == targetLots) {
            quote.askWad = asks.notionalWad / targetLots;
            if (asks.notionalWad % targetLots != 0) ++quote.askWad;
        }
    }

    function _scanDepthSide(
        BookDepthQuote memory quote,
        bool isBid,
        uint256 targetLots,
        RiskContext memory context
    ) internal view returns (SideDepth memory depth) {
        for (uint256 wordOffset; wordOffset < WORDS; ++wordOffset) {
            if (quote.examined == MAX_DEPTH_EXAMINED || depth.lots == targetLots) break;
            uint256 wordIndex = isBid ? WORDS - 1 - wordOffset : wordOffset;
            uint256 remainingBits = _book.bits[isBid ? BID : ASK][wordIndex] & TICK_MASK;
            while (remainingBits != 0 && quote.examined < MAX_DEPTH_EXAMINED && depth.lots < targetLots) {
                uint256 bitIndex = isBid ? LibBit.fls(remainingBits) : LibBit.ffs(remainingBits);
                remainingBits &= ~(uint256(1) << bitIndex);
                uint16 tick = uint16(wordIndex * TICKS_PER_WORD + bitIndex + 1);
                _scanDepthLevel(quote, depth, isBid, tick, targetLots, context);
            }
        }
    }

    function _scanDepthLevel(
        BookDepthQuote memory quote,
        SideDepth memory depth,
        bool isBid,
        uint16 tick,
        uint256 targetLots,
        RiskContext memory context
    ) internal view {
        uint32 slot = _book.levels[tick][isBid ? BID : ASK].head;
        if (slot == 0) {
            ++quote.examined;
            quote.fingerprint = keccak256(abi.encode(quote.fingerprint, isBid, tick));
        }
        while (slot != 0 && quote.examined < MAX_DEPTH_EXAMINED && depth.lots < targetLots) {
            ++quote.examined;
            Order storage order = _book.orders[slot];
            bool eligible;
            bytes32 accountFingerprint;
            if (
                order.size != 0 && order.tick == tick && (order.flags & FLAG_LIVE) != 0
                    && ((order.flags & FLAG_BUY) != 0) == isBid && (order.flags & FLAG_REDUCE_ONLY) == 0
                    && (order.expiryBlock == 0 || block.number <= order.expiryBlock)
            ) (eligible, accountFingerprint) = _depthOrderEligibility(order, context);
            quote.fingerprint =
                keccak256(abi.encode(quote.fingerprint, slot, order, eligible, accountFingerprint));
            if (eligible) {
                uint256 lots = order.size;
                if (lots > targetLots - depth.lots) lots = targetLots - depth.lots;
                depth.lots += lots;
                depth.notionalWad += lots * tick * 1e15;
            }
            slot = order.next;
        }
    }
}
