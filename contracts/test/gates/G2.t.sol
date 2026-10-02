// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LedgerMath as L} from "../../src/math/LedgerMath.sol";
import {CoverageMath as C} from "../../src/math/CoverageMath.sol";
import {FundingMath as F} from "../../src/math/FundingMath.sol";
import {PremiumMath as P} from "../../src/math/PremiumMath.sol";
import {SettlementMath as S} from "../../src/math/SettlementMath.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../../src/math/OrderAdmissionMath.sol";
import {LifecycleMath} from "../../src/math/LifecycleMath.sol";
import {RejectCode} from "../../src/math/RiskTypes.sol";
import {RiskFixture} from "../math/B/B011.t.sol";

/// @notice G2 — MATH ENGINE COMPLETE. Real A and B pure libraries composed in one harness: B's
///         admission consumes A's order-aware deficits and reserve slack (no scripted port).
contract G2Test is Test {
    uint256 constant USDC = 1e24;
    uint256 constant T29 = 29 days;

    /// A's coverage answer for B's admission: deficits of the account plus its commitment set,
    /// cap = 2% of the reserve seed, market check against a reserve with other deficits.
    function _cov(
        int256 cash,
        int256 lots,
        OA.OrderSums memory s,
        uint256 reserveQ,
        uint256 otherD0,
        uint256 otherD1
    ) internal pure returns (OA.CoverageInput memory c) {
        (c.d0Q, c.d1Q) = C.deficits(
            L.Value(int128(lots), cash), C.Orders(s.bidLots, s.bidValueQ, s.askLots, s.askValueQ, s.feeCapQ)
        );
        c.deficitCapQ = reserveQ / 50;
        (int256 s0, int256 s1) =
            C.slacks(L.Value(0, int256(reserveQ)), c.d0Q + otherD0, c.d1Q + otherD1, 0, 0);
        c.marketOk = s0 >= 0 && s1 >= 0;
    }

    function _admit(int256 cash, int256 lots, OA.OrderSums memory s, uint256 reserveQ)
        internal
        pure
        returns (bool ok, RejectCode why)
    {
        return OA.admit(
            OA.Account(cash, lots),
            s,
            OA.Pricing(6e17, T29, 0),
            RiskFixture.profile(5, true),
            _cov(cash, lots, s, reserveQ, 0, 0)
        );
    }

    function test_direct5xEntry() public pure {
        OA.OrderSums memory bid = OA.addOrder(OA.emptySums(), true, 1_000_000, 600, 0);
        (bool ok,) = _admit(int256(120 * USDC), 0, bid, 100_000 * USDC);
        assertTrue(ok, "5x bid admitted with A coverage");
        (ok,) = _admit(int256(119 * USDC), 0, bid, 100_000 * USDC);
        assertFalse(ok, "119 USDC is below IM 120");
        // Reserve smaller than the NO deficit (480) fails market coverage.
        (bool ok2, RejectCode why) = _admit(int256(120 * USDC), 0, bid, 479 * USDC);
        assertFalse(ok2);
        assertEq(uint8(why), uint8(RejectCode.MARKET_COVERAGE));
    }

    function test_short100vs80() public pure {
        OA.OrderSums memory ask = OA.addOrder(OA.emptySums(), false, 1_000_000, 600, 0);
        (bool ok,) = _admit(int256(100 * USDC), 0, ask, 100_000 * USDC);
        assertTrue(ok, "100 USDC short admitted");
        (ok,) = _admit(int256(80 * USDC), 0, ask, 100_000 * USDC);
        assertFalse(ok, "80 USDC short rejected at 29 days");
    }

    function test_allPrefixEnvelopeMonotone() public pure {
        MarginMath.RiskParams memory p = RiskFixture.profile(5, true);
        uint256 prev;
        for (uint256 k = 1; k <= 64; ++k) {
            OA.OrderSums memory bid = OA.addOrder(OA.emptySums(), true, k * 15_625, 600, 0);
            (uint256 im,) = OA.imUpperQ(0, bid, OA.Pricing(6e17, T29, 0), p);
            assertGe(im, prev);
            prev = im;
        }
        assertEq(prev, 120 * USDC); // 1,000,000 lots: the fixture's IM
    }

    function test_reserveFundingPayerReceiver() public pure {
        F.Delta memory payer = F.advance(1, 10e18, 100_000, 40_000, 1e30);
        F.Delta memory receiver = F.advance(1, 10e18, 100_000, -40_000, 1e30);
        assertEq(int256(payer.flowQ) - payer.reservePaymentQ - int256(payer.traderPayerQ), 0);
        assertEq(int256(receiver.flowQ) - receiver.reservePaymentQ - int256(receiver.traderPayerQ), 4e23);
    }

    function test_neutralTouchPremium() public pure {
        P.Segment memory s = P.Segment(-int256(480 * USDC), 1_000_000, 231_481_481_481_481, 0, 3600, 6 hours);
        P.Tariff memory t = P.Tariff(1e14, 1e14, 1e18);
        uint256 half = P.cumulative(s, t, 300);
        uint256 full = P.cumulative(s, t, 600);
        assertEq(half + (full - half), full);
        // Combined reference trace (reference/integration/combined_trace.py) charges ceil(exact) =
        // 2,667,052,469,135,802,468,334 Q.
        assertEq(full, 2_667_052_469_135_802_468_334);
    }

    function test_haltCutoffs() public pure {
        // Early halt inside an epoch: cutoff = halt; after the epoch end: cutoff = epoch end;
        // a frozen rollover cutoff is respected (B LifecycleMath; A FreezeAccounting uses min(halt, end)).
        assertEq(LifecycleMath.accrualCutoff(1000, 3600, 0), 1000);
        assertEq(LifecycleMath.accrualCutoff(5000, 3600, 0), 3600);
        assertEq(LifecycleMath.accrualCutoff(5000, 3600, 3600), 3600);
        assertEq(LifecycleMath.economicHaltAt(10_000, 4000), 4000);
        assertEq(LifecycleMath.economicHaltAt(10_000, 0), 10_000);
    }

    function test_allPayoffModes() public pure {
        L.Value memory alice = L.Value(1_000_000, -int256(480 * USDC));
        L.Value memory bob = L.Value(-1_000_000, int256(700 * USDC));
        assertEq(S.payoutAtoms(S.rawClaimQ(alice, 0)) + S.payoutAtoms(S.rawClaimQ(bob, 0)), 700e6);
        assertEq(S.payoutAtoms(S.rawClaimQ(alice, 1e18)) + S.payoutAtoms(S.rawClaimQ(bob, 1e18)), 520e6);
        assertEq(S.payoutAtoms(S.rawClaimQ(alice, 5e17)) + S.payoutAtoms(S.rawClaimQ(bob, 5e17)), 220e6);
    }
}
