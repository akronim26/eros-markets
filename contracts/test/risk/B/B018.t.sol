// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RiskPricing, RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {PricingMode, Stage} from "../../../provisional/MathTypes.sol";

contract PricingHarness is RiskPricing {
    uint64 public earlyHalt;

    constructor(uint64 T, uint64 listedAt) {
        _initIngress(keccak256("m"), keccak256("idx"), DepthRule(500, 5e16));
        _initRiskPricing(T, listedAt, 5e16, keccak256("profile-1"));
    }

    function index(uint64 t, uint256 p) external {
        _onIndexObservation(t, p, true);
    }

    function perp(uint64 t, uint256 bid, uint256 ask, uint256 depth) external {
        _recordPerp(t, bid, ask, depth, depth);
    }

    function openEpoch() external returns (PricingMode) {
        return _onEpochOpening();
    }

    function stage(bytes32 h) external {
        _stageRiskProfile(h);
    }

    function setHalt(uint64 t) external {
        earlyHalt = t;
    }

    function _earlyHaltAt() internal view override returns (uint64) {
        return earlyHalt;
    }

    function bandCheck(uint16 tick) external view {
        _checkBootstrapBand(_riskContext(), tick);
    }

    function leveraged() external view returns (bool) {
        return _leveragedAllowed(_riskContext());
    }

    function markLiq() external view returns (bool) {
        return _markLiquidationAllowed(_riskContext());
    }
}

/// B018: risk context and pricing bootstrap.
contract B018Test is Test {
    uint64 constant T = 10 days;
    PricingHarness h;

    function setUp() public {
        h = new PricingHarness(T, 0);
        vm.warp(1 days);
    }

    function feedIndex(uint64 from, uint64 to, uint256 p) internal {
        for (uint64 t = from; t <= to; t += 10) {
            h.index(t, p);
        }
    }

    function feedPerp(uint64 from, uint64 to, uint256 bid, uint256 ask) internal {
        for (uint64 t = from; t <= to; t += 10) {
            h.perp(t, bid, ask, 600);
        }
    }

    function test_emptyBookBootstrapUsesIndexOnly() public {
        feedIndex(1 days - 400, 1 days, 6e17);
        RiskContext memory c = h.riskContext();
        assertTrue(c.indexOk);
        assertEq(c.indexWad, 6e17);
        assertFalse(c.markOk, "no perp depth: no normal mark");
        assertEq(uint8(c.pricingMode), uint8(PricingMode.BOOTSTRAP));
        assertEq(uint8(c.admission), uint8(LifecycleMath.Admission.BACKED_ONLY));
        assertFalse(h.leveraged());
        assertFalse(h.markLiq());
        h.bandCheck(600);
        h.bandCheck(650);
        vm.expectRevert(RiskPricing.OutsideBootstrapBand.selector);
        h.bandCheck(651);
    }

    function test_noIndexNoExposure() public {
        RiskContext memory c = h.riskContext();
        assertFalse(c.indexOk);
        assertEq(uint8(c.admission), uint8(LifecycleMath.Admission.NONE));
        vm.expectRevert(RiskPricing.OutsideBootstrapBand.selector);
        h.bandCheck(600);
    }

    function test_normalOnlyAtEpochOpeningWithAllWindows() public {
        feedIndex(1 days - 1000, 1 days, 6e17);
        feedPerp(1 days - 1000, 1 days, 61e16, 63e16);
        // windows are valid but mode is still bootstrap until an epoch opening
        RiskContext memory c = h.riskContext();
        assertFalse(c.markOk);
        assertEq(uint8(c.admission), uint8(LifecycleMath.Admission.BACKED_ONLY));
        assertEq(uint8(h.openEpoch()), uint8(PricingMode.NORMAL_PRICING));
        c = h.riskContext();
        assertTrue(c.markOk);
        // median(0.60 + 0.02, 0.62, 0.62) = 0.62, band b = 0.05 * 9d/10d = 0.045 -> not clamped
        assertEq(c.markWad, 62e16);
        assertEq(uint8(c.admission), uint8(LifecycleMath.Admission.LEVERAGED));
        assertTrue(h.leveraged());
        assertTrue(h.markLiq());
    }

    function test_openingWithoutFullWindowsStaysBootstrap() public {
        feedIndex(1 days - 1000, 1 days, 6e17);
        feedPerp(1 days - 30, 1 days, 61e16, 63e16); // perp 60 s window incomplete
        assertEq(uint8(h.openEpoch()), uint8(PricingMode.BOOTSTRAP));
    }

    function test_missingPerpAfterNormalFallsBackToBackedOnly() public {
        feedIndex(1 days - 1000, 1 days, 6e17);
        feedPerp(1 days - 1000, 1 days, 61e16, 63e16);
        h.openEpoch();
        vm.warp(1 days + 200);
        feedIndex(1 days + 10, 1 days + 200, 6e17); // index stays fresh, perp goes stale
        RiskContext memory c = h.riskContext();
        assertFalse(c.markOk, "missing normal mark");
        assertEq(uint8(c.admission), uint8(LifecycleMath.Admission.BACKED_ONLY));
        assertFalse(h.leveraged(), "never leveraged without the mark");
        assertFalse(h.markLiq(), "no mark liquidation without the mark");
    }

    function test_haltOverridesBootstrap() public {
        feedIndex(1 days - 400, 1 days, 6e17);
        h.setHalt(1 days);
        RiskContext memory c = h.riskContext();
        assertTrue(c.halted);
        assertEq(uint8(c.stage), uint8(Stage.HALTED));
        assertEq(uint8(c.admission), uint8(LifecycleMath.Admission.NONE));
    }

    function test_profileActivatesOnlyAtEpochOpening() public {
        h.stage(keccak256("profile-2"));
        RiskContext memory c = h.riskContext();
        assertEq(c.profileHash, keccak256("profile-1"));
        assertEq(c.riskVersion, 1);
        h.openEpoch();
        c = h.riskContext();
        assertEq(c.profileHash, keccak256("profile-2"));
        assertEq(c.riskVersion, 2);
    }

    function test_contextCarriesTimeAndStage() public {
        vm.warp(T - 12 hours);
        RiskContext memory c = h.riskContext();
        assertEq(c.economicTime, T - 12 hours);
        assertEq(c.secsToT, 12 hours);
        assertEq(uint8(c.stage), uint8(Stage.BACKING_FLOOR));
        assertTrue(c.fundingFrozen);
        assertTrue(c.fullBackingByTime);
    }
}
