// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {CombinedEngineFault} from "../integration/CombinedEngine.sol";
import {MockBookAdapter} from "../mocks/B/MockBookAdapter.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {RejectCode, PricingMode} from "../../src/math/RiskTypes.sol";
import {CoverageMath as C} from "../../src/math/CoverageMath.sol";
import {FundingMath} from "../../src/math/FundingMath.sol";

/// @notice G4 — trading with real accrual joined. Real A touch/posting (funding, premium, fees,
///         coverage) under real B hook orchestration (admission, maker readmission, permits,
///         reservations), driven by the mock book. No A or B scripted port.
contract G4Test is CombinedBase {
    MathTypes.Side constant BUY = MathTypes.Side.BUY;
    MathTypes.Side constant SELL = MathTypes.Side.SELL;

    function _setup(uint8 variant, uint256[] memory usdc) internal {
        _variant = variant;
        _deploy(5, 100_000);
        _traders(usdc);
        _activate();
        _keep(L0 + 600, 6e17, false);
    }

    function _six() internal pure returns (uint256[] memory u) {
        u = new uint256[](6);
        (u[0], u[1], u[2], u[3], u[4], u[5]) = (120, 400, 700, 400, 120, 400);
    }

    function _orders(uint32 id) internal view returns (C.Orders memory) {
        return e.account(_who(id)).orders;
    }

    function _empty(uint32 id) internal view {
        C.Orders memory o = _orders(id);
        assertEq(o.bidLots + o.askLots, 0, "A orders empty");
        assertEq(o.bidValueQ + o.askValueQ + o.feeCapQ, 0, "A order values empty");
    }

    /// Feed the independent index at `idx` and perp depth around `mid` (mark candidate) up to `to`.
    function _keepPerp(uint64 to, uint256 idx, uint256 mid) internal {
        vm.warp(to);
        e.feed(to - 990, to, idx, mid - 1e16, mid + 1e16);
    }

    // ------------------------------------------------------------------------------------------

    /// rest -> maker touch -> paired fill -> fees -> coverage -> permit release (two makers).
    function test_restFillFeesCoveragePermitRelease() public {
        _setup(1, _six()); // 0.1% taker fee engine
        e.rest(2, SELL, 600, 300_000);
        e.rest(4, SELL, 601, 700_000);
        assertEq(_orders(2).askLots, 300_000, "maker reservation reaches A");
        MockBookAdapter.PlaceResult memory r = e.place(_ioc(3, BUY, 601, 1_000_000));
        assertEq(r.filledLots, 1_000_000);
        uint256 notional = 300_000 * 600 * Q + 700_000 * 601 * Q;
        uint256 fee = 300_000 * 600 * 1e15 + 700_000 * 601 * 1e15;
        assertEq(_cash(3), int256(700 * USDC) - int256(notional) - int256(fee));
        assertEq(_cash(2), int256(400 * USDC) + int256(300_000 * 600 * Q));
        assertEq(_cash(4), int256(400 * USDC) + int256(700_000 * 601 * Q));
        assertEq(e.protocolFeeQ(), fee, "fees credited exactly what takers paid");
        assertEq(e.oiAllLots(), 1_000_000, "OI after fills");
        _empty(3); // permit released at finish
        _empty(2);
        _empty(4);
        _assertInvariants();
    }

    /// Funding at a fixed epoch rate, budget consumed with old then new OI; neutral premium touches.
    function test_fundingOldThenNewOiAndNeutralPremium() public {
        uint256[] memory u = new uint256[](6);
        (u[0], u[1], u[2], u[3], u[4], u[5]) = (130, 400, 1, 400, 130, 400); // IM at mark 0.62 is 124
        _setup(0, u);
        e.rest(2, SELL, 600, 1000);
        assertEq(e.place(_ioc(3, BUY, 600, 1000)).filledLots, 1000); // bootstrap OI 1,000
        _keepPerp(L0 + 12 hours, 6e17, 62e16);
        _roll(32);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));
        (, uint64 start,, uint64 last0,, int256 rate,) = e.epoch();
        assertEq(rate, FundingMath.rate(e.riskContext().markWad, e.riskContext().indexWad));
        assertGt(rate, 0);
        uint256 b0 = e.fundingBudgetQ();
        assertEq(b0, 1000 * uint256(rate) * (_epochEnd() - start));
        assertEq(last0, start);

        vm.warp(start + 20);
        e.feed(start + 10, start + 20, 6e17, 61e16, 63e16);
        e.rest(4, SELL, 600, 1_000_000);
        e.rest(6, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        assertEq(e.place(_ioc(5, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        assertEq(e.fundingBudgetQ(), b0 - 1000 * uint256(rate) * 20, "old OI pays the first 20 s");
        assertEq(e.oiAllLots(), 2_001_000);

        // Neutral touches: Alice touched twice, Carol once at the same final time.
        vm.warp(start + 300);
        e.feed(start + 30, start + 300, 6e17, 61e16, 63e16);
        e.cancelAll(1);
        vm.warp(start + 600);
        e.feed(start + 310, start + 600, 6e17, 61e16, 63e16);
        e.cancelAll(1);
        e.cancelAll(5);
        assertEq(_cash(1), _cash(5), "touch frequency does not change premium or funding");
        assertLt(_cash(1), -int256(470 * USDC), "funding and premium charged");
        _assertInvariants();
    }

    /// An old account epoch can never release or consume a new reservation.
    function test_staleEpochCannotReleaseNewReservation() public {
        _setup(0, _six());
        e.rest(2, SELL, 600, 1000);
        e.cancelAll(2);
        _empty(2);
        e.rest(2, SELL, 605, 500);
        MockBookAdapter.PlaceResult memory r = e.place(_ioc(3, BUY, 605, 1000));
        assertEq(r.filledLots, 500, "stale node pruned, only the current order fills");
        _empty(2);
        _empty(3);
        assertEq(_lots(2), -500);
        _assertInvariants();
    }

    /// A rollover blocks market-ledger mutation until its pages finish and invalidates old orders.
    function test_rolloverBlocksTradingAndInvalidatesOrders() public {
        _setup(0, _six());
        e.rest(2, SELL, 600, 1000);
        vm.warp(_epochEnd());
        e.feed(L0 + 610, uint64(block.timestamp), 6e17, 0, 0);
        MockBookAdapter.PlaceResult memory r = e.place(_ioc(3, BUY, 600, 1000));
        assertEq(r.filledLots, 0);
        assertEq(uint8(r.rejection), uint8(RejectCode.BAD_STAGE));
        e.beginRollover();
        r = e.place(_ioc(3, BUY, 600, 1000));
        assertEq(r.filledLots, 0, "no fill during the sweep");
        while (!e.rollPage(1)) {}
        e.finishRollover();
        _empty(2); // A cleared the old market-epoch reservation at the sweep touch
        r = e.place(_ioc(3, BUY, 600, 1000));
        assertEq(r.filledLots, 0, "old-epoch resting order cannot execute");
        assertEq(e.fundingClearingQ(), 0);
        assertEq(e.fundingCushionQ(), 0);
        _assertInvariants();
    }

    /// Cancellation then withdrawal of the whole allocation (bootstrap: exactly backed).
    function test_cancelThenWithdraw() public {
        _setup(0, _six());
        e.rest(3, BUY, 600, 1000);
        assertEq(_orders(3).bidLots, 1000);
        e.cancelAll(3);
        _empty(3);
        uint256 free0 = vault.freeAtoms(_who(3));
        vm.prank(_who(3));
        e.release(700e6);
        assertEq(vault.freeAtoms(_who(3)) - free0, 700e6);
        assertEq(_cash(3), 0);
        _assertInvariants();
    }

    /// An unexpected accounting assertion on the second fill rolls back the first fill too.
    function test_unexpectedAssertionRollsBackAllFills() public {
        _setup(2, _six());
        e.rest(2, SELL, 600, 300_000);
        e.rest(4, SELL, 601, 300_000);
        int256 c3 = _cash(3);
        int256 c2 = _cash(2);
        uint256 oi = e.oiAllLots();
        CombinedEngineFault(address(e)).setFailAt(2);
        vm.expectRevert(CombinedEngineFault.InjectedAccountingFailure.selector);
        e.place(_ioc(3, BUY, 601, 600_000));
        assertEq(_cash(3), c3);
        assertEq(_cash(2), c2);
        assertEq(e.oiAllLots(), oi);
        assertEq(_orders(2).askLots, 300_000, "maker reservation intact");
        _assertInvariants();
    }
}
