// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {RiskLiquidation} from "../../src/risk/RiskLiquidation.sol";
import {HaltView} from "../../src/interfaces/IResolutionIngress.sol";
import {LiquidationMath as LM} from "../../src/math/LiquidationMath.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";

/// @notice B043 review reproducers that no gate test covered, run on the merged A+B engine.
contract B043ReviewTest is CombinedBase {
    MathTypes.Side constant BUY = MathTypes.Side.BUY;
    MathTypes.Side constant SELL = MathTypes.Side.SELL;

    function _boot(uint256[] memory u) internal {
        _deploy(5, 100_000);
        _traders(u);
        _activate();
        _keep(L0 + 600, 6e17, false);
    }

    /// Route 2: with no normal mark, a release is allowed only if the account stays exactly backed.
    function test_route2_missingMarkReleaseOnlyIfExactlyBacked() public {
        uint256[] memory u = new uint256[](2);
        (u[0], u[1]) = (10, 400);
        _boot(u);
        e.rest(2, SELL, 600, 10_000);
        assertEq(e.place(_ioc(1, BUY, 600, 10_000)).filledLots, 10_000); // cost 6 USDC, cash 4 left
        assertFalse(e.riskContext().markOk);
        vm.prank(_who(1));
        vm.expectRevert(RiskStorage.Rejected.selector);
        e.release(4_000_001); // would make E0 negative
        vm.prank(_who(1));
        e.release(4e6); // stays exactly backed (E0 = 0)
        assertEq(_cash(1), 0);
        _assertInvariants();
    }

    /// Route 6: a freshness gap stops the epoch's funding at the old endpoint; later fresh data
    /// never restarts it (spec §3.1, §5.2).
    function test_route6_freshnessGapStopsFundingNoRestart() public {
        uint256[] memory u = new uint256[](3);
        (u[0], u[1], u[2]) = (1, 400, 400);
        _boot(u);
        e.rest(2, SELL, 600, 1000);
        assertEq(e.place(_ioc(1, BUY, 600, 1000)).filledLots, 1000); // OI for the next epoch
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 990, L0 + 12 hours, 59e16, 59e16, 61e16); // mark ~0.60, index 0.59
        _roll(32);
        (, uint64 start,,,, int256 rate, bool stopped) = e.epoch();
        assertGt(rate, 0);
        assertFalse(stopped);
        // Last valid sample at `start`; it carries 30 s. Nothing arrives for 120 s.
        vm.warp(start + 120);
        e.feed(start + 120, start + 120, 59e16, 59e16, 61e16);
        (,,, uint64 last,,, bool stoppedAfter) = e.epoch();
        assertTrue(stoppedAfter, "gap stops funding");
        assertEq(last, start + 30, "accrued only to the old freshness endpoint");
        int256 f = e.fundingFQ();
        vm.warp(start + 300);
        e.feed(start + 130, start + 300, 59e16, 59e16, 61e16);
        e.cancelAll(1);
        assertEq(e.fundingFQ(), f, "fresh data does not restart a stopped epoch");
        _assertInvariants();
    }

    /// Route 13: OI at halt is one-sided OI including the reserve's long after a takeover.
    function test_route13_oiAtHaltIncludesReserve() public {
        uint256[] memory u = new uint256[](2);
        (u[0], u[1]) = (120, 400);
        _boot(u);
        _keep(L0 + 12 hours, 6e17, true);
        _roll(32);
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        uint64 last = L0 + 12 hours;
        uint256 p = 6e17;
        while (p > 47e16) {
            p = p - 5e16 < 47e16 ? 47e16 : p - 5e16;
            last += 20 minutes;
            vm.warp(last);
            e.feed(last - 990, last, p, p - 1e16, p + 1e16);
            if (block.timestamp >= _epochEnd()) _roll(32);
        }
        last += 20 minutes;
        vm.warp(last);
        e.feed(last - 990, last, p, p - 1e16, p + 1e16);
        if (block.timestamp >= _epochEnd()) _roll(32);
        vm.prank(KEEPER);
        RiskLiquidation.LiquidationResult memory r = e.liquidate(1, 1, 1, 0);
        assertEq(uint8(r.result), uint8(LM.Result.TAKEOVER_AUTHORIZED));
        (int128 rl,) = e.reserve();
        assertEq(rl, 1_000_000);
        oracle.haltEarly();
        HaltView memory h = e.getHaltSnapshot();
        assertEq(h.oiHaltLots, 1_000_000, "reserve long counted in one-sided OI");
        assertEq(e.oiHaltLots(), e.oiAllLots());
    }
}
