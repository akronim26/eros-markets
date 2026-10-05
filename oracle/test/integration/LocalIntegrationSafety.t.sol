pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LocalIntegration} from "../../script/integration/LocalIntegration.s.sol";

contract LocalIntegrationSafetyTest is Test {
    LocalIntegration internal local;

    function setUp() public {
        local = new LocalIntegration();
    }

    function testDeploymentRejectsPublicNetworksBeforeBroadcasting() public {
        vm.chainId(10143);
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.run(keccak256("demo"), keccak256("terminal"), uint64(block.timestamp + 26 hours));
        vm.chainId(143);
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.run(keccak256("demo"), keccak256("terminal"), uint64(block.timestamp + 26 hours));
    }

    function testEveryLifecycleEntryRejectsPublicNetworkBeforeReads() public {
        vm.chainId(10143);
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.trade(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.tradeLeveraged(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.fundLeveraged(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.runLeveraged(keccak256("demo"), keccak256("terminal"), uint64(block.timestamp + 29 days));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.runLive("must-not-read-this-file.json", keccak256("terminal"));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.beginSettlement(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.beginLeveragedSettlement(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.finishSettlement(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.resolveAssertion(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.resolveLeveragedAssertion(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.claim(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.claimLeveraged(address(1));
    }

    function testLeveragedClosureRejectsMainnetBeforeReads() public {
        vm.chainId(143);
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.beginLeveragedSettlement(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.resolveLeveragedAssertion(address(1));
        vm.expectRevert(LocalIntegration.LocalChainOnly.selector);
        local.claimLeveraged(address(1));
    }

    function testDeploymentRefusesUnboundSourceRules() public {
        vm.chainId(31337);
        vm.expectRevert(LocalIntegration.InvalidLocalConfiguration.selector);
        local.run(bytes32(0), keccak256("terminal"), uint64(block.timestamp + 26 hours));
        vm.expectRevert(LocalIntegration.InvalidLocalConfiguration.selector);
        local.run(keccak256("demo"), bytes32(0), uint64(block.timestamp + 26 hours));
    }

    function testDeploymentRefusesShortOrExcessiveHorizon() public {
        vm.chainId(31337);
        vm.expectRevert(LocalIntegration.InvalidLocalConfiguration.selector);
        local.run(keccak256("demo"), keccak256("terminal"), uint64(block.timestamp + 24 hours));
        vm.expectRevert(LocalIntegration.InvalidLocalConfiguration.selector);
        local.run(keccak256("demo"), keccak256("terminal"), uint64(block.timestamp + 30 days));
    }
}
