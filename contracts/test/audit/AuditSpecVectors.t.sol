// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MathTypes as T} from "../../src/math/MathTypes.sol";
import {LedgerMath as L} from "../../src/math/LedgerMath.sol";
import {CoverageMath as C} from "../../src/math/CoverageMath.sol";
import {FundingMath as F} from "../../src/math/FundingMath.sol";
import {PremiumMath as P} from "../../src/math/PremiumMath.sol";
import {FeeMath} from "../../src/math/FeeMath.sol";
import {SettlementMath as S} from "../../src/math/SettlementMath.sol";

/// @notice Phase 1 audit of Person A's pure libraries against the spec's worked arithmetic
///         (docs/spec/verify_spec_vectors.py V01-V17, risk_spec section 11).
/// @dev Expected literals are hand/Fraction derived; reference/tests/audit/test_spec_vectors.py
///      re-derives the nontrivial ones independently. No Solidity output is used as an expectation.
contract AuditSpecVectorsTest is Test {
    uint256 constant Q = 1e18;
    uint256 constant V01_VALUE_Q = 10_421e18;
    uint256 constant V07_YES_DEFICIT_Q = 35_000e18;
    uint256 constant V12_PREMIUM_Q = 848_333333333333333334;
    uint256 constant V14_PREMIUM_Q = 3393_333333333333333334;

    // Units (DEC-01): Q = atom * 1e18, PAYOFF_Q_PER_LOT = 1000 Q.
    function testUnitsConstants() public pure {
        assertEq(T.Q, 1e18);
        assertEq(T.PAYOFF_Q_PER_LOT, 1000 * 1e18);
        assertEq(T.WAD_PER_TICK, 1e15);
        assertEq(uint256(int256(T.MAX_POSITION_LOTS)), 1 << 40);
        assertEq(uint256(T.CASH_Q_BOUND), 1 << 180);
    }

    // E0 = c, E1 = c + 1000 Q n, E(p) = c + 1000 n pWad (no second WAD division).
    function testEndpointsAndMarkEquityScale(int64 n, int128 c, uint16 tick) public pure {
        int256 lots = int256(n) % int256(1 << 40);
        int256 cash = int256(c);
        tick = uint16(bound(tick, 1, 999));
        L.Value memory a = L.Value(int128(lots), cash);
        (int256 e0, int256 e1) = L.endpoints(a);
        assertEq(e0, cash);
        assertEq(e1, cash + lots * 1000e18);
        // At tick t, 1000 * n * pWad == n * t * Q.
        assertEq(L.equity(a, uint256(tick) * 1e15), cash + lots * int256(uint256(tick)) * 1e18);
    }

    // V01/V02: 17 lots @ 613 move exactly 10,421 atoms on both sides.
    function testV01PairedFillExactSameQ() public pure {
        L.Value memory b = L.Value(0, 50_000e18);
        L.Value memory s = L.Value(0, 50_000e18);
        (L.Value memory nb, L.Value memory ns) = L.fill(b, s, 17, 613, 0, 0);
        assertEq(b.cashQ - nb.cashQ, int256(V01_VALUE_Q));
        assertEq(ns.cashQ - s.cashQ, int256(V01_VALUE_Q));
        assertEq(int256(nb.lots) + ns.lots, 0);
        assertEq(L.equity(L.Value(17, 0), 613e15), int256(V01_VALUE_Q));
    }

    // Paired fills conserve cash exactly for any fill; fees are the only difference.
    function testPairedFillConservation(uint64 lots, uint16 tick, uint64 bf, uint64 sf) public pure {
        lots = uint64(bound(lots, 1, 1 << 32));
        tick = uint16(bound(tick, 1, 999));
        L.Value memory b = L.Value(0, 0);
        L.Value memory s = L.Value(0, 0);
        (L.Value memory nb, L.Value memory ns) = L.fill(b, s, lots, tick, bf, sf);
        assertEq(nb.cashQ + ns.cashQ + int256(uint256(bf) + sf), 0);
        assertEq(int256(nb.lots) + ns.lots, 0);
    }

    // V03/V04: bilateral fixture deficits.
    function testV03V04BilateralDeficits() public pure {
        C.Orders memory none;
        (uint256 a0, uint256 a1) = C.deficits(L.Value(1_000_000, -480_000_000e18), none);
        (uint256 b0, uint256 b1) = C.deficits(L.Value(-1_000_000, 700_000_000e18), none);
        assertEq(a0, 480_000_000e18);
        assertEq(a1, 0);
        assertEq(b0, 0);
        assertEq(b1, 300_000_000e18);
    }

    // V05: NO / YES / INVALID payouts of the section 11 fixture.
    function testV05SettlementFixture() public pure {
        L.Value memory alice = L.Value(1_000_000, -480_000_000e18);
        L.Value memory bob = L.Value(-1_000_000, 700_000_000e18);
        uint256[3] memory p = [uint256(0), 1e18, 5e17];
        uint256[3] memory aliceAtoms = [uint256(0), 520_000_000, 20_000_000];
        uint256[3] memory bobAtoms = [uint256(700_000_000), 0, 200_000_000];
        for (uint256 i; i < 3; i++) {
            assertEq(S.payoutAtoms(S.rawClaimQ(alice, p[i])), aliceAtoms[i]);
            assertEq(S.payoutAtoms(S.rawClaimQ(bob, p[i])), bobAtoms[i]);
        }
    }

    // V06: endpoint coverage covers every interior price (1,001 grid points).
    function testV06InteriorPricesCovered() public pure {
        L.Value memory alice = L.Value(1_000_000, -480_000_000e18);
        L.Value memory bob = L.Value(-1_000_000, 700_000_000e18);
        for (uint256 k; k <= 1000; k++) {
            int256 ea = L.equity(alice, k * 1e15);
            int256 eb = L.equity(bob, k * 1e15);
            uint256 d = (ea < 0 ? uint256(-ea) : 0) + (eb < 0 ? uint256(-eb) : 0);
            assertLe(d, 480_000_000e18);
        }
    }

    // V07: resting-ask counterexample. Long 1 claim, cash 0, ask 2.3 claims @ 0.55:
    // YES value after the full ask fill is -0.035 USDC, so Dbar_1 must carry 35,000 atoms
    // (the account is not fully backed; a 1x admission must reject it).
    function testV07OversizedAskYesDeficit() public pure {
        C.Orders memory o = C.Orders(0, 0, 2300, 2300 * 550e18, 0);
        (uint256 d0, uint256 d1) = C.deficits(L.Value(1000, 0), o);
        assertEq(d0, 0);
        assertEq(d1, V07_YES_DEFICIT_Q);
    }

    // V08: cancelling removes the exact price contribution, not an average.
    function testV08CancelExactContribution() public pure {
        C.Orders memory both = C.Orders(18, (7 * 400 + 11 * 600) * 1e18, 0, 0, 0);
        C.Orders memory left = C.Orders(7, 7 * 400 * 1e18, 0, 0, 0);
        (uint256 d0Both,) = C.deficits(L.Value(0, 0), both);
        (uint256 d0Left,) = C.deficits(L.Value(0, 0), left);
        assertEq(d0Both - d0Left, 6600e18);
    }

    // V09: reserve payer / receiver / flat. OI 100 claims, deltaF 0.01 USDC per claim.
    function testV09ReserveFundingCases() public pure {
        int128[3] memory reserveLots = [int128(40_000), -40_000, 0];
        int256[3] memory reservePay = [int256(4e23), -4e23, 0];
        uint256[3] memory traderPayer = [uint256(6e23), 1e24, 1e24];
        for (uint256 i; i < 3; i++) {
            F.Delta memory d = F.advance(1, 10e18, 100_000, reserveLots[i], 1e30);
            assertEq(d.flowQ, 1e24);
            assertEq(d.reservePaymentQ, reservePay[i]);
            assertEq(d.traderPayerQ, traderPayer[i]);
            // Slack change -p - a + A == max(-p, 0).
            int256 dj = -d.reservePaymentQ - int256(d.traderPayerQ) + int256(d.flowQ);
            assertEq(dj, reservePay[i] < 0 ? -reservePay[i] : int256(0));
        }
    }

    // V10: positions +60, +40 (reserve), -100 claims at deltaF 0.01 net to zero.
    function testV10FundingZeroSum() public pure {
        int256 dF = 10e18;
        assertEq(int256(60_000) * dF + int256(40_000) * dF - int256(100_000) * dF, 0);
        F.Delta memory d = F.advance(1, dF, 100_000, 40_000, 1e30);
        assertEq(int256(d.traderPayerQ) + d.reservePaymentQ, int256(d.flowQ));
    }

    // V11: OI 100 -> 200 claims; spend 2 of B=10, remaining 8 permits exactly 40 s.
    function testV11OiChangeBudget() public pure {
        F.Delta memory first = F.advance(20, 1e18, 100_000, 0, 10_000_000e18);
        assertEq(first.flowQ, 2_000_000e18);
        assertFalse(first.stopped);
        F.Delta memory second = F.advance(80, 1e18, 200_000, 0, 8_000_000e18);
        assertEq(second.secondsAccrued, 40);
        assertTrue(second.stopped);
        assertEq(second.flowQ, 8_000_000e18);
    }

    // OI = 0 or rate = 0 stops funding.
    function testFundingZeroOiOrRateStops() public pure {
        assertTrue(F.advance(10, 1e18, 0, 0, 1e30).stopped);
        assertTrue(F.advance(10, 0, 100, 0, 1e30).stopped);
    }

    // DEC-02: rate = truncTowardZero(f * 1000 Q / 86400), f clipped to 0.05 min(I, 1-I).
    function testFundingRateTruncatesTowardZero() public pure {
        // f = +0.0001 -> 1e14 * 1000 / 86400 = 1157407407407.4 -> 1157407407407.
        assertEq(F.rate(0.6001e18, 0.6e18), 1_157_407_407_407);
        assertEq(F.rate(0.5999e18, 0.6e18), -1_157_407_407_407);
        // Clip: 0.05 * min(0.6, 0.4) = 0.02.
        assertEq(F.rate(0.9e18, 0.6e18), int256(0.02e18) * 1000 / 86400);
    }

    // V12 (integer-representable variant) / V14: exact premium, 1x and 4x.
    function testV12V14PremiumExact() public pure {
        P.Segment memory s = P.Segment(-100_000_000e18, 1_000_000, 1e15, 0, 3600, 0);
        P.Tariff memory t = P.Tariff(1e14, 1e14, 1e18);
        assertEq(P.cumulative(s, t, 3600), V12_PREMIUM_Q);
        s.surchargeUntil = 3600;
        assertEq(P.cumulative(s, t, 3600), V14_PREMIUM_Q);
    }

    // V13: neutral touches do not change the cumulative charge (half + rest == full).
    function testV13NeutralTouch() public pure {
        P.Segment memory s = P.Segment(-100_000_000e18, 1_000_000, 1e15, 0, 3600, 0);
        P.Tariff memory t = P.Tariff(1e14, 1e14, 1e18);
        uint256 half = P.cumulative(s, t, 1800);
        uint256 full = P.cumulative(s, t, 3600);
        assertEq(half + (full - half), full);
        assertLe(half, full);
    }

    // V15: exact clipped triangle for a zero crossing.
    function testV15PositivePartCrossing() public pure {
        assertEq(P.positiveIntegralUp(-10, 1, 20), 50);
        assertEq(P.positiveIntegralUp(10, -1, 20), 50);
    }

    // Fully backed accounts are never charged premium.
    function testNoPremiumWhenFullyBacked() public pure {
        // Maker of section 6: sold 1000 claims at 0.60 after depositing 400 -> cash 1000 USDC, E1 = 0.
        P.Segment memory s = P.Segment(1_000_000_000e18, -1_000_000, 0, 0, 0, 3600);
        assertEq(P.cumulative(s, P.Tariff(1e18, 1e18, 1e18), 3600), 0);
    }

    // V16: whole-account fee-free takeover changes each slack by max(e_y, 0).
    function testV16TakeoverSlackIdentity() public pure {
        C.Orders memory none;
        L.Value memory reserve = L.Value(0, 100_000_000_000e18);
        L.Value[3] memory traders =
            [L.Value(1_000_000, -480_000_000e18), L.Value(0, 0), L.Value(-1_000_000, 520_000_000e18)];
        for (uint256 i; i < 3; i++) {
            (uint256 d0, uint256 d1) = C.deficits(traders[i], none);
            (int256 s0, int256 s1) = C.slacks(reserve, d0, d1, 0, 0);
            (int256 n0, int256 n1) = C.slacks(L.takeover(traders[i], reserve), 0, 0, 0, 0);
            (int256 e0, int256 e1) = L.endpoints(traders[i]);
            assertEq(n0 - s0, e0 > 0 ? e0 : int256(0));
            assertEq(n1 - s1, e1 > 0 ? e1 : int256(0));
        }
    }

    // Liquidation fee is exactly one atom per lot, split half reserve / half keeper in Q.
    function testLiquidationFeeOneAtomPerLot() public pure {
        (uint256 r, uint256 k) = FeeMath.liquidation(1);
        assertEq(r + k, 1e18);
        assertEq(k, 5e17);
    }

    // Recovery uses floor(raw * rho / Q) with rho = min(1, A / P) and never rounds rho up.
    function testRecoveryFloor() public pure {
        assertEq(S.recoveryAtoms(3e18, 4e18, 2e18), 1);
        assertEq(S.recoveryAtoms(3e18, 4e18, 8e18), 3);
        assertEq(S.recoveryAtoms(0, 0, 8e18), 0);
    }
}
