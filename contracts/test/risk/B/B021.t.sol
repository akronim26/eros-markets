// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MonitorPolicy} from "../../../src/risk/MonitorPolicy.sol";
import {RiskContextPort} from "../../../src/risk/RiskContextPort.sol";
import {RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {Stage} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract GuardHarness is MonitorPolicy, MockAccountingPort {
    uint64[] public advanceCalls; // Person A hook: old freshness endpoint seen before each move

    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function index(uint64 t, uint256 p, bool valid) external {
        _onIndexObservation(t, p, valid);
    }

    function openEpoch() external {
        _riskEpochOpenedWithGuards();
    }

    function _onFreshnessAdvance(uint64 old) internal override {
        advanceCalls.push(old);
    }

    function fundingCutoff(uint64 epochEnd) external view returns (uint64) {
        return _riskFundingCutoff(epochEnd, 0, 0);
    }

    function freshAt(uint64 t) external view returns (bool) {
        return _indexFreshAt(t);
    }

    function oracleOnly() external view {
        _onlyResolutionAuthority();
    }

    function effectiveMargin(uint256 nowTs) external view returns (MarginMath.Margin memory) {
        return MarginMath.sideMargin(1_000_000, true, 6e17, 29 days, nowTs, _effectiveParams(nowTs));
    }

    function stagedHash() external view returns (bytes32, bool) {
        return (_stagedProfileHash, _hasStagedProfile);
    }

    function hazard0() external view returns (uint256) {
        return _params.hazard0WadPerDay;
    }

    function advanceCount() external view returns (uint256) {
        return advanceCalls.length;
    }
}

/// B021: source guards and monitor restrictions.
contract B021Test is Test {
    address constant ORACLE = address(0x0AC1E);
    address constant MONITOR = address(0x3031);
    address constant GOV = address(0x6007);
    GuardHarness h;
    uint64 constant L0 = 1_000_000;

    function setUp() public {
        vm.warp(L0);
        h = new GuardHarness();
        h.init(ListingFixture.make(L0, ORACLE, MONITOR, GOV, address(0x516)), RiskFixture.profile(5, true));
    }

    function feed(uint64 from, uint64 to, uint256 p) internal {
        for (uint64 t = from; t <= to; t += 10) {
            h.index(t, p, true);
        }
    }

    function test_lateFreshObservationCannotEraseGap() public {
        feed(L0, L0 + 300, 6e17);
        vm.warp(L0 + 300);
        h.openEpoch(); // epoch starts fresh at L0 + 300
        feed(L0 + 310, L0 + 600, 6e17);
        // gap: last sample L0 + 600 covers to L0 + 630; next sample at L0 + 700
        uint256 callsBefore = h.advanceCount();
        h.index(L0 + 700, 6e17, true);
        assertEq(h.advanceCalls(callsBefore), L0 + 630, "A accrues against the old endpoint first");
        feed(L0 + 710, L0 + 900, 6e17);
        vm.warp(L0 + 900);
        (uint64 freshThrough, uint64 stop,) = h.freshness();
        assertEq(freshThrough, L0 + 930, "continuous coverage resumed");
        assertEq(stop, L0 + 630, "epoch stop latched at the gap start");
        assertEq(h.fundingCutoff(L0 + 3600), L0 + 630, "funding cannot restart in this epoch");
        // the next completed epoch opens fresh and funding may run again
        h.openEpoch();
        (, stop,) = h.freshness();
        assertEq(stop, 0);
        assertEq(h.fundingCutoff(L0 + 7200), L0 + 900);
    }

    function test_invalidSampleEndsCoverage() public {
        feed(L0, L0 + 100, 6e17);
        vm.warp(L0 + 100);
        h.openEpoch();
        h.index(L0 + 110, 0, false);
        (uint64 freshThrough, uint64 stop,) = h.freshness();
        assertEq(freshThrough, L0 + 110);
        assertEq(stop, L0 + 110);
    }

    function test_staleThreshold30s() public {
        h.index(L0 + 10, 6e17, true);
        assertTrue(h.freshAt(L0 + 40));
        assertFalse(h.freshAt(L0 + 41));
    }

    function test_movementTriggersReduceOnly() public {
        feed(L0, L0 + 290, 50e16);
        h.index(L0 + 300, 61e16, true);
        vm.warp(L0 + 300);
        RiskContext memory c = h.riskContext();
        assertTrue(c.monitorRestricted);
        assertEq(uint8(c.stage), uint8(Stage.REDUCE_ONLY));
        vm.prank(MONITOR);
        h.clearReduceOnly("check failed: no event");
        assertEq(uint8(h.riskContext().stage), uint8(Stage.TRADING));
    }

    function test_monitorAuthenticatedReduceOnly() public {
        vm.expectRevert(RiskContextPort.Unauthorized.selector);
        h.requestReduceOnly("x");
        vm.prank(MONITOR);
        h.requestReduceOnly("suspected news");
        assertEq(uint8(h.riskContext().stage), uint8(Stage.REDUCE_ONLY));
    }

    function test_monitorCannotHaltSettleOrLowerHazards() public {
        vm.prank(MONITOR);
        vm.expectRevert(RiskContextPort.Unauthorized.selector);
        h.oracleOnly();
        vm.prank(MONITOR);
        vm.expectRevert(MonitorPolicy.HazardDecrease.selector);
        h.raiseHazards(5e13, 1e14);
        vm.prank(MONITOR);
        vm.expectRevert(RiskContextPort.Unauthorized.selector);
        h.stageRiskParams(RiskFixture.profile(5, true));
    }

    function test_hazardRaiseReduceOnlyNowProfileNextEpoch() public {
        vm.prank(MONITOR);
        h.raiseHazards(2e14, 2e14);
        assertEq(uint8(h.riskContext().stage), uint8(Stage.REDUCE_ONLY), "immediate reduce-only");
        assertEq(h.hazard0(), 1e14, "tariff unchanged mid-epoch");
        (, bool staged) = h.stagedHash();
        assertTrue(staged);
        h.openEpoch();
        assertEq(h.hazard0(), 2e14, "raised hazard active after the epoch opening");
    }

    function test_missingCalibrationForcesOneX() public {
        MarginMath.RiskParams memory p = RiskFixture.profile(5, true);
        p.realized.validUntil = L0 + 100;
        GuardHarness g = new GuardHarness();
        g.init(ListingFixture.make(L0, ORACLE, MONITOR, GOV, address(0x516)), p);
        MarginMath.Margin memory live = g.effectiveMargin(L0 + 99);
        assertFalse(live.fullBacking);
        assertEq(live.imQ, 120e24);
        MarginMath.Margin memory expired = g.effectiveMargin(L0 + 100);
        assertTrue(expired.fullBacking);
        assertEq(expired.capX, 1);
        assertEq(expired.imQ, 600e24);
    }
}
