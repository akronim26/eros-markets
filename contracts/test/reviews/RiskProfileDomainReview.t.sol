pragma solidity ^0.8.30;

import {RealBookPolicyReviewBase} from "./BootstrapPriceBandReview.t.sol";
import {RiskFixture} from "../math/B/B011.t.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {AccountingState} from "../../src/math/RiskTypes.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {RiskContextPort} from "../../src/risk/RiskContextPort.sol";
import {PortHarness} from "../risk/B/B019.t.sol";

contract RiskProfileDomainReviewTest is RealBookPolicyReviewBase {
    bytes4 private constant PROFILE_HAZARD_BOUNDS = bytes4(keccak256("ProfileHazardBounds()"));

    function _completeRollover() private {
        (,, uint64 epochEnd,,,,) = engine.epoch();
        vm.warp(epochEnd);
        engine.beginRollover();
        assertTrue(engine.rollPage(32));
        engine.finishRollover();
        assertEq(uint8(engine.work()), uint8(AccountingState.READY));
        _assertConservation();
    }

    function testGovernanceRejectsUnsupportedHazardsBeforeStaging() public {
        bytes32 originalProfile = engine.activeProfile().profileHash;
        MarginMath.RiskParams memory parameters = RiskFixture.profile(1, false);
        parameters.hazard0WadPerDay = 1e18 + 1;
        vm.prank(GOVERNOR);
        vm.expectRevert(PROFILE_HAZARD_BOUNDS);
        engine.stageRiskParams(parameters);
        parameters.hazard0WadPerDay = 1e14;
        parameters.hazard1WadPerDay = 1e18 + 1;
        vm.prank(GOVERNOR);
        vm.expectRevert(PROFILE_HAZARD_BOUNDS);
        engine.stageRiskParams(parameters);
        assertFalse(engine.riskContext().monitorRestricted);
        _completeRollover();
        assertEq(engine.activeProfile().profileHash, originalProfile);
    }

    function testMonitorRejectsUnsupportedHazardsWithoutAddingRestriction() public {
        bytes32 originalProfile = engine.activeProfile().profileHash;
        vm.prank(MONITOR);
        vm.expectRevert(PROFILE_HAZARD_BOUNDS);
        engine.raiseHazards(1e18 + 1, 1e14);
        vm.prank(MONITOR);
        vm.expectRevert(PROFILE_HAZARD_BOUNDS);
        engine.raiseHazards(1e14, 1e18 + 1);
        assertFalse(engine.riskContext().monitorRestricted);
        _completeRollover();
        assertEq(engine.activeProfile().profileHash, originalProfile);
    }

    function testRejectedHazardUpdatesPreservePreviouslyStagedProfile() public {
        MarginMath.RiskParams memory staged = RiskFixture.profile(1, false);
        staged.hazard0WadPerDay = 2e14;
        staged.hazard1WadPerDay = 3e14;
        bytes32 expectedHash = engine.profileHashOf(staged);
        vm.prank(GOVERNOR);
        engine.stageRiskParams(staged);
        staged.hazard0WadPerDay = 1e18 + 1;
        vm.prank(GOVERNOR);
        vm.expectRevert(PROFILE_HAZARD_BOUNDS);
        engine.stageRiskParams(staged);
        vm.prank(MONITOR);
        vm.expectRevert(PROFILE_HAZARD_BOUNDS);
        engine.raiseHazards(1e18 + 1, 3e14);
        assertFalse(engine.riskContext().monitorRestricted);
        _completeRollover();
        assertEq(engine.activeProfile().profileHash, expectedHash);
        (uint256 hazardNo, uint256 hazardYes,) = engine.tariff();
        assertEq(hazardNo, 2e14);
        assertEq(hazardYes, 3e14);
    }

    function testSupportedMaximumHazardsStillCompleteRollover() public {
        MarginMath.RiskParams memory expected = RiskFixture.profile(1, false);
        expected.hazard0WadPerDay = 1e18;
        expected.hazard1WadPerDay = 1e18;
        vm.prank(MONITOR);
        engine.raiseHazards(1e18, 1e18);
        assertTrue(engine.riskContext().monitorRestricted);
        _completeRollover();
        assertEq(engine.activeProfile().profileHash, engine.profileHashOf(expected));
        (uint256 hazardNo, uint256 hazardYes, uint256 load) = engine.tariff();
        assertEq(hazardNo, 1e18);
        assertEq(hazardYes, 1e18);
        assertEq(load, 1e18);
    }

    function testBootstrapBandOutsideProbabilityDomainIsRejected() public {
        PortHarness port = new PortHarness();
        IMarketConfig.Listing memory configuration = engine.listing();
        configuration.bootstrapBandWad = 1e18 + 1;
        (bool accepted, uint8 reason) = port.validateListing(configuration);
        assertFalse(accepted);
        assertEq(reason, 5);
        configuration.bootstrapBandWad = type(uint256).max;
        vm.expectRevert(abi.encodeWithSelector(RiskContextPort.BadListing.selector, uint8(5)));
        port.init(configuration, RiskFixture.profile(1, false));
    }

    function testSpreadOutsideProbabilityDomainIsRejected() public {
        PortHarness port = new PortHarness();
        IMarketConfig.Listing memory configuration = engine.listing();
        configuration.maxSpreadWad = 1e18 + 1;
        (bool accepted, uint8 reason) = port.validateListing(configuration);
        assertFalse(accepted);
        assertEq(reason, 5);
        vm.expectRevert(abi.encodeWithSelector(RiskContextPort.BadListing.selector, uint8(5)));
        port.init(configuration, RiskFixture.profile(1, false));
    }

    function testProbabilityBandDomainEndpointsRemainValid() public {
        PortHarness port = new PortHarness();
        IMarketConfig.Listing memory configuration = engine.listing();
        configuration.bootstrapBandWad = 0;
        configuration.maxSpreadWad = 0;
        (bool accepted, uint8 reason) = port.validateListing(configuration);
        assertTrue(accepted);
        assertEq(reason, 0);
        configuration.bootstrapBandWad = 1e18;
        configuration.maxSpreadWad = 1e18;
        (accepted, reason) = port.validateListing(configuration);
        assertTrue(accepted);
        assertEq(reason, 0);
        port.init(configuration, RiskFixture.profile(1, false));
        assertEq(port.listing().bootstrapBandWad, 1e18);
        assertEq(port.listing().maxSpreadWad, 1e18);
    }
}
