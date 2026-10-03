// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ConversionGate} from "../../../src/settlement/ConversionGate.sol";
import {RiskLiquidation} from "../../../src/risk/RiskLiquidation.sol";
import {FloorLifecycle} from "../../../src/risk/FloorLifecycle.sol";
import {LiquidationMath as LM} from "../../../src/math/LiquidationMath.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {HaltView, SettlementView} from "../../../src/interfaces/IResolutionIngress.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {IAccountingPort} from "../../../src/interfaces/IAccountingPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {Stage, PricingMode, AdmissionMode, ClearingPhase} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "../../risk/B/B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

/// The whole B engine (ConversionGate on top of every B module) over the mock book and the
/// scripted Person A port. Counterparts: CP-BOOK, CP-ORACLE, CP-PRICE mocked; Person A scripted.
contract FullEngine is ConversionGate, MockBookAdapter, MockAccountingPort {
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

    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }

    function place(IBookRiskHooks.OrderRequest memory r) external returns (PlaceResult memory res) {
        res = _mockPlace(r);
        _mockEndAction();
    }

    function rest(uint32 owner, MathTypes.Side side, uint16 tick, uint64 lots) external returns (uint32 s) {
        s = _mockRest(owner, side, tick, lots, 0, false);
        _mockEndAction();
    }

    function cancelAll(uint32 t) external {
        _cancelAllTopLevel(t);
        _mockEndAction();
    }

    function liq(uint32 t, uint64 maxLots, uint16 maxExam)
        external
        returns (RiskLiquidation.LiquidationResult memory r)
    {
        r = this.liquidate(t, maxLots, maxExam, 0);
        _mockEndAction();
    }

    function sweep(uint256 n) external returns (FloorStatus s) {
        s = this.floorSweep(n);
        _mockEndAction();
    }
}

/// B040: integrated lifecycle campaign on the local fixture (mocked counterparts, scripted A).
contract FullLifecycleTest is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    uint64 T;
    FullEngine e;
    MockResolutionAuthority oracle;

    function setUp() public {
        vm.warp(L0);
        oracle = new MockResolutionAuthority();
        e = new FullEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(oracle), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        oracle.bind(e);
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        e.mockSetAccount(1, int256(120 * USDC), 0); // leveraged taker (Alice)
        e.mockSetAccount(2, int256(400 * USDC), 0); // bootstrap maker
        e.mockSetAccount(3, int256(6 * USDC / 10), 0); // bootstrap taker, exactly backed
        e.mockSetAccount(4, int256(400 * USDC), 0); // 5x counterparty (Bob-like)
        e.mockSetAccount(5, int256(400 * USDC), 0); // stale maker
        e.mockSetAccount(9, int256(100_000 * USDC), 0); // liquidity provider
        e.mockScriptFinish(IAccountingPort.FinishResult(true, false, 1_220_000_000, 480_000_000));
    }

    function ioc(uint32 t, MathTypes.Side s, uint16 limit, uint64 lots)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory)
    {
        return IBookRiskHooks.OrderRequest(t, s, IBookRiskHooks.OrderKind.IOC, limit, lots, 0, false, 8);
    }

    function keep(uint64 to, uint256 idx, bool perp) internal {
        vm.warp(to);
        e.feed(to - 990, to, idx, perp ? idx - 1e16 : 0, perp ? idx + 1e16 : 0);
    }

    function test_campaignBootstrapToClaims() public {
        // 1. Bootstrap: index only, empty book; exactly backed trade inside the index band.
        keep(L0 + 6 hours, 6e17, false);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.BOOTSTRAP));
        e.rest(2, MathTypes.Side.SELL, 600, 1000);
        assertEq(
            e.place(ioc(3, MathTypes.Side.BUY, 600, 1000)).filledLots, 1000, "exactly backed bootstrap fill"
        );
        assertEq(
            e.place(ioc(1, MathTypes.Side.BUY, 600, 1_000_000)).filledLots,
            0,
            "no leverage before normal pricing"
        );

        // 2. Perp depth accumulates; NORMAL_PRICING only at a completed epoch opening.
        keep(L0 + 12 hours, 6e17, true);
        e.openEpoch();
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));

        // 3. Stale maker: maker 5 rests then cancels-all; its node is pruned and consumes a step.
        e.rest(5, MathTypes.Side.SELL, 600, 10);
        e.cancelAll(5);

        // 4. Direct 5x entry (fixture leverage).
        e.rest(4, MathTypes.Side.SELL, 600, 1_000_000);
        MockBookAdapter.PlaceResult memory r = e.place(ioc(1, MathTypes.Side.BUY, 600, 1_000_000));
        assertEq(r.filledLots, 1_000_000);
        assertEq(e.mockAccount(1).cashQ, -int256(480 * USDC));
        assertEq(e.mockAccount(4).lots, -1_000_000);

        // 5. Price falls to 0.54: Alice below MM; a keeper liquidates against provider bids.
        keep(L0 + 12 hours + 1000, 54e16, true);
        e.rest(9, MathTypes.Side.BUY, 540, 2_000_000);
        RiskLiquidation.LiquidationResult memory lr = e.liq(1, 2_000_000, 8);
        assertEq(uint8(lr.mode), uint8(LM.Mode.REDUCE));
        assertEq(uint8(lr.result), uint8(LM.Result.DONE));
        assertGt(e.mockAccount(1).lots, 0, "partial reduction, no flip");

        // 6. No keeper until the floor: time alone changes gates; the sweep reconciles.
        vm.warp(T - 43_200);
        assertEq(uint8(e.currentStage()), uint8(Stage.BACKING_FLOOR));
        assertFalse(e.floorReconciled());
        while (e.sweep(32) != FloorLifecycle.FloorStatus.RECONCILED) {}
        assertTrue(e.floorReconciled());

        // 7. Scheduled halt materialized late by anyone; YES; jobs; claims.
        vm.warp(T + 900);
        HaltView memory h = e.materializeScheduledHalt();
        assertEq(h.economicHaltAt, T);
        oracle.finalize(1);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PREPARING));
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.CLAIMABLE));
        assertEq(uint8(e.currentStage()), uint8(Stage.CLAIMS_READY));
    }

    function test_earlyHaltNoPath() public {
        keep(L0 + 12 hours, 6e17, true);
        vm.warp(L0 + 5 days);
        oracle.haltEarly();
        oracle.finalize(2);
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
        SettlementView memory v = e.getSettlementStatus();
        assertEq(uint8(v.finalOutcome), uint8(MathTypes.FinalOutcome.NO));
        assertEq(v.settlementPriceE18, 0);
        assertLt(block.timestamp, T, "binary payoffs do not wait for T");
    }

    function test_earlyInvalidPendingThenCapture() public {
        vm.warp(L0 + 5 days);
        oracle.finalize(3);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PRICE_PENDING));
        for (uint64 t = T - 86_420; t <= T; t += 20) {
            e.feed(t, t, 45e16, 0, 0);
        }
        vm.warp(T);
        (, bool captured) = e.captureInvalidPrice();
        assertTrue(captured);
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
        assertEq(e.getSettlementStatus().settlementPriceE18, 45e16);
    }

    function test_conversionStaysDisabled() public {
        vm.warp(L0 + 5 days);
        oracle.finalize(1);
        assertEq(e.conversionEligibility(), e.R_DISABLED());
    }
}
