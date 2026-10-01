"""G1 combined reference trace (integration-owned).

One unified reference engine over both lanes, no placeholder port:
  Person A: ledger, coverage (order-aware deficits, reserve slacks, 2% concentration), funding,
            premium integral, settlement payouts/allocation.
  Person B: margin kernel, all-prefix order admission, funding-rate quantization, liquidation
            eligibility/takeover authorization.
B's admission receives A's real coverage port instead of the B006 scripted stand-in.
Exact Fraction / integer arithmetic only.
"""
from dataclasses import replace
from fractions import Fraction as F

from reference.a import coverage as cov
from reference.a import funding as fd
from reference.a import ledger as lg
from reference.a import premium_integral as pi
from reference.a import settlement as st
from reference.b import liquidation as lq
from reference.b import margin as mg
from reference.b import order_admission as oa
from reference.b import pricing as pr

Q = 10**18
USDC = 10**6 * Q
T29 = F(29 * 86400)


def a_coverage_port(reserve, others, seed_q):
    """B's CoverageInput computed by Person A's coverage module for a candidate state."""
    def port(cash_q, x, s):
        d0, d1 = cov.deficits(lg.Account(x, cash_q), cov.Orders(s.bid_lots, s.bid_value_q, s.ask_lots,
                                                                 s.ask_value_q, s.fee_cap_q))
        o0 = sum(cov.deficits(a, o)[0] for a, o in others)
        o1 = sum(cov.deficits(a, o)[1] for a, o in others)
        s0, s1 = cov.slacks(reserve, o0 + d0, o1 + d1)
        return oa.CoverageInput(d0, d1, seed_q // 50, s0 >= 0 and s1 >= 0)
    return port


def run():
    out = {}
    reserve = lg.Account(0, 100_000 * USDC)
    seed = reserve.cash_q
    alice = lg.Account(0, 120 * USDC)
    bob = lg.Account(0, 400 * USDC)
    profile = mg.fixture_profile(cap=5)
    kernel = oa.margin_kernel(6 * 10**17, T29, profile)

    # 1. Admission (B) with A's coverage: Bob's fully backed ask rests, Alice's 5x bid is admitted.
    bob_ask = oa.add_order(oa.OrderSums(), False, 1_000_000, 600)
    alice_bid = oa.add_order(oa.OrderSums(), True, 1_000_000, 600)
    bob_orders = cov.Orders(0, 0, bob_ask.ask_lots, bob_ask.ask_value_q, 0)
    port = a_coverage_port(reserve, [(bob, bob_orders)], seed)
    out["admit_alice"] = oa.admit(alice.cash_q, 0, 6 * 10**17, alice_bid, kernel, port)

    # 2. Paired fill (A).
    alice, bob, fees = lg.fill(alice, bob, 1_000_000, 600)
    out["after_fill"] = (int(alice.cash_q), alice.lots, int(bob.cash_q), bob.lots, fees)
    d0a, d1a = cov.deficits(alice)
    d0b, d1b = cov.deficits(bob)
    out["deficits"] = (d0a, d1a, d0b, d1b)
    out["slacks_after_fill"] = cov.slacks(reserve, d0a + d0b, d1a + d1b)

    # 3. Margin / health (B).
    h = mg.health(int(alice.cash_q), alice.lots, 6 * 10**17, T29, profile)
    out["alice_health"] = (h.status, h.im_q, h.mm_q, h.mark_equity_q)

    # 4. Funding (B rate quantization, A epoch accounting).
    r = pr.funding_rate(62 * 10**16, 60 * 10**16)
    out["rate"] = r
    oi = 1_000_000
    slack = min(out["slacks_after_fill"])
    e = fd.open_epoch(0, 3600, r, oi, slack)
    e, rp = fd.advance(e, 600, 10**9, 10**9, oi, 0)
    e, alice_cash, alice_cp = fd.sync(e, alice.lots, 0, alice.cash_q)
    e, bob_cash, bob_cp = fd.sync(e, bob.lots, 0, bob.cash_q)
    out["funding"] = (e.index, int(alice.cash_q - alice_cash), int(bob.cash_q - bob_cash), e.cushion, e.clearing + rp)
    alice = lg.Account(alice.lots, alice_cash)
    bob = lg.Account(bob.lots, bob_cash)

    # 5. Premium (A): principal NO deficit of Alice over [0,600] with 4x surcharge on the new deficit.
    principal = -480 * USDC  # cash at segment origin (funding enters through the affine slope)
    args = (principal, 1_000_000, r, 0)
    full = pi.cumulative(*args, 600, 3600, 6 * 3600, 10**14, 10**14, Q)
    half = pi.cumulative(*args, 300, 3600, 6 * 3600, 10**14, 10**14, Q)
    first = pi.cumulative_charge(half)
    second = pi.cumulative_charge(full, first)
    out["premium"] = (first, second, pi.cumulative_charge(full))
    premium = first + second
    alice = lg.Account(alice.lots, alice.cash_q - premium)
    reserve = lg.Account(reserve.lots, reserve.cash_q + premium)

    # 6. Liquidation decisions (B) on the real ledger state.
    em50 = mg.mark_equity(int(alice.cash_q), alice.lots, 5 * 10**17)
    h50 = mg.health(int(alice.cash_q), alice.lots, 5 * 10**17, T29, profile)
    e0, e1 = mg.endpoints(int(alice.cash_q), alice.lots)
    out["liq_050"] = lq.eligibility(True, False, False, e0, e1, em50, h50.mm_q, h50.im_q)
    em48 = mg.mark_equity(int(alice.cash_q), alice.lots, 48 * 10**16)
    out["takeover_048"] = lq.authorize_takeover(True, False, e0, e1, em48)
    out["takeover_stale"] = lq.authorize_takeover(False, False, e0, e1, None)

    # 7. Terminal payoff (A) for all three outcomes; assets = market cash.
    assets = int(alice.cash_q + bob.cash_q + reserve.cash_q)
    out["assets_q"] = assets
    pay = {}
    for label, p in (("NO", 0), ("YES", 1), ("INVALID", F(1, 2))):
        claims = [st.payout(alice, p), st.payout(bob, p)]
        payouts, treasury = st.allocation(assets, claims, 0, [], [1])
        pay[label] = (claims, payouts[0], treasury)
    out["payoff"] = pay
    return out


if __name__ == "__main__":
    import json
    print(json.dumps(run(), default=str, indent=1))
