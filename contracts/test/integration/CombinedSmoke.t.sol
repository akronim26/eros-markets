// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "./CombinedBase.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {PricingMode} from "../../src/math/RiskTypes.sol";
import {MockBookAdapter} from "../mocks/B/MockBookAdapter.sol";

contract CombinedSmokeTest is CombinedBase {
    function test_smokeBootstrapThenDirectFiveX() public {
        _deploy(5, 100_000);
        uint256[] memory u = new uint256[](4);
        (u[0], u[1], u[2], u[3]) = (120, 400, 1, 400);
        _traders(u);
        _activate();
        _keep(L0 + 600, 6e17, false);
        // Bootstrap: exactly backed only, inside the index band.
        e.rest(2, MathTypes.Side.SELL, 600, 1000);
        MockBookAdapter.PlaceResult memory r = e.place(_ioc(3, MathTypes.Side.BUY, 600, 1000));
        assertEq(r.filledLots, 1000, "bootstrap fill");
        assertEq(_cash(3), int256(USDC) - int256(600_000 * Q));
        assertEq(
            e.place(_ioc(1, MathTypes.Side.BUY, 600, 1_000_000)).filledLots, 0, "no leverage in bootstrap"
        );
        _assertInvariants();
        // Perp depth history, then an epoch opening switches to NORMAL_PRICING.
        _keep(L0 + 12 hours, 6e17, true);
        _roll(32);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));
        // Direct 5x entry against a fully backed maker.
        e.rest(4, MathTypes.Side.SELL, 600, 1_000_000);
        r = e.place(_ioc(1, MathTypes.Side.BUY, 600, 1_000_000));
        assertEq(r.filledLots, 1_000_000, "5x fill");
        assertEq(_cash(1), -int256(480 * USDC));
        assertEq(_lots(1), 1_000_000);
        assertEq(_cash(4), int256(1000 * USDC));
        _assertInvariants();
    }
}
