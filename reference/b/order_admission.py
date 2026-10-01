"""B006 reference: all-prefix order admission (spec §7.3, §7.5 `_riskPrepareTaker`, DEC-05).

Ledger units: cash and values in Q, sizes in lots, prices in ticks or wad. The margin kernel is
called at the boundary through `kernel(abs_lots, is_long) -> (im_q, full_backing)`.

Endpoint deficits and market coverage are Person A quantities (A004/A013). Until G1 they arrive
through a scripted `coverage_port(cash_q, x_lots, sums) -> CoverageInput`; this module never
computes reserve coverage itself.
"""
from dataclasses import dataclass, replace
from fractions import Fraction as F
from typing import Callable, Optional, Tuple

from reference.b import margin as mg

Q = 10**18
NO_BID = 0
NO_ASK = 1000
MAX_HALVINGS = 64

Kernel = Callable[[int, bool], Tuple[int, bool]]


@dataclass(frozen=True)
class OrderSums:
    bid_lots: int = 0
    bid_value_q: int = 0
    ask_lots: int = 0
    ask_value_q: int = 0
    fee_cap_q: int = 0
    max_bid_tick: int = NO_BID
    min_ask_tick: int = NO_ASK


def _check_tick(tick: int) -> None:
    if not (1 <= tick <= 999):
        raise ValueError("BAD_UNITS: tick 1..999")


def add_order(s: OrderSums, is_bid: bool, lots: int, tick: int, fee_cap_q: int = 0) -> OrderSums:
    _check_tick(tick)
    if lots <= 0 or fee_cap_q < 0:
        raise ValueError("BAD_UNITS: lots > 0")
    if is_bid:
        return replace(s, bid_lots=s.bid_lots + lots, bid_value_q=s.bid_value_q + lots * tick * Q,
                       fee_cap_q=s.fee_cap_q + fee_cap_q, max_bid_tick=max(s.max_bid_tick, tick))
    return replace(s, ask_lots=s.ask_lots + lots, ask_value_q=s.ask_value_q + lots * tick * Q,
                   fee_cap_q=s.fee_cap_q + fee_cap_q, min_ask_tick=min(s.min_ask_tick, tick))


def remove_order(s: OrderSums, is_bid: bool, lots: int, tick: int, fee_cap_q: int = 0) -> OrderSums:
    """Exact release by tick. Extrema stay pessimistic (spec §7.2). Underflow is an error."""
    _check_tick(tick)
    if is_bid:
        if lots > s.bid_lots or lots * tick * Q > s.bid_value_q or fee_cap_q > s.fee_cap_q:
            raise AssertionError("reservation underflow")
        return replace(s, bid_lots=s.bid_lots - lots, bid_value_q=s.bid_value_q - lots * tick * Q,
                       fee_cap_q=s.fee_cap_q - fee_cap_q)
    if lots > s.ask_lots or lots * tick * Q > s.ask_value_q or fee_cap_q > s.fee_cap_q:
        raise AssertionError("reservation underflow")
    return replace(s, ask_lots=s.ask_lots - lots, ask_value_q=s.ask_value_q - lots * tick * Q,
                   fee_cap_q=s.fee_cap_q - fee_cap_q)


def e_min_q(cash_q: int, x_lots: int, q_wad: int, s: OrderSums) -> int:
    """Lower bound of marked equity over every fill prefix and bid/ask mixture."""
    m_q = 1000 * q_wad
    bid_adverse = max(s.max_bid_tick * Q - m_q, 0) if s.bid_lots else 0
    ask_adverse = max(m_q - s.min_ask_tick * Q, 0) if s.ask_lots else 0
    return cash_q + x_lots * m_q - s.bid_lots * bid_adverse - s.ask_lots * ask_adverse - s.fee_cap_q


def reach(x_lots: int, s: OrderSums) -> Tuple[int, int]:
    return x_lots - s.ask_lots, x_lots + s.bid_lots


def margin_kernel(q_wad: int, secs_to_t: F, p: mg.RiskProfile) -> Kernel:
    """Per-sign IM kernel in Q (rounded up) from the B005 reference margin."""
    q = F(q_wad, Q)

    def k(abs_lots: int, is_long: bool) -> Tuple[int, bool]:
        r = mg.side_margin(F(abs_lots, 1000), is_long, q, secs_to_t, p)
        return mg.to_q_up(r.im_hi), r.full_backing
    return k


def im_upper_q(x_lots: int, s: OrderSums, kernel: Kernel, certified_monotone: bool = True) -> Tuple[int, bool]:
    """max(LongIM(max(0, xHi)), ShortIM(max(0, -xLo))).

    If the kernel is not certified monotone, use the generic certified envelope: the maximum over
    every reachable size of that sign (bounded enumeration; reference only).
    """
    lo, hi = reach(x_lots, s)
    long_n, short_n = max(0, hi), max(0, -lo)
    if certified_monotone:
        li, lf = kernel(long_n, True)
        si, sf = kernel(short_n, False)
        return max(li, si), (lf and long_n > 0) or (sf and short_n > 0)
    best, full = 0, False
    for n in range(0, long_n + 1):
        v, f = kernel(n, True)
        best, full = max(best, v), full or (f and n > 0)
    for n in range(0, short_n + 1):
        v, f = kernel(n, False)
        best, full = max(best, v), full or (f and n > 0)
    return best, full


@dataclass(frozen=True)
class CoverageInput:
    d0_q: int            # order-aware NO endpoint deficit incl. fee caps (Person A)
    d1_q: int            # order-aware YES endpoint deficit incl. fee caps (Person A)
    deficit_cap_q: int   # 2% of reserveCapBaseQ
    market_ok: bool      # both R_y >= Dbar_y + B after replacing this account's contribution


CoveragePort = Callable[[int, int, OrderSums], CoverageInput]


def admit(cash_q: int, x_lots: int, q_wad: Optional[int], s: OrderSums, kernel: Optional[Kernel],
          coverage_port: CoveragePort, certified_monotone: bool = True) -> Tuple[bool, str]:
    """Decision for the account's commitments `s` (including any temporary taker permit)."""
    if q_wad is None or kernel is None:
        return False, "STALE_PRICE"
    cov = coverage_port(cash_q, x_lots, s)
    if not cov.market_ok:
        return False, "RESERVE_COVERAGE"
    if max(cov.d0_q, cov.d1_q) > cov.deficit_cap_q:
        return False, "DEFICIT_CAP"
    im, full = im_upper_q(x_lots, s, kernel, certified_monotone)
    if full:
        # Exact full-backing predicate: both order-aware endpoint deficits are zero.
        return (True, "NONE") if cov.d0_q == 0 and cov.d1_q == 0 else (False, "INSUFFICIENT_IM")
    return (True, "NONE") if e_min_q(cash_q, x_lots, q_wad, s) >= im else (False, "INSUFFICIENT_IM")


def reduce_only_cap(x_lots: int, is_bid: bool, requested: int) -> int:
    """Reduce-only: side must oppose the position; quantity clipped to |x|; never crosses zero."""
    if x_lots == 0 or (x_lots > 0) == is_bid:
        return 0
    return min(requested, abs(x_lots))


def safe_taker_cap(requested: int, is_bid: bool, limit_tick: int, fee_cap_per_lot_q: int,
                   cash_q: int, x_lots: int, q_wad: Optional[int], s: OrderSums,
                   kernel: Optional[Kernel], coverage_port: CoveragePort,
                   min_lots: int = 1, certified_monotone: bool = True) -> Tuple[int, int, str]:
    """Bounded halving search (at most 64 halvings). Every returned cap passes `admit` with the
    temporary commitment of that size added at the worst limit, so every prefix 0..cap is safe."""
    if requested < 0:
        raise ValueError("BAD_UNITS")
    cand, steps, reason = requested, 0, "NONE"
    while cand >= min_lots and cand > 0:
        trial = add_order(s, is_bid, cand, limit_tick, cand * fee_cap_per_lot_q)
        ok, reason = admit(cash_q, x_lots, q_wad, trial, kernel, coverage_port, certified_monotone)
        if ok:
            return cand, steps, "NONE"
        if steps == MAX_HALVINGS:
            break
        cand //= 2
        steps += 1
    return 0, steps, reason if reason != "NONE" else "BELOW_MIN_SIZE"
