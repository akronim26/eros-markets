"""B015: export independent B-reference results as a Solidity differential test.

Writes contracts/test/math/B/RiskDifferential.t.sol. Every expected value comes from the Python
reference in reference/b (Fraction + directed sqrt brackets); nothing here calls Solidity. The
generated file embeds the vectors so the forge run needs no filesystem or FFI permission.

Run from the repo root:  python reference/b/export_vectors.py
Deterministic: fixed seed SEED; rerunning produces a byte-identical file.
"""
import random
import sys
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from reference.b import horizon_volatility as hv  # noqa: E402
from reference.b import hazards as hz  # noqa: E402
from reference.b import liquidation as lq  # noqa: E402
from reference.b import lifecycle as lc  # noqa: E402
from reference.b import margin as mg  # noqa: E402
from reference.b import order_admission as oa  # noqa: E402
from reference.b import pricing as pr  # noqa: E402

SEED = 20261001
OUT = ROOT / "contracts/test/math/B/RiskDifferential.t.sol"
Q = 10**18
W = 10**18
U = 1000 * Q
STAGE = {s: i for i, s in enumerate(lc.STAGES)}


def up(v: F) -> int:
    v = F(v) * W
    return -((-v.numerator) // v.denominator)


def margin_vectors(rng):
    p = mg.fixture_profile(cap=5)
    rows = []
    sizes = [1, 7, 999, 1000, 12345, 250_000, 1_000_000, 3_333_333, 10**8, 2**40]
    qs = [10**15, 5 * 10**16, 3 * 10**17, 6 * 10**17, 95 * 10**16, 999 * 10**15]
    secs = [1, 3600, 86400, 7 * 86400, 29 * 86400]
    for _ in range(90):
        n, q, s, is_long = rng.choice(sizes), rng.choice(qs), rng.choice(secs), rng.random() < 0.5
        r = mg.side_margin(F(n, 1000), is_long, F(q, W), F(s), p)
        rows.append((n, is_long, q, s, mg.to_q_up(r.mm_hi), mg.to_q_up(r.im_hi), r.full_backing))
    for n, is_long in [(1_000_000, True), (1_000_000, False)]:
        r = mg.side_margin(F(n, 1000), is_long, F(6, 10), F(29 * 86400), p)
        rows.append((n, is_long, 6 * 10**17, 29 * 86400, mg.to_q_up(r.mm_hi), mg.to_q_up(r.im_hi), r.full_backing))
    return rows


def tail_vectors(rng):
    rows = []
    for _ in range(40):
        a0 = rng.randrange(0, 12 * 10**15)
        a1 = rng.randrange(0, 12 * 10**15)
        is_long = rng.random() < 0.5
        t = hz.tail(F(a0, W), F(a1, W), is_long, F(1, 100))
        rows.append((a0, a1, is_long, t.full_backing, 0 if t.full_backing else up(t.k[1])))
    return rows


def twap_vectors(rng):
    cases = []
    for _ in range(40):
        t, samples = 10_000, []
        for _i in range(rng.randrange(0, 14)):
            t += rng.choice([0, 1, 5, 17, 29, 30, 31, 45])
            samples.append(pr.Sample(t, rng.randrange(1, W), rng.random() > 0.15))
        end = t + rng.choice([0, 3, 30, 31])
        win = rng.choice([1, 10, 30, 60, 90, 300])
        if win > end:
            win = end
        r = pr.twap(samples, end, win)
        cases.append((samples, end, win, r.available, r.twap_wad if r.available else 0, r.covered_secs))
    return cases


def estimate_vectors(rng):
    p = mg.fixture_profile(cap=5)
    rows = []
    for _ in range(30):
        n = rng.choice([1000, 50_000, 1_000_000, 7_654_321])
        q = rng.choice([3 * 10**17, 6 * 10**17])
        h = mg.health(0, n, q, F(29 * 86400), p)
        eq = rng.randrange(1, max(2, h.im_q))
        lots, full = lq.size_estimate_lots(h.im_q, eq, n, p.s, p.lam)
        rows.append((h.im_q, eq, n, lots, full))
    return rows


def bankruptcy_vectors(rng):
    rows = []
    for _ in range(30):
        x = rng.choice([1, -1]) * rng.randrange(1000, 2_000_000)
        n = rng.randrange(1, abs(x) + 1)
        cash = rng.randrange(-700, 700) * 10**6 * Q
        q = rng.randrange(10**16, 99 * 10**16)
        fee = n * Q
        th = rng.randrange(0, 5) * 10**6 * Q
        t, ok = lq.bankruptcy_tick(x, n, cash, q, fee, th)
        rows.append((x, n, cash, q, fee, th, t or 0, ok))
    return rows


def stage_vectors(rng):
    rows = []
    T = 5_000_000
    for _ in range(60):
        now = T - rng.choice([100_000, 45_001, 45_000, 44_000, 43_200, 43_199, 3_601, 3_600, 1, 0, -1, -500])
        halt = rng.choice([0, 0, 0, T - 50_000, T - 2_000])
        mon = rng.random() < 0.2
        v = lc.derive_stage(now, T, halt or None, mon)
        rows.append((now, T, halt, mon, STAGE[v.stage], v.full_backing_by_time, v.funding_frozen))
    return rows


def admission_vectors():
    """Small states: reference admit flag and whether every fill mixture is safe (enumeration)."""
    import itertools
    p = mg.fixture_profile(cap=5)
    qw = 6 * 10**17
    kernel = oa.margin_kernel(qw, F(3600), p)
    books = [[(True, 3, 620), (False, 2, 580), (False, 1, 600)],
             [(True, 4, 590), (True, 2, 640), (False, 1, 700)],
             [(False, 4, 610), (False, 3, 560), (True, 1, 600)]]
    rows = []
    for bi, orders in enumerate(books):
        for x in (-3, 0, 2):
            for cu in range(-3000, 5001, 1000):
                cash = cu * Q
                s = oa.OrderSums()
                for o in orders:
                    s = oa.add_order(s, *o)

                def port(c, xx, ss):
                    ce = c - ss.fee_cap_q
                    d0 = max(0, -(ce - ss.bid_value_q))
                    d1 = max(0, -(ce + U * xx - U * ss.ask_lots + ss.ask_value_q))
                    return oa.CoverageInput(d0, d1, 2000 * 10**24, True)
                ok, _ = oa.admit(cash, x, qw, s, kernel, port)
                safe = True
                for fills in itertools.product(*[range(o[1] + 1) for o in orders]):
                    c2, x2 = cash, x
                    for (isb, _l, tk), f in zip(orders, fills):
                        c2, x2 = (c2 - f * tk * Q, x2 + f) if isb else (c2 + f * tk * Q, x2 - f)
                    im2, full2 = kernel(abs(x2), x2 > 0)
                    e2 = c2 + x2 * 1000 * qw
                    if (min(c2, c2 + U * x2) if full2 else e2 - im2) < 0:
                        safe = False
                rows.append((bi, x, cash, ok, safe))
    return books, rows


def b(v):
    return "true" if v else "false"


def main():
    rng = random.Random(SEED)
    L = []
    L.append("// SPDX-License-Identifier: MIT")
    L.append("pragma solidity ^0.8.30;")
    L.append("")
    L.append("// GENERATED by reference/b/export_vectors.py (seed %d). Do not edit by hand." % SEED)
    L.append("// Expected values come from the independent Python reference (reference/b); tolerance T-1.")
    L.append("")
    L.append('import {Test} from "forge-std/Test.sol";')
    L.append('import {MarginMath} from "../../../src/math/MarginMath.sol";')
    L.append('import {HazardMath} from "../../../src/math/HazardMath.sol";')
    L.append('import {PricingMath as PM} from "../../../src/math/PricingMath.sol";')
    L.append('import {LiquidationMath as LM} from "../../../src/math/LiquidationMath.sol";')
    L.append('import {LifecycleMath as LC} from "../../../src/math/LifecycleMath.sol";')
    L.append('import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";')
    L.append('import {RiskFixture} from "./B011.t.sol";')
    L.append("")
    L.append("abstract contract RiskDifferential is Test {")
    L.append("    uint256 internal constant QD = 1e18;")
    L.append("    uint256 internal constant UD = 1000 * QD;")
    L.append("")
    L.append("    function _upper(uint256 sol, uint256 refHi, string memory what) internal pure {")
    L.append("        assertGe(sol, refHi, what);")
    L.append("        uint256 tol = refHi / 1e12 > 1e3 ? refHi / 1e12 : 1e3;")
    L.append("        assertLe(sol - refHi, tol, what);")
    L.append("    }")
    L.append("")
    # margin
    L.append("    function _m(uint256 n, bool isLong, uint256 q, uint256 s, uint256 mm, uint256 im, bool full) internal pure {")
    L.append("        MarginMath.Margin memory r = MarginMath.sideMargin(n, isLong, q, s, 0, RiskFixture.profile(5, true));")
    L.append("        if (full) {")
    L.append('            assertTrue(r.fullBacking, "reference full backing");')
    L.append('            assertEq(r.imQ, im, "full-backing IM = worst loss");')
    L.append("        } else {")
    L.append('            _upper(r.mmQ, mm, "MM");')
    L.append('            _upper(r.imQ, im, "IM");')
    L.append("        }")
    L.append("    }")
    L.append("")
    L.append("    function test_diffMargin() public pure {")
    for n, il, q, s, mm, im, full in margin_vectors(rng):
        L.append(f"        _m({n}, {b(il)}, {q}, {s}, {mm}, {im}, {b(full)});")
    L.append("    }")
    L.append("")
    # tail
    L.append("    function test_diffTail() public pure {")
    L.append("        HazardMath.Tail memory t;")
    for a0, a1, il, full, k in tail_vectors(rng):
        L.append(f"        t = HazardMath.tail({a0}, {a1}, {b(il)}, 1e16);")
        if full:
            L.append("        assertTrue(t.fullBacking);")
        else:
            L.append("        assertFalse(t.fullBacking);")
            L.append(f'        _upper(t.kWad, {k}, "k");')
    L.append("    }")
    L.append("")
    # twap
    L.append("    function test_diffTwap() public pure {")
    L.append("        PM.Sample[] memory x;")
    L.append("        PM.Twap memory r;")
    for samples, end, win, avail, tw, cov in twap_vectors(rng):
        L.append(f"        x = new PM.Sample[]({len(samples)});")
        for i, sm in enumerate(samples):
            L.append(f"        x[{i}] = PM.Sample({sm.t}, {sm.price_wad}, {b(sm.valid)});")
        L.append(f"        r = PM.twap(x, {end}, {win}, 30);")
        L.append(f"        assertEq(r.available, {b(avail)});")
        L.append(f"        assertEq(r.coveredSecs, {cov});")
        if avail:
            L.append(f"        assertEq(r.twapWad, {tw});")
    L.append("    }")
    L.append("")
    # estimate
    L.append("    function test_diffEstimate() public pure {")
    L.append("        uint256 lots;")
    L.append("        bool full;")
    for im, eq, n, lots, full in estimate_vectors(rng):
        L.append(f"        (lots, full) = LM.sizeEstimateLots({im}, {eq}, {n}, 5e15, 1e12);")
        L.append(f"        assertEq(full, {b(full)});")
        L.append(f"        assertGe(lots, {lots});")
        L.append(f"        assertLe(lots, {lots} + 1);")
    L.append("    }")
    L.append("")
    # bankruptcy
    L.append("    function test_diffBankruptcy() public pure {")
    L.append("        uint16 t;")
    L.append("        bool ok;")
    for x, n, cash, q, fee, th, t, ok in bankruptcy_vectors(rng):
        L.append(f"        (t, ok) = LM.bankruptcyTick({x}, {n}, {cash}, {q}, {fee}, {th});")
        L.append(f"        assertEq(ok, {b(ok)});")
        if ok:
            L.append(f"        assertEq(t, {t});")
    L.append("    }")
    L.append("")
    # stages
    L.append("    function test_diffStage() public pure {")
    L.append("        LC.StageView memory v;")
    for now, T, halt, mon, st, fb, ff in stage_vectors(rng):
        L.append(f"        v = LC.deriveStage({now}, {T}, {halt}, {b(mon)}, false);")
        L.append(f"        assertEq(uint8(v.stage), {st});")
        L.append(f"        assertEq(v.fullBackingByTime, {b(fb)});")
        L.append(f"        assertEq(v.fundingFrozen, {b(ff)});")
    L.append("    }")
    L.append("")
    # admission
    books, rows = admission_vectors()
    L.append("    function _book(uint256 i) internal pure returns (OA.OrderSums memory s) {")
    L.append("        s = OA.emptySums();")
    for bi, orders in enumerate(books):
        L.append(f"        if (i == {bi}) {{")
        for isb, lots, tick in orders:
            L.append(f"            s = OA.addOrder(s, {b(isb)}, {lots}, {tick}, 0);")
        L.append("        }")
    L.append("    }")
    L.append("")
    L.append("    function _cov(int256 c, int256 x, OA.OrderSums memory s) internal pure returns (OA.CoverageInput memory v) {")
    L.append("        int256 e0 = c - int256(s.feeCapQ) - int256(s.bidValueQ);")
    L.append("        int256 e1 = c - int256(s.feeCapQ) + int256(UD) * x - int256(UD * s.askLots) + int256(s.askValueQ);")
    L.append("        v.d0Q = e0 < 0 ? uint256(-e0) : 0;")
    L.append("        v.d1Q = e1 < 0 ? uint256(-e1) : 0;")
    L.append("        v.deficitCapQ = 2000 * 1e24;")
    L.append("        v.marketOk = true;")
    L.append("    }")
    L.append("")
    L.append("    function _a(uint256 book, int256 x, int256 cash, bool refOk, bool refSafe) internal pure {")
    L.append("        OA.OrderSums memory s = _book(book);")
    L.append("        (bool ok,) = OA.admit(OA.Account(cash, x), s, OA.Pricing(6e17, 3600, 0), RiskFixture.profile(5, true), _cov(cash, x, s));")
    L.append("        if (ok) {")
    L.append('            assertTrue(refOk, "Solidity admits only what the reference admits");')
    L.append('            assertTrue(refSafe, "every admitted prefix passes reference enumeration");')
    L.append("        }")
    L.append("    }")
    L.append("")
    L.append("    function test_diffAdmission() public pure {")
    for bi, x, cash, ok, safe in rows:
        L.append(f"        _a({bi}, {x}, {cash}, {b(ok)}, {b(safe)});")
    L.append("    }")
    L.append("}")
    L.append("")
    OUT.write_text("\n".join(L))
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
