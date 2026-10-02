// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {PricingMode} from "../../src/math/RiskTypes.sol";
import {TradePreview} from "../../src/risk/TradePreview.sol";

/// @notice B-D02: previews now read the accounting module's own funding step and touch projection.
///         An account preview at time t must equal the cash a real touch at t posts, with fresh or
///         stale observations, for a long and a short. Real A+B; book, price feed and oracle mocked.
contract BD02PreviewParityTest is CombinedBase {
    uint64 opening;

    function _fundingEpoch() internal returns (uint64 start, uint64 end) {
        _deploy(5, 100_000);
        uint256[] memory allocations = new uint256[](3);
        (allocations[0], allocations[1], allocations[2]) = (700, 400, 100);
        _traders(allocations);
        _activate();
        _keep(L0 + 600, 6e17, false);
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, MathTypes.Side.BUY, 600, 1_000_000)).filledLots, 1_000_000);
        opening = ((L0 + 12 hours) / 1 hours + 1) * 1 hours;
        vm.warp(opening);
        e.feed(opening - 990, opening, 6e17, 61e16, 63e16);
        _roll(32);
        int256 rate;
        (, start, end,,, rate,) = e.epoch();
        assertGt(rate, 0);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));
    }

    function _touchMatchesPreview(uint32 id) internal {
        TradePreview.AccountPreview memory preview = e.previewAccount(id);
        e.cancelAll(id);
        assertEq(_cash(id), preview.cashQ, "touch cash equals preview");
        assertEq(e.previewAccount(id).projectedPremiumQ, 0, "nothing left to project");
        assertEq(e.previewAccount(id).projectedFundingQ, 0, "nothing left to project");
    }

    function testFuzzPreviewEqualsTouch(uint64 dt, bool fresh) public {
        (uint64 start, uint64 end) = _fundingEpoch();
        dt = uint64(bound(dt, 20, end - start - 1));
        uint64 at = start + dt;
        vm.warp(at);
        if (fresh) {
            uint64 from = at - 990 > opening + 10 ? at - 990 : opening + 10;
            e.feed(from, at, 6e17, 61e16, 63e16);
        }
        _touchMatchesPreview(1); // long
        _touchMatchesPreview(2); // short
        _assertInvariants();
    }
}
