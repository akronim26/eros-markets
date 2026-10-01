// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LiquidationEligibility} from "../../../src/risk/LiquidationEligibility.sol";
import {LiquidationMath as LM} from "../../../src/math/LiquidationMath.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {RejectCode} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract EligEngine is LiquidationEligibility, MockBookAdapter, MockAccountingPort {
    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function feed(uint64 from, uint64 to, uint256 idx, uint256 bid, uint256 ask) external {
        for (uint64 t = from; t <= to; t += 10) {
            _onIndexObservation(t, idx, true);
            if (ask != 0) _recordPerp(t, bid, ask, 1e6, 1e6);
        }
    }

    function openEpoch() external {
        _riskEpochOpenedWithGuards();
    }

    function rest(uint32 owner, MathTypes.Side side, uint16 tick, uint64 lots) external returns (uint32 s) {
        s = _mockRest(owner, side, tick, lots, 0, false);
        _mockEndAction();
    }

    /// The B032 order: touch, judge, and only if eligible cancel commitments.
    function check(uint32 t) external returns (Eligibility memory el) {
        _riskBeginAction();
        _touch(t);
        el = _eligibility(t, _actionCtx);
        if (el.mode != LM.Mode.NONE) _resCancelAll(t);
        _mockEndAction();
    }

    function pair(uint32 target, uint32 partner, uint64 maxLots) external returns (PairResult memory r) {
        _riskBeginAction();
        _touch(target);
        _resCancelAll(target);
        r = _pairReduce(target, partner, maxLots, _actionCtx, msg.sender);
        _mockEndAction();
    }

    function sumsOf(uint32 t) external view returns (uint128 bid, uint128 ask) {
        bid = _resSums(t).bidLots;
        ask = _resSums(t).askLots;
    }
}

/// B030: liquidation eligibility and pair selection (scripted A port).
contract B030Test is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    uint64 T;
    EligEngine e;

    function setUp() public {
        vm.warp(L0);
        e = new EligEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
    }

    function test_nonEligibleKeepsOrdersNoReward() public {
        e.mockSetAccount(1, int256(1000 * USDC), 0);
        e.rest(1, MathTypes.Side.BUY, 590, 1000);
        uint256 n0 = e.mockCallCount();
        LiquidationEligibility.Eligibility memory el = e.check(1);
        assertEq(uint8(el.mode), uint8(LM.Mode.NONE));
        (uint128 bid,) = e.sumsOf(1);
        assertEq(bid, 1000, "valid order not cancelled");
        for (uint256 i = n0; i < e.mockCallCount(); ++i) {
            (MockAccountingPort.CallKind k,,,,) = e.mockCalls(i);
            assertTrue(
                k != MockAccountingPort.CallKind.POST_LIQ_FILL && k != MockAccountingPort.CallKind.TAKEOVER
            );
        }
        assertEq(e.mockKeeperFeesQ(), 0);
    }

    function test_belowMmReduceCancelsFirst() public {
        e.mockSetAccount(1, int256(400 * USDC), 0);
        e.rest(1, MathTypes.Side.BUY, 590, 1000);
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000); // E = 60 < MM
        LiquidationEligibility.Eligibility memory el = e.check(1);
        assertEq(uint8(el.mode), uint8(LM.Mode.REDUCE));
        (uint128 bid,) = e.sumsOf(1);
        assertEq(bid, 0, "commitments cancelled before any reduction");
    }

    function test_takeoverPredicates() public {
        e.mockSetAccount(1, -int256(600 * USDC), 1_000_000); // fresh E = 0
        LiquidationEligibility.Eligibility memory el = e.check(1);
        assertEq(uint8(el.mode), uint8(LM.Mode.TAKEOVER));
        assertEq(el.takeoverPredicate, 1);
        e.mockSetAccount(2, -int256(1100 * USDC), 1_000_000); // both endpoints negative
        el = e.check(2);
        assertEq(el.takeoverPredicate, 3);
    }

    function test_staleMarkPositiveEquityNotEligible() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000);
        vm.warp(L0 + 12 hours + 400); // mark windows lapse
        LiquidationEligibility.Eligibility memory el = e.check(1);
        assertFalse(el.priceFresh);
        assertEq(uint8(el.mode), uint8(LM.Mode.NONE), "stale mark is not evidence");
    }

    function test_floorDeficitPriceFree() public {
        e.mockSetAccount(1, -int256(100 * USDC), 1_000_000); // healthy by mark, NO deficit 100
        vm.warp(T - 43_200);
        LiquidationEligibility.Eligibility memory el = e.check(1);
        assertEq(uint8(el.mode), uint8(LM.Mode.TAKEOVER));
        assertEq(el.takeoverPredicate, 2);
    }

    function test_pairReductionBothPredicates() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000); // long, E = 60 < MM
        e.mockSetAccount(2, int256(660 * USDC), -1_000_000); // short, E = 60 < MM
        LiquidationEligibility.PairResult memory r = e.pair(1, 2, 400_000);
        assertTrue(r.executed);
        assertEq(r.tick, 600);
        assertEq(r.lots, 400_000);
        assertEq(e.mockAccount(1).lots, 600_000);
        assertEq(e.mockAccount(2).lots, -600_000);
        assertEq(r.feeTargetQ, 400_000 * Q, "one atom per lot");
        assertEq(e.mockKeeperFeesQ(), r.feeTargetQ + r.feePartnerQ);
        // exact paired deltas at the common tick, minus each fee
        assertEq(
            e.mockAccount(1).cashQ, -int256(540 * USDC) + int256(400_000 * 600 * Q) - int256(r.feeTargetQ)
        );
    }

    function test_pairRejectsIneligibleOrSameSide() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000);
        e.mockSetAccount(2, int256(1400 * USDC), -1_000_000); // healthy short
        LiquidationEligibility.PairResult memory r = e.pair(1, 2, 400_000);
        assertFalse(r.executed);
        assertEq(uint8(r.reason), uint8(RejectCode.MAKER_BELOW_MM));
        e.mockSetAccount(3, -int256(540 * USDC), 1_000_000); // same side
        r = e.pair(1, 3, 400_000);
        assertFalse(r.executed);
        assertEq(uint8(r.reason), uint8(RejectCode.NO_REDUCIBLE_POSITION));
        assertEq(e.mockAccount(1).lots, 1_000_000, "nothing posted");
    }

    function test_pairPredicateBlocksWorseningClose() public {
        // Deep-underwater long near zero equity: closing at the common tick with the fee would
        // violate the allowed-reduction predicate unless the fee is waived; both must still pass.
        e.mockSetAccount(1, -int256(599 * USDC), 1_000_000); // E = 1 USDC
        e.mockSetAccount(2, int256(660 * USDC), -1_000_000);
        LiquidationEligibility.PairResult memory r = e.pair(1, 2, 1_000_000);
        if (r.executed) {
            assertLe(r.feeTargetQ, 1_000_000 * Q);
            assertGe(e.mockAccount(1).cashQ, 0, "no negative-equity cash close");
        }
    }
}
