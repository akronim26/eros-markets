pragma solidity ^0.8.30;

import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {MarketFactory} from "@eros/factory/MarketFactory.sol";
import {EngineCodeStore} from "@eros/factory/EngineCodeStore.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {CollateralVault} from "@eros/vaults/CollateralVault.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {MarketInput} from "../../src/types/OracleTypes.sol";
import {RealMarketFixture} from "./RealMarketFixture.sol";

contract RealMarketFactoryTest is RealMarketFixture {
    bytes32 internal constant MARKET_ID = keccak256("factory-market");

    function testAtomicListingBindsRealEngineAndVault() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        IMarketConfig.Listing memory configuration = engine.listing();
        assertEq(realFactory.engineOf(MARKET_ID), address(engine));
        assertEq(registry.getMarketCore(MARKET_ID).engine, address(engine));
        assertEq(configuration.registry, address(registry));
        assertEq(configuration.resolutionAuthority, address(resolutionOracle));
        assertEq(configuration.governance, gov);
        assertEq(configuration.token, usdc);
        assertEq(configuration.scheduledT, REAL_T);
        assertEq(configuration.listedAt, NOW);
        assertEq(engine.listingHash(), keccak256(abi.encode(configuration)));
        assertEq(address(engine.collateralVault()), address(vault));
        assertEq(vault.governor(), address(realFactory));
        assertTrue(vault.engines(address(engine)));
        assertEq(engine.reserveVault().engine(), address(engine));
        assertEq(engine.marketOrderEpoch(), 1);
        assertEq(engine.maxFills(), 8);
        assertFalse(engine.active());
        assertFalse(engine.claimsEnabled());
        assertFalse(engine.fundingFeatureEnabled());
        assertFalse(engine.recoveryEnabled());
    }

    function testMarketsHaveSeparateReservesAndAllocations() public {
        BookRiskEngine first = _listReal(MARKET_ID, false);
        BookRiskEngine second = _listReal(keccak256("second-market"), false);
        assertTrue(address(first.reserveVault()) != address(second.reserveVault()));
        assertEq(first.reserveVault().engine(), address(first));
        assertEq(second.reserveVault().engine(), address(second));
        _fund(first, buyer);
        assertEq(vault.marketAtoms(address(first)), 100e6);
        assertEq(vault.marketAtoms(address(second)), 0);
        assertEq(second.participantCount(), 0);
    }

    function testOnlyRegistryCanDeployAndFactoryCannotRegisterArbitraryEngine() public {
        IMarketConfig.Listing memory configuration = _listing();
        vm.expectRevert(MarketFactory.Unauthorized.selector);
        realFactory.deployMarket(configuration, "");
        vm.prank(gov);
        vm.expectRevert(CollateralVault.Unauthorized.selector);
        vault.registerEngine(address(resolutionOracle));
    }

    function testRejectsReusedMarketId() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        IMarketConfig.Listing memory configuration = engine.listing();
        vm.prank(address(registry));
        vm.expectRevert(MarketFactory.MarketExists.selector);
        realFactory.deployMarket(configuration, "");
    }

    function testRejectsOpaqueEngineInit() public {
        MarketInput memory market = _input(MARKET_ID, false);
        IMarketConfig.Listing memory configuration = _listing();
        vm.prank(lister);
        vm.expectRevert(MarketFactory.UnsupportedEngineInit.selector);
        registry.createMarket(market, configuration, hex"00");
        assertEq(bondTreasury.committedListing(MARKET_ID), 0);
    }

    function testRejectsWrongTokenOrGovernance() public {
        MarketInput memory market = _input(MARKET_ID, false);
        IMarketConfig.Listing memory configuration = _listing();
        configuration.token = address(0x1234);
        vm.prank(lister);
        vm.expectRevert(MarketFactory.InvalidListing.selector);
        registry.createMarket(market, configuration, "");
        configuration.token = usdc;
        configuration.governance = buyer;
        vm.prank(lister);
        vm.expectRevert(MarketFactory.InvalidListing.selector);
        registry.createMarket(market, configuration, "");
    }

    function testRejectsWrongRegistryAuthorityAndZeroId() public {
        IMarketConfig.Listing memory configuration = _listing();
        configuration.registry = buyer;
        vm.startPrank(address(registry));
        vm.expectRevert(MarketFactory.InvalidListing.selector);
        realFactory.deployMarket(configuration, "");
        configuration.registry = address(registry);
        configuration.resolutionAuthority = buyer;
        vm.expectRevert(MarketFactory.InvalidListing.selector);
        realFactory.deployMarket(configuration, "");
        configuration.resolutionAuthority = address(resolutionOracle);
        configuration.marketId = bytes32(0);
        vm.expectRevert(MarketFactory.InvalidListing.selector);
        realFactory.deployMarket(configuration, "");
        vm.stopPrank();
    }

    function testConstructorRejectsUnpacedLeverageAndShortHorizon() public {
        MarketInput memory market = _input(MARKET_ID, false);
        IMarketConfig.Listing memory configuration = _listing();
        configuration.deploymentCapX = 5;
        vm.prank(lister);
        vm.expectRevert(BookRiskEngine.UnsafeInitialConfiguration.selector);
        registry.createMarket(market, configuration, "");
        configuration.deploymentCapX = 1;
        market.tau = NOW + 1800;
        market.windowEnd = market.tau;
        vm.prank(lister);
        vm.expectRevert(abi.encodeWithSignature("BadUnits()"));
        registry.createMarket(market, configuration, "");
        assertEq(realFactory.engineOf(MARKET_ID), address(0));
        assertEq(bondTreasury.committedListing(MARKET_ID), 0);
    }

    function testDownstreamFailureRollsBackEngineVaultAndBondCommitment() public {
        MarketInput memory market = _input(MARKET_ID, false);
        IMarketConfig.Listing memory configuration = _listing();
        address predicted = vm.computeCreateAddress(address(realFactory), vm.getNonce(address(realFactory)));
        vm.mockCallRevert(
            address(resolutionOracle), abi.encodeCall(IResolutionOracle.initResolution, (MARKET_ID)), hex"deadbeef"
        );
        vm.prank(lister);
        vm.expectRevert(bytes4(0xdeadbeef));
        registry.createMarket(market, configuration, "");
        assertEq(predicted.code.length, 0);
        assertFalse(vault.engines(predicted));
        assertEq(realFactory.engineOf(MARKET_ID), address(0));
        assertEq(registry.getMarketCore(MARKET_ID).engine, address(0));
        assertEq(bondTreasury.committedListing(MARKET_ID), 0);
        vm.clearMockedCalls();
        assertEq(address(_listReal(MARKET_ID, false)), predicted);
    }

    function testCodeStoreIsPinnedAndNonExecutable() public {
        (bool success, bytes memory returned) = engineCodeStore.call(hex"12345678");
        assertTrue(success);
        assertEq(returned.length, 0);
        assertEq(engineCodeStore.codehash, realFactory.codeStoreHash());
        vm.etch(engineCodeStore, hex"0000");
        MarketInput memory market = _input(MARKET_ID, false);
        IMarketConfig.Listing memory configuration = _listing();
        vm.prank(lister);
        vm.expectRevert(MarketFactory.InvalidEngineCode.selector);
        registry.createMarket(market, configuration, "");
    }

    function testWrongCreationCodeHashRejected() public {
        vm.expectRevert(MarketFactory.InvalidEngineCode.selector);
        new MarketFactory(address(registry), usdc, reserveTreasury, engineCodeStore, engineCodeStoreTail, keccak256("wrong"));
    }

    function testTailIsNonExecutableAndTamperingRollsBackListing() public {
        assertGt(engineCodeStoreTail.code.length, 1);
        (bool success, bytes memory returned) = engineCodeStoreTail.call(hex"12345678");
        assertTrue(success);
        assertEq(returned.length, 0);
        assertEq(realFactory.codeStoreTailHash(), engineCodeStoreTail.codehash);
        vm.etch(engineCodeStoreTail, hex"0000");
        MarketInput memory market = _input(MARKET_ID, false);
        IMarketConfig.Listing memory configuration = _listing();
        vm.prank(lister);
        vm.expectRevert(MarketFactory.InvalidEngineCode.selector);
        registry.createMarket(market, configuration, "");
        assertEq(realFactory.engineOf(MARKET_ID), address(0));
        assertEq(bondTreasury.committedListing(MARKET_ID), 0);
    }

    function testMissingReorderedAndExecutableChunksAreRejected() public {
        bytes32 approved = realFactory.creationCodeHash();
        vm.expectRevert(MarketFactory.InvalidEngineCode.selector);
        new MarketFactory(address(registry), usdc, reserveTreasury, engineCodeStore, address(0), approved);
        vm.expectRevert(MarketFactory.InvalidEngineCode.selector);
        new MarketFactory(address(registry), usdc, reserveTreasury, engineCodeStoreTail, engineCodeStore, approved);
        vm.etch(engineCodeStoreTail, hex"5b00");
        vm.expectRevert(MarketFactory.InvalidEngineCode.selector);
        new MarketFactory(address(registry), usdc, reserveTreasury, engineCodeStore, engineCodeStoreTail, approved);
    }

    function testCodeStoreBounds() public {
        vm.expectRevert(EngineCodeStore.InvalidCodeSize.selector);
        new EngineCodeStore("");
        bytes memory oversized = new bytes(131072);
        vm.expectRevert(EngineCodeStore.InvalidCodeSize.selector);
        new EngineCodeStore(oversized);
    }
}
