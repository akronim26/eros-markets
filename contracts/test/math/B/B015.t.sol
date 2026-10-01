// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RiskDifferential} from "./RiskDifferential.t.sol";
import {RiskFixture} from "./B011.t.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {HazardMath} from "../../../src/math/HazardMath.sol";
import {HorizonMath} from "../../../src/math/HorizonMath.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {PricingMath as PM} from "../../../src/math/PricingMath.sol";

contract B015Wrapper {
    function margin(uint256 n, uint256 q) external pure returns (MarginMath.Margin memory) {
        return MarginMath.sideMargin(n, true, q, 1 days, 0, RiskFixture.profile(5, true));
    }

    function addOrder(uint16 tick) external pure returns (OA.OrderSums memory) {
        return OA.addOrder(OA.emptySums(), true, 1, tick, 0);
    }

    function rate(uint256 q, uint256 i) external pure returns (int256) {
        return PM.fundingRate(q, i);
    }
}

/// B015: the B risk math as one engine. Inherits the generated reference differential
/// (RiskDifferential.t.sol, from reference/b/export_vectors.py) and adds the gate cases.
contract B015Test is RiskDifferential {
    uint256 constant USDC = 1e24;
    uint256 constant QW = 6e17;
    B015Wrapper w;

    function setUp() public {
        w = new B015Wrapper();
    }

    function test_directFiveXEndToEndMath() public pure {
        // flat, 120 USDC, bid 1,000 claims at 0.60: margin IM 120 exactly, Emin 120, admitted.
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), true, 1_000_000, 600, 0);
        OA.Account memory a = OA.Account(int256(120 * USDC), 0);
        (bool ok,) =
            OA.admit(a, s, OA.Pricing(QW, 29 days, 0), RiskFixture.profile(5, true), _cov(a.cashQ, 0, s));
        assertTrue(ok);
        // after the fill the long is HEALTHY at 5x display leverage
        MarginMath.Margin memory m =
            MarginMath.sideMargin(1_000_000, true, QW, 29 days, 0, RiskFixture.profile(5, true));
        MarginMath.Health memory h = MarginMath.health(-int256(480 * USDC), 1_000_000, QW, m);
        assertEq(uint8(h.status), uint8(MarginMath.Status.HEALTHY));
        (, uint256 bps) = MarginMath.displayLeverageBps(m.worstQ, h.markEquityQ);
        assertEq(bps, 50_000);
    }

    function test_short100Versus80() public pure {
        MarginMath.Margin memory m =
            MarginMath.sideMargin(1_000_000, false, QW, 29 days, 0, RiskFixture.profile(5, true));
        assertEq(
            uint8(MarginMath.health(int256(680 * USDC), -1_000_000, QW, m).status),
            uint8(MarginMath.Status.BELOW_IM)
        );
        assertEq(
            uint8(MarginMath.health(int256(700 * USDC), -1_000_000, QW, m).status),
            uint8(MarginMath.Status.HEALTHY)
        );
    }

    function test_boundaryDomains() public pure {
        // x = 0: zero margin, no division
        MarginMath.Margin memory m =
            MarginMath.sideMargin(0, true, QW, 29 days, 0, RiskFixture.profile(5, true));
        assertEq(m.imQ, 0);
        // epsilon boundary: adverse hazard at epsilon forces full backing
        assertTrue(HazardMath.tail(1e16, 0, true, 1e16).fullBacking);
        // at T: sigma capped at 1 -> worst-loss cap -> full backing
        m = MarginMath.sideMargin(1_000_000, true, QW, 0, 0, RiskFixture.profile(5, true));
        assertTrue(m.fullBacking);
        // maximum position size stays within bounds and fully backed or capped
        m = MarginMath.sideMargin(1 << 40, true, QW, 29 days, 0, RiskFixture.profile(5, true));
        assertLe(m.imQ, m.worstQ);
    }

    function test_invalidInputsRevert() public {
        vm.expectRevert(HorizonMath.PriceNotInterior.selector);
        w.margin(1000, 0);
        vm.expectRevert(MarginMath.BadUnits.selector);
        w.margin((1 << 40) + 1, QW);
        vm.expectRevert(OA.BadUnits.selector);
        w.addOrder(0);
        vm.expectRevert(OA.BadUnits.selector);
        w.addOrder(1000);
        vm.expectRevert(PM.BadUnits.selector);
        w.rate(1e18 + 1, 5e17);
    }

    function test_monotoneEnvelopeGrid() public pure {
        uint256[6] memory qs = [uint256(1e15), 5e16, 3e17, 6e17, 95e16, 999e15];
        for (uint256 qi; qi < 6; ++qi) {
            for (uint256 side; side < 2; ++side) {
                uint256 prev;
                bool prevFull;
                for (uint256 n = 1; n < 1e10; n = n * 7 + 3) {
                    MarginMath.Margin memory m =
                        MarginMath.sideMargin(n, side == 0, qs[qi], 7 days, 0, RiskFixture.profile(5, true));
                    assertGe(m.imQ, prev, "IM nondecreasing");
                    if (prevFull) assertTrue(m.fullBacking, "switch upward");
                    (prev, prevFull) = (m.imQ, m.fullBacking);
                }
            }
        }
    }

    function test_missingCalibrationFullBacking() public pure {
        MarginMath.Margin memory m =
            MarginMath.sideMargin(1_000_000, true, QW, 29 days, 0, RiskFixture.profile(5, false));
        assertTrue(m.fullBacking);
        assertEq(m.imQ, 600 * USDC);
    }
}
