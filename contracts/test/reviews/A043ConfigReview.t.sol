pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PortHarness, ListingFixture} from "../risk/B/B019.t.sol";
import {RiskFixture} from "../math/B/B011.t.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";

contract A043ConfigReviewTest is Test {
    PortHarness internal harness;
    IMarketConfig.Listing internal marketListing;
    address internal constant GOVERNANCE = address(0x60);

    function setUp() public {
        vm.warp(1000);
        harness = new PortHarness();
        marketListing = ListingFixture.make(1000, address(0xAC), address(0x30), GOVERNANCE, address(0x51));
        marketListing.deploymentCapX = 1;
    }

    function testInitialProfileCannotExceedListedCap() public {
        vm.expectRevert();
        harness.init(marketListing, RiskFixture.profile(5, true));
    }

    function testGovernanceCannotStageCapAboveListing() public {
        harness.init(marketListing, RiskFixture.profile(1, true));
        vm.prank(GOVERNANCE);
        vm.expectRevert();
        harness.stageRiskParams(RiskFixture.profile(5, true));
    }

    function testInitialProfileCannotChangeListedTemplate() public {
        MarginMath.RiskParams memory profile = RiskFixture.profile(1, true);
        profile.template = MarginMath.Template.CONTINUOUS;
        vm.expectRevert();
        harness.init(marketListing, profile);
    }

    function testGovernanceCannotStageAnotherTemplate() public {
        harness.init(marketListing, RiskFixture.profile(1, true));
        MarginMath.RiskParams memory profile = RiskFixture.profile(1, true);
        profile.template = MarginMath.Template.CONTINUOUS;
        vm.prank(GOVERNANCE);
        vm.expectRevert();
        harness.stageRiskParams(profile);
    }

    function testGovernanceCanReduceCapWithinListing() public {
        marketListing.deploymentCapX = 5;
        harness.init(marketListing, RiskFixture.profile(5, true));
        MarginMath.RiskParams memory profile = RiskFixture.profile(1, true);
        vm.prank(GOVERNANCE);
        harness.stageRiskParams(profile);
        harness.epochOpened();
        assertEq(harness.paramsHash(), harness.profileHashOf(profile));
    }
}
