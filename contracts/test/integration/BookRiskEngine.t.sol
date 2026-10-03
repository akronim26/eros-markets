pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../../src/Book.sol";
import {BookRiskEngine} from "../../src/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {PricingMode} from "../../src/math/RiskTypes.sol";
import {PriceIngress} from "../../src/pricing/PriceIngress.sol";
import {RiskContextPort} from "../../src/risk/RiskContextPort.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../risk/B/B019.t.sol";

abstract contract BookRiskEngineFixture is Test {
    uint256 constant SIGNER_KEY = 0x516;
    address constant GOVERNOR = address(0x6007);
    address constant BUYER = address(0x101);
    address constant SELLER = address(0x102);
    address constant TREASURY = address(0x777);

    BookRiskEngine engine;
    CollateralVault vault;
    MockUSDC token;
    MockResolutionAuthority oracle;
    IMarketConfig.Listing configuration;

    function setUp() public {
        vm.warp(1_000_000);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        oracle = new MockResolutionAuthority();
        configuration = ListingFixture.make(
            uint64(block.timestamp), address(oracle), address(0x3031), GOVERNOR, vm.addr(SIGNER_KEY)
        );
        configuration.token = address(token);
        configuration.deploymentCapX = 1;
        configuration.fundingEnabled = false;
        configuration.maxLiqLotsPerBlock = 0;
        engine = new BookRiskEngine(vault, TREASURY, configuration);
        vault.registerEngine(address(engine));
        oracle.bind(engine);
        _fund(BUYER);
        _fund(SELLER);
        vm.prank(GOVERNOR);
        engine.activateMarket();
    }

    function _fund(address owner) internal {
        token.mint(owner, 100e6);
        vm.startPrank(owner);
        token.approve(address(vault), 100e6);
        vault.deposit(100e6);
        vault.allocate(address(engine), 100e6, false);
        vm.stopPrank();
    }

    function _observation(uint64 sequence) internal view returns (IPriceSource.Observation memory) {
        return IPriceSource.Observation({
            marketId: configuration.marketId,
            sourceId: configuration.indexSourceId,
            sequence: sequence,
            observedAt: uint64(block.timestamp),
            publishedAt: uint64(block.timestamp),
            priceWad: 5e17,
            impactBidWad: 49e16,
            impactAskWad: 51e16,
            bidDepthLots: configuration.depthNLots,
            askDepthLots: configuration.depthNLots,
            sourceRulesHash: configuration.indexRulesHash
        });
    }

    function _signature(IPriceSource.Observation memory observation, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 recovery, bytes32 signatureR, bytes32 signatureS) =
            vm.sign(key, engine.observationDigest(observation));
        return abi.encodePacked(signatureR, signatureS, recovery);
    }

    function _warmIndex() internal {
        for (uint64 sequence = 1; sequence <= 31; ++sequence) {
            IPriceSource.Observation memory observation = _observation(sequence);
            engine.submitObservation(observation, _signature(observation, SIGNER_KEY));
            if (sequence != 31) vm.warp(block.timestamp + 10);
        }
    }

    function _order(address owner, bool isBuy, IBookRiskHooks.OrderKind kind, uint64 lots)
        internal
        returns (uint32)
    {
        vm.prank(owner);
        return engine.placeOrder(Book.Place(kind, isBuy, false, 500, lots, 64, 0));
    }
}

contract BookRiskEngineTest is BookRiskEngineFixture {
    function testInitialReleaseDefaultsCannotEnableLeverageOrFunding() public {
        assertEq(engine.listing().deploymentCapX, 1);
        assertFalse(engine.fundingFeatureEnabled());
        assertFalse(engine.recoveryEnabled());
        assertEq(engine.conversionEligibility(), engine.R_DISABLED());
        assertEq(engine.maxFills(), 64);
        configuration.deploymentCapX = 5;
        vm.expectRevert(BookRiskEngine.UnsafeInitialConfiguration.selector);
        new BookRiskEngine(vault, TREASURY, configuration);
        configuration.deploymentCapX = 1;
        configuration.fundingEnabled = true;
        vm.expectRevert(BookRiskEngine.UnsafeInitialConfiguration.selector);
        new BookRiskEngine(vault, TREASURY, configuration);
    }

    function testRejectsMismatchedVaultTokenAndMissingAuthorityCode() public {
        configuration.token = address(0x1234);
        vm.expectRevert(BookRiskEngine.InvalidDeploymentDependency.selector);
        new BookRiskEngine(vault, TREASURY, configuration);
        configuration.token = address(token);
        configuration.resolutionAuthority = address(0x1234);
        vm.expectRevert(BookRiskEngine.InvalidDeploymentDependency.selector);
        new BookRiskEngine(vault, TREASURY, configuration);
    }

    function testRejectsUnsupportedTraderLimitAndUnmeasuredLiquidationBudget() public {
        configuration.maxTraders = 100;
        vm.expectRevert(BookRiskEngine.UnsafeInitialConfiguration.selector);
        new BookRiskEngine(vault, TREASURY, configuration);
        configuration.maxTraders = 1024;
        configuration.maxLiqLotsPerBlock = 100;
        vm.expectRevert(BookRiskEngine.UnsafeInitialConfiguration.selector);
        new BookRiskEngine(vault, TREASURY, configuration);
    }

    function testSignedIndexAndRealBookTradeThroughCashSettlement() public {
        _warmIndex();
        assertTrue(engine.riskContext().indexOk);
        assertFalse(engine.riskContext().markOk);
        assertEq(uint8(engine.pricingMode()), uint8(PricingMode.BOOTSTRAP));
        uint32 askId = _order(SELLER, false, IBookRiskHooks.OrderKind.LIMIT, 100_000);
        assertGt(askId, 0);
        _order(BUYER, true, IBookRiskHooks.OrderKind.IOC, 100_000);
        assertEq(engine.getOrder(askId).size, 0);
        assertEq(engine.oiAllLots(), 100_000);
        assertEq(engine.traderIdOf(BUYER), 1);
        assertEq(engine.traderIdOf(SELLER), 2);
        assertEq(engine.protocolFeeQ(), 0);
        assertEq(engine.allocationQ(), 200e24);
        oracle.haltEarly();
        assertTrue(oracle.finalize(1));
        assertFalse(engine.claimsEnabled());
        while (!engine.prepareSnapshotChunk(1).done) {}
        while (!engine.preparePayoutChunk(1).done) {}
        assertTrue(engine.finishPreparation());
        assertEq(engine.claimTrader(BUYER), 150e6);
        assertEq(engine.claimTrader(SELLER), 50e6);
        assertEq(token.balanceOf(BUYER), 150e6);
        assertEq(token.balanceOf(SELLER), 50e6);
        assertTrue(engine.allTraderClaimsPaid());
        assertEq(vault.recognizedAtoms(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function testMissingAndStaleIndexDoNotCreateOrders() public {
        assertEq(_order(SELLER, false, IBookRiskHooks.OrderKind.LIMIT, 100_000), 0);
        _warmIndex();
        vm.warp(block.timestamp + 31);
        assertFalse(engine.riskContext().indexOk);
        assertEq(_order(SELLER, false, IBookRiskHooks.OrderKind.LIMIT, 100_000), 0);
        assertEq(engine.oiAllLots(), 0);
    }

    function testRejectsUnsignedWrongSignerAndReplayObservations() public {
        IPriceSource.Observation memory observation = _observation(1);
        vm.expectRevert(PriceIngress.BadSignature.selector);
        engine.submitObservation(observation, "");
        bytes memory wrongSignature = _signature(observation, 0x999);
        vm.expectRevert(PriceIngress.BadSignature.selector);
        engine.submitObservation(observation, wrongSignature);
        bytes memory validSignature = _signature(observation, SIGNER_KEY);
        engine.submitObservation(observation, validSignature);
        vm.expectRevert(PriceIngress.DuplicateOrOldSequence.selector);
        engine.submitObservation(observation, validSignature);
    }

    function testSignatureIsBoundToChainAndEngine() public {
        IPriceSource.Observation memory observation = _observation(1);
        bytes memory signature = _signature(observation, SIGNER_KEY);
        uint256 originalChainId = block.chainid;
        vm.chainId(originalChainId + 1);
        vm.expectRevert(PriceIngress.BadSignature.selector);
        engine.submitObservation(observation, signature);
        vm.chainId(originalChainId);
        BookRiskEngine otherEngine = new BookRiskEngine(vault, TREASURY, configuration);
        vm.expectRevert(PriceIngress.BadSignature.selector);
        otherEngine.submitObservation(observation, signature);
    }

    function testTestHarnessMutatorsAreNotExposed() public {
        (bool feedSucceeded,) = address(engine)
            .call(
                abi.encodeWithSignature(
                    "feed(uint64,uint64,uint256,uint256,uint256)", 1, 2, 5e17, 49e16, 51e16
                )
            );
        (bool faultSucceeded,) = address(engine).call(abi.encodeWithSignature("failOnPosting(uint256)", 1));
        assertFalse(feedSucceeded);
        assertFalse(faultSucceeded);
    }

    function testGovernanceCannotStageAboveImmutableOneTimesCap() public {
        MarginMath.RiskParams memory parameters;
        parameters.template = configuration.template;
        parameters.deploymentCapX = 2;
        vm.prank(GOVERNOR);
        vm.expectRevert(RiskContextPort.ProfileListingMismatch.selector);
        engine.stageRiskParams(parameters);
    }
}
