// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {RejectCode} from "../../../src/math/RiskTypes.sol";
import {RiskFixture} from "./B011.t.sol";

/// B012: certified order-risk calculations. The coverage function below is a scripted stand-in
/// for Person A's order-aware deficits and reserve check (spec §7.3 formulas on fixed fixtures).
contract B012Test is Test {
    uint256 constant Q = 1e18;
    uint256 constant U = 1000 * Q;
    uint256 constant USDC = 1e24;
    uint256 constant QW = 6e17;

    uint256 reserveQ = 100_000 * USDC;
    uint256 capQ = 2_000 * USDC;

    struct Ord {
        bool isBid;
        uint256 lots;
        uint16 tick;
    }

    function cov(OA.Account memory a, OA.OrderSums memory s)
        internal
        view
        returns (OA.CoverageInput memory c)
    {
        int256 cEff = a.cashQ - int256(s.feeCapQ);
        int256 e0 = cEff - int256(s.bidValueQ);
        int256 e1 = cEff + int256(U) * a.lots - int256(U * s.askLots) + int256(s.askValueQ);
        c.d0Q = e0 < 0 ? uint256(-e0) : 0;
        c.d1Q = e1 < 0 ? uint256(-e1) : 0;
        c.deficitCapQ = capQ;
        c.marketOk = reserveQ >= c.d0Q && reserveQ >= c.d1Q;
    }

    function pr(uint256 secs) internal pure returns (OA.Pricing memory) {
        return OA.Pricing(QW, secs, 0);
    }

    function acct(int256 cashQ, int256 lots) internal pure returns (OA.Account memory) {
        return OA.Account(cashQ, lots);
    }

    // ------------------------------------------------------------------ direct 5x

    function test_directFiveXAdmitted() public view {
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), true, 1_000_000, 600, 0);
        OA.Account memory a = acct(int256(120 * USDC), 0);
        assertEq(OA.eMinQ(a.cashQ, 0, QW, s), int256(120 * USDC));
        (uint256 im, bool full) = OA.imUpperQ(0, s, pr(29 days), RiskFixture.profile(5, true));
        assertEq(im, 120 * USDC);
        assertFalse(full);
        (bool ok, RejectCode r) = OA.admit(a, s, pr(29 days), RiskFixture.profile(5, true), cov(a, s));
        assertTrue(ok);
        assertEq(uint8(r), uint8(RejectCode.NONE));
    }

    function test_directFiveXFailsWithSmallReserve() public {
        reserveQ = 479 * USDC;
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), true, 1_000_000, 600, 0);
        OA.Account memory a = acct(int256(120 * USDC), 0);
        (bool ok, RejectCode r) = OA.admit(a, s, pr(29 days), RiskFixture.profile(5, true), cov(a, s));
        assertFalse(ok);
        assertEq(uint8(r), uint8(RejectCode.MARKET_COVERAGE));
    }

    function test_deficitCap() public {
        capQ = 479 * USDC;
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), true, 1_000_000, 600, 0);
        OA.Account memory a = acct(int256(120 * USDC), 0);
        (bool ok, RejectCode r) = OA.admit(a, s, pr(29 days), RiskFixture.profile(5, true), cov(a, s));
        assertFalse(ok);
        assertEq(uint8(r), uint8(RejectCode.ACCOUNT_DEFICIT_CAP));
    }

    function test_halvingCap() public view {
        OA.TakerRequest memory req = OA.TakerRequest(2_000_000, true, 600, 0, 1);
        (uint256 cap, uint256 steps, RejectCode r) = OA.safeTakerCap(
            req, acct(int256(120 * USDC), 0), OA.emptySums(), pr(29 days), RiskFixture.profile(5, true), cov
        );
        assertEq(cap, 1_000_000);
        assertEq(steps, 1);
        assertEq(uint8(r), uint8(RejectCode.NONE));
    }

    function test_halvingBoundedAndMinSize() public view {
        OA.TakerRequest memory req = OA.TakerRequest(type(uint64).max, true, 999, 0, 1);
        (uint256 cap, uint256 steps,) =
            OA.safeTakerCap(req, acct(0, 0), OA.emptySums(), pr(29 days), RiskFixture.profile(5, true), cov);
        assertEq(cap, 0);
        assertLe(steps, 64);
        req = OA.TakerRequest(10, true, 600, 0, 20);
        (cap,,) = OA.safeTakerCap(
            req, acct(int256(1e30), 0), OA.emptySums(), pr(29 days), RiskFixture.profile(5, true), cov
        );
        assertEq(cap, 0, "below minimum size");
    }

    // ------------------------------------------------------------------ 1x exactness

    function test_exactOneXBid() public view {
        uint256 fee = 7 * Q;
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), true, 1000, 650, fee);
        uint256 exact = 1000 * 650 * Q + fee;
        OA.Account memory a = acct(int256(exact), 0);
        (bool ok,) = OA.admit(a, s, pr(29 days), RiskFixture.profile(1, true), cov(a, s));
        assertTrue(ok);
        a = acct(int256(exact) - 1, 0);
        (ok,) = OA.admit(a, s, pr(29 days), RiskFixture.profile(1, true), cov(a, s));
        assertFalse(ok);
    }

    function test_oversizedAskRejectedAtOneX() public view {
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), false, 2300, 550, 0);
        OA.Account memory a = acct(0, 1000);
        OA.CoverageInput memory c = cov(a, s);
        assertEq(c.d1Q, 35_000 * Q);
        (bool ok,) = OA.admit(a, s, OA.Pricing(55e16, 29 days, 0), RiskFixture.profile(1, true), c);
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ reservations

    function test_cancelUsesTickAndExtremaStay() public pure {
        OA.OrderSums memory s = OA.addOrder(OA.addOrder(OA.emptySums(), true, 7, 400, 0), true, 11, 600, 0);
        s = OA.removeOrder(s, true, 7, 400, 0);
        assertEq(s.bidLots, 11);
        assertEq(s.bidValueQ, 6600 * Q);
        s = OA.addOrder(s, true, 5, 700, 0);
        s = OA.removeOrder(s, true, 5, 700, 0);
        assertEq(s.maxBidTick, 700, "stale extremum stays pessimistic");
    }

    function test_staleExtremaConservative() public pure {
        OA.OrderSums memory tight = OA.addOrder(OA.emptySums(), true, 10, 600, 0);
        OA.OrderSums memory stale = OA.addOrder(OA.emptySums(), true, 5, 700, 0);
        stale = OA.removeOrder(stale, true, 5, 700, 0);
        stale = OA.addOrder(stale, true, 10, 600, 0);
        assertLt(OA.eMinQ(int256(1000 * Q), 0, QW, stale), OA.eMinQ(int256(1000 * Q), 0, QW, tight));
    }

    function test_underflowReverts() public {
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), true, 5, 300, 0);
        vm.expectRevert(OA.ReservationUnderflow.selector);
        this.removeExt(s, true, 6, 300);
        vm.expectRevert(OA.ReservationUnderflow.selector);
        this.removeExt(s, true, 5, 400);
    }

    function removeExt(OA.OrderSums memory s, bool isBid, uint256 lots, uint16 tick)
        external
        pure
        returns (OA.OrderSums memory)
    {
        return OA.removeOrder(s, isBid, lots, tick, 0);
    }

    function test_reduceOnlyCap() public pure {
        assertEq(OA.reduceOnlyCap(3, false, 10), 3);
        assertEq(OA.reduceOnlyCap(3, true, 10), 0);
        assertEq(OA.reduceOnlyCap(0, false, 10), 0);
        assertEq(OA.reduceOnlyCap(-4, true, 10), 4);
    }

    // ------------------------------------------------------------------ side flip

    function test_sideFlipEvaluatesShortSide() public pure {
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), false, 12, 600, 0);
        (int256 lo, int256 hi) = OA.reach(2, s);
        assertEq(lo, -10);
        assertEq(hi, 2);
        (uint256 im,) = OA.imUpperQ(2, s, pr(29 days), RiskFixture.profile(5, true));
        MarginMath.Margin memory shortM =
            MarginMath.sideMargin(10, false, QW, 29 days, 0, RiskFixture.profile(5, true));
        MarginMath.Margin memory longM =
            MarginMath.sideMargin(2, true, QW, 29 days, 0, RiskFixture.profile(5, true));
        assertEq(im, shortM.imQ > longM.imQ ? shortM.imQ : longM.imQ);
    }

    // ------------------------------------------------------------------ enumeration

    /// Every admitted small state is safe for every fill mixture: E' >= IM(x') (or both endpoints
    /// nonnegative when that size is fully backed), and Emin <= E' always.
    function test_enumerateAdmittedStates() public view {
        Ord[] memory o = new Ord[](3);
        o[0] = Ord(true, 3, 620);
        o[1] = Ord(false, 2, 580);
        o[2] = Ord(false, 4, 610);
        uint256 admitted;
        int256[4] memory xs = [int256(-3), 0, 2, 5];
        for (uint256 xi; xi < 4; ++xi) {
            for (int256 cashUnits = -4000; cashUnits <= 6000; cashUnits += 500) {
                if (_checkState(cashUnits * int256(Q), xs[xi], o, 3600)) ++admitted;
            }
        }
        assertGt(admitted, 10);
    }

    struct St {
        int256 cashQ;
        int256 x;
        bool ok;
        int256 emin;
        uint256 secs;
    }

    function _checkState(int256 cashQ, int256 x, Ord[] memory o, uint256 secs) internal view returns (bool) {
        OA.OrderSums memory s = OA.emptySums();
        for (uint256 i; i < o.length; ++i) {
            s = OA.addOrder(s, o[i].isBid, o[i].lots, o[i].tick, 0);
        }
        OA.Account memory a = acct(cashQ, x);
        St memory st = St(cashQ, x, false, OA.eMinQ(cashQ, x, QW, s), secs);
        (st.ok,) = OA.admit(a, s, pr(secs), RiskFixture.profile(5, true), cov(a, s));
        for (uint256 f0; f0 <= o[0].lots; ++f0) {
            for (uint256 f1; f1 <= o[1].lots; ++f1) {
                for (uint256 f2; f2 <= o[2].lots; ++f2) {
                    _checkMixture(st, o, [f0, f1, f2]);
                }
            }
        }
        return st.ok;
    }

    function _checkMixture(St memory st, Ord[] memory o, uint256[3] memory f) internal pure {
        (int256 c2, int256 x2) = _fill(st.cashQ, st.x, o, f);
        int256 e2 = MarginMath.markEquityQ(c2, x2, QW);
        assertGe(e2, st.emin, "Emin lower bound");
        if (st.ok) _assertSafe(c2, x2, e2, st.secs);
    }

    function _assertSafe(int256 c2, int256 x2, int256 e2, uint256 secs) internal pure {
        uint256 n = x2 >= 0 ? uint256(x2) : uint256(-x2);
        MarginMath.Margin memory m =
            MarginMath.sideMargin(n, x2 > 0, QW, secs, 0, RiskFixture.profile(5, true));
        if (m.fullBacking) {
            (int256 e0, int256 e1) = MarginMath.endpoints(c2, x2);
            assertGe(e0, 0, "admitted full-backing prefix NO");
            assertGe(e1, 0, "admitted full-backing prefix YES");
        } else {
            assertGe(e2, int256(m.imQ), "admitted prefix meets IM");
        }
    }

    function _fill(int256 cashQ, int256 x, Ord[] memory o, uint256[3] memory f)
        internal
        pure
        returns (int256, int256)
    {
        for (uint256 i; i < 3; ++i) {
            int256 v = int256(f[i] * o[i].tick * Q);
            if (o[i].isBid) {
                x += int256(f[i]);
                cashQ -= v;
            } else {
                x -= int256(f[i]);
                cashQ += v;
            }
        }
        return (cashQ, x);
    }

    function testFuzz_eminLowerBoundOneOrder(uint16 tick, uint8 lots, uint8 filled, uint64 q, bool isBid)
        public
        pure
    {
        uint16 t = uint16(bound(tick, 1, 999));
        uint256 n = bound(lots, 1, 200);
        uint256 f = bound(filled, 0, n);
        uint256 qq = bound(q, 1, 1e18 - 1);
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), isBid, n, t, 0);
        int256 emin = OA.eMinQ(0, 0, qq, s);
        int256 dx = isBid ? int256(f) : -int256(f);
        int256 dc = isBid ? -int256(f * t * Q) : int256(f * t * Q);
        assertGe(MarginMath.markEquityQ(dc, dx, qq), emin);
    }
}
