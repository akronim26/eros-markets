pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {TestnetRiskSmoke, TestnetRiskTrader} from "../../script/ExerciseTestnetRiskBook.s.sol";
import {BookRiskEngine} from "../../src/engine/BookRiskEngine.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {IResolutionEngine} from "../../src/interfaces/IResolutionIngress.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {PriceIngress} from "../../src/pricing/PriceIngress.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {
    TestnetRiskCollateral,
    TestnetResolutionAuthority
} from "../mocks/integration/TestnetRiskFixtures.sol";

contract TestnetRiskSmokeTest is Test {
    uint256 constant CONTROLLER_KEY = 0xA110CE;
    address controller;
    BookRiskEngine engine;
    TestnetRiskCollateral token;
    TestnetResolutionAuthority oracle;
    CollateralVault vault;
    TestnetRiskSmoke smoke;
    IMarketConfig.Listing configuration;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1_000_000);
        controller = vm.addr(CONTROLLER_KEY);
        token = new TestnetRiskCollateral(controller);
        oracle = new TestnetResolutionAuthority(controller);
        vault = new CollateralVault(address(token), controller);
        configuration.marketId = keccak256("testnet-smoke-unit-fixture");
        configuration.token = address(token);
        configuration.registry = controller;
        configuration.resolutionAuthority = address(oracle);
        configuration.monitor = controller;
        configuration.governance = controller;
        configuration.scheduledT = uint64(block.timestamp + 10 days);
        configuration.listedAt = uint64(block.timestamp);
        configuration.sourceHash = keccak256("TESTNET_ONLY_CONTROLLER_SIGNED_INDEX_NOT_LIVE_SOURCE");
        configuration.rulesHash = keccak256("TESTNET_ONLY_CONTROLLER_FINALITY_NOT_PRODUCTION_ORACLE");
        configuration.invalidRule = IMarketConfig.InvalidRule(true, 3600, 5e17, 30 days);
        configuration.template = MarginMath.Template.SCHEDULED;
        configuration.deploymentCapX = 1;
        configuration.maxTraders = 1024;
        configuration.indexSourceId = keccak256("TESTNET_ONLY_SIGNED_INDEX");
        configuration.indexSigner = controller;
        configuration.indexRulesHash = keccak256("TESTNET_ONLY_INDEX_DEPTH_500_SPREAD_0_05");
        configuration.depthNLots = 500;
        configuration.maxSpreadWad = 5e16;
        configuration.bootstrapBandWad = 5e16;
        configuration.minOrderLots = 1;
        configuration.maxOrderLots = uint64(1) << 32;
        engine = new BookRiskEngine(vault, controller, configuration);
        vm.startPrank(controller);
        vault.registerEngine(address(engine));
        oracle.bind(IResolutionEngine(address(engine)));
        vm.stopPrank();
        smoke = new TestnetRiskSmoke(engine, controller);
    }

    function _fundAndActivate() internal {
        vm.startPrank(controller);
        token.mint(address(smoke.buyer()), 100e6);
        token.mint(address(smoke.seller()), 100e6);
        smoke.fund();
        engine.activateMarket();
        vm.stopPrank();
    }

    function _window(uint256 key)
        internal
        view
        returns (IPriceSource.Observation[] memory observations, bytes[] memory signatures)
    {
        observations = new IPriceSource.Observation[](31);
        signatures = new bytes[](31);
        uint64 firstSequence = engine.sourceState(configuration.indexSourceId).lastSequence + 1;
        for (uint64 index; index < 31; ++index) {
            observations[index] = IPriceSource.Observation({
                marketId: configuration.marketId,
                sourceId: configuration.indexSourceId,
                sequence: firstSequence + index,
                observedAt: uint64(block.timestamp - 300 + index * 10),
                publishedAt: uint64(block.timestamp),
                priceWad: 5e17,
                impactBidWad: 49e16,
                impactAskWad: 51e16,
                bidDepthLots: configuration.depthNLots,
                askDepthLots: configuration.depthNLots,
                sourceRulesHash: configuration.indexRulesHash
            });
            (uint8 recovery, bytes32 signatureR, bytes32 signatureS) =
                vm.sign(key, engine.observationDigest(observations[index]));
            signatures[index] = abi.encodePacked(signatureR, signatureS, recovery);
        }
    }

    function _trade() internal {
        _fundAndActivate();
        (IPriceSource.Observation[] memory observations, bytes[] memory signatures) = _window(CONTROLLER_KEY);
        vm.prank(controller);
        smoke.executeTrade(observations, signatures);
    }

    function testControlledSignedWindowRealBookAndPagedCashSettlement() public {
        _trade();
        assertTrue(smoke.traded());
        assertEq(engine.oiAllLots(), 100_000);
        assertEq(engine.account(address(smoke.buyer())).value.cashQ, 50e24);
        assertEq(engine.account(address(smoke.seller())).value.cashQ, 150e24);
        assertEq(engine.traderIdOf(address(smoke.buyer())), 1);
        assertEq(engine.traderIdOf(address(smoke.seller())), 2);
        assertEq(engine.sourceState(configuration.indexSourceId).lastSequence, 31);
        assertEq(vault.recognizedAtoms(), 200e6);
        vm.startPrank(controller);
        oracle.halt();
        assertTrue(oracle.finalize(1));
        assertFalse(engine.claimsEnabled());
        oracle.halt();
        assertFalse(oracle.finalize(1));
        smoke.completeSettlement();
        vm.stopPrank();
        assertTrue(smoke.completed());
        assertTrue(engine.halted());
        assertEq(engine.payoutCursor(), 2);
        assertEq(engine.allocationCursor(), 2);
        assertTrue(engine.allTraderClaimsPaid());
        assertEq(engine.unpaidTraderClaims(), 0);
        assertEq(token.balanceOf(address(smoke.buyer())), 150e6);
        assertEq(token.balanceOf(address(smoke.seller())), 50e6);
        assertEq(vault.recognizedAtoms(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function testHelpersCannotBeDrivenByUnrelatedCallersOrControllerDirectly() public {
        vm.expectRevert(TestnetRiskSmoke.SmokeUnauthorized.selector);
        smoke.fund();
        TestnetRiskTrader buyer = smoke.buyer();
        vm.expectRevert(TestnetRiskTrader.TraderUnauthorized.selector);
        buyer.fund();
        vm.prank(controller);
        vm.expectRevert(TestnetRiskTrader.TraderUnauthorized.selector);
        buyer.place(true);
        IPriceSource.Observation[] memory observations = new IPriceSource.Observation[](0);
        bytes[] memory signatures = new bytes[](0);
        vm.expectRevert(TestnetRiskSmoke.SmokeUnauthorized.selector);
        smoke.relayWindow(observations, signatures);
        vm.expectRevert(TestnetRiskSmoke.SmokeUnauthorized.selector);
        smoke.executeTrade(observations, signatures);
        vm.expectRevert(TestnetRiskSmoke.SmokeUnauthorized.selector);
        smoke.completeSettlement();
    }

    function testRejectsMainnetAndWrongFixtureController() public {
        vm.chainId(143);
        vm.expectRevert(TestnetRiskSmoke.TestnetSmokeOnly.selector);
        new TestnetRiskSmoke(engine, controller);
        vm.prank(controller);
        vm.expectRevert(TestnetRiskSmoke.TestnetSmokeOnly.selector);
        smoke.fund();
        vm.chainId(10143);
        vm.expectRevert(TestnetRiskSmoke.NotControlledFixture.selector);
        new TestnetRiskSmoke(engine, address(this));
    }

    function testForgedSignatureCannotTradeOrPartiallyPopulateHistory() public {
        _fundAndActivate();
        (IPriceSource.Observation[] memory observations, bytes[] memory signatures) = _window(CONTROLLER_KEY);
        signatures[30] = "";
        vm.prank(controller);
        vm.expectRevert(PriceIngress.BadSignature.selector);
        smoke.executeTrade(observations, signatures);
        assertEq(engine.sourceState(configuration.indexSourceId).lastSequence, 0);
        assertEq(engine.oiAllLots(), 0);
        assertEq(engine.account(address(smoke.buyer())).value.cashQ, 100e24);
        assertFalse(smoke.traded());
    }

    function testDelayedMinedWindowRevertsAtomicallyAndFreshRetrySucceeds() public {
        _fundAndActivate();
        (IPriceSource.Observation[] memory observations, bytes[] memory signatures) = _window(CONTROLLER_KEY);
        vm.warp(block.timestamp + 31);
        vm.prank(controller);
        vm.expectRevert(TestnetRiskSmoke.UnusableIndex.selector);
        smoke.executeTrade(observations, signatures);
        assertEq(engine.sourceState(configuration.indexSourceId).lastSequence, 0);
        assertEq(engine.oiAllLots(), 0);
        (observations, signatures) = _window(CONTROLLER_KEY);
        vm.prank(controller);
        smoke.executeTrade(observations, signatures);
        assertTrue(smoke.traded());
    }

    function testWindowIsBoundedAndSignatureCountMustMatch() public {
        IPriceSource.Observation[] memory observations = new IPriceSource.Observation[](32);
        bytes[] memory signatures = new bytes[](32);
        vm.startPrank(controller);
        vm.expectRevert(TestnetRiskSmoke.InvalidWindow.selector);
        smoke.relayWindow(observations, signatures);
        observations = new IPriceSource.Observation[](1);
        signatures = new bytes[](0);
        vm.expectRevert(TestnetRiskSmoke.InvalidWindow.selector);
        smoke.relayWindow(observations, signatures);
        vm.stopPrank();
    }

    function testWrongOutcomeCannotBeMisreportedAsExpectedCashSettlement() public {
        _trade();
        vm.startPrank(controller);
        oracle.halt();
        assertTrue(oracle.finalize(0));
        vm.expectRevert(TestnetRiskSmoke.SettlementMismatch.selector);
        smoke.completeSettlement();
        vm.stopPrank();
        assertFalse(smoke.completed());
        assertFalse(engine.claimsEnabled());
        assertEq(vault.recognizedAtoms(), 200e6);
        assertEq(token.balanceOf(address(smoke.buyer())), 0);
    }
}
