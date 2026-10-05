pragma solidity ^0.8.30;

import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {Book} from "@eros/Book.sol";
import {EngineCodeStore} from "@eros/factory/EngineCodeStore.sol";
import {EngineCodeParts} from "@eros/factory/EngineCodeParts.sol";
import {MarketFactory} from "@eros/factory/MarketFactory.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IBookRiskHooks} from "@eros/interfaces/IBookRiskHooks.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {ClaimRenderer} from "../../src/libraries/ClaimRenderer.sol";
import {RegistryBookRiskEngine} from "../../src/integration/RegistryBookRiskEngine.sol";
import {MarketInput, Ledger, TrustSetInput, Outcome} from "../../src/types/OracleTypes.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";
import {RegistryFixture} from "../unit/RegistryFixture.sol";
import {SeamFixture} from "../seam/EngineHarness.sol";
import {RealMarketFixture} from "./RealMarketFixture.sol";

contract FactoryGasNoop {
    fallback() external {}
}

contract FactoryEngineJobsGasTest is RealMarketFixture {
    uint256 internal constant KEEPER_EXECUTION_BUDGET = 29_000_000;
    uint256 internal constant TRANSACTION_GAS_LIMIT = 30_000_000;

    function test_keeperJobsWith32AccountsAnd256ReserveHolders() public {
        BookRiskEngine engine = _gasMarket(256);
        bytes32 marketId = engine.listing().marketId;
        vm.warp(REAL_T);
        _measureKeeper(
            engine,
            "haltScheduled",
            address(resolutionOracle),
            abi.encodeCall(resolutionOracle.haltScheduled, (marketId))
        );
        _enterReview(engine, false);
        _propose(marketId, Outcome.YES);
        resolutionOracle.assertProposal(marketId);
        assertionVenue.setResult(resolutionOracle.getResolution(marketId).assertionId, true);
        vm.warp(block.timestamp + 300);
        _measureKeeper(
            engine,
            "finalizeMarket with test assertion venue",
            address(resolutionOracle),
            abi.encodeCall(resolutionOracle.finalizeMarket, (marketId))
        );
        _measureKeeper(
            engine,
            "prepareSnapshotChunk 32 accounts",
            address(engine),
            abi.encodeCall(engine.prepareSnapshotChunk, (32))
        );
        _measureKeeper(
            engine,
            "preparePayoutChunk scan 32 accounts",
            address(engine),
            abi.encodeCall(engine.preparePayoutChunk, (32))
        );
        _measureKeeper(
            engine,
            "preparePayoutChunk allocate 32 accounts",
            address(engine),
            abi.encodeCall(engine.preparePayoutChunk, (32))
        );
        _measureKeeper(
            engine,
            "finishPreparation 256 reserve holders",
            address(engine),
            abi.encodeCall(engine.finishPreparation, ())
        );
        assertEq(engine.participantCount(), 32);
        assertEq(engine.reserveVault().holderCount(), 256);
        assertTrue(engine.getSettlementStatus().claimsEnabled);
    }

    function test_captureInvalidFallbackGas() public {
        BookRiskEngine engine = _gasMarket(0);
        vm.warp(REAL_T + 1 hours);
        _measureKeeper(
            engine, "captureInvalidPrice fallback", address(engine), abi.encodeCall(engine.captureInvalidPrice, ())
        );
        assertTrue(engine.getSettlementStatus().invalidPriceReady);
    }

    function _gasMarket(uint256 reserveHolders) internal returns (BookRiskEngine engine) {
        MarketInput memory market = _input(keccak256("real-engine-keeper-gas"), false);
        market.oiCapLots = 1_600_000;
        vm.prank(gov);
        bondTreasury.setLimits(500e6, 20);
        IMarketConfig.Listing memory listing = _listing();
        vm.prank(lister);
        engine = BookRiskEngine(registry.createMarket(market, listing, ""));
        for (uint256 index; index < 30; ++index) {
            _fund(engine, address(uint160(0x10000 + index)));
        }
        for (uint256 index; index < reserveHolders; ++index) {
            address owner = address(uint160(0x20000 + index));
            token.mint(owner, 1e6);
            vm.startPrank(owner);
            token.approve(address(vault), 1e6);
            vault.deposit(1e6);
            vault.allocate(address(engine), 1e6, true);
            vm.stopPrank();
        }
        _trade(engine);
        for (uint256 index; index < 30; index += 2) {
            vm.prank(address(uint160(0x10000 + index)));
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 500, 100_000, 8, 0));
            vm.prank(address(uint160(0x10000 + index + 1)));
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 100_000, 8, 0));
        }
        assertEq(engine.oiAllLots(), market.oiCapLots);
    }

    function _measureKeeper(BookRiskEngine engine, string memory label, address target, bytes memory data) internal {
        vm.cool(address(registry));
        vm.cool(address(resolutionOracle));
        vm.cool(address(bondTreasury));
        vm.cool(address(assertionVenue));
        vm.cool(address(engine));
        vm.cool(address(engine.reserveVault()));
        vm.cool(address(vault));
        vm.cool(address(token));
        uint256 intrinsicGas = 21_000;
        for (uint256 index; index < data.length; ++index) {
            intrinsicGas += data[index] == 0 ? 4 : 16;
        }
        uint256 beforeGas = gasleft();
        (bool success, bytes memory result) = target.call{gas: KEEPER_EXECUTION_BUDGET}(data);
        uint256 usedGas = beforeGas - gasleft();
        emit log_named_uint(label, usedGas);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        assertLe(usedGas + intrinsicGas, TRANSACTION_GAS_LIMIT);
    }
}

contract FactoryGasTest is RegistryFixture {
    uint256 internal constant TRANSACTION_GAS_LIMIT = 30_000_000;
    // Leave 500k for intrinsic gas while accommodating the new constructor checks.
    uint256 internal constant REGISTRY_EXECUTION_BUDGET = 29_500_000;
    uint256 internal constant RUNTIME_BYTE_LIMIT = 131_072;
    uint256 internal constant INITCODE_BYTE_LIMIT = 262_144;

    MockUSDC internal token;
    MarketRegistry internal registry;
    ResolutionOracle internal resolution;
    BondTreasury internal treasury;
    MockAssertionVenue internal assertionVenue;
    MarketFactory internal factory;
    EngineCodeStore internal codeStore;
    EngineCodeStore internal codeStoreTail;
    FactoryGasNoop internal noop;
    address internal lister = makeAddr("real-factory-lister");
    uint256 internal codeStoreDeploymentGas;
    uint256 internal codeStoreTailDeploymentGas;
    uint256 internal factoryDeploymentGas;
    uint256 internal engineCreationBytes;
    uint256 internal codeStoreInitcodeBytes;
    uint256 internal codeStoreTailInitcodeBytes;
    uint256 internal factoryInitcodeBytes;
    uint256 internal measuredFrameGas;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(NOW);
        token = new MockUSDC();
        usdc = address(token);
        assertionVenue = new MockAssertionVenue(usdc, 2e6);
        uint256 nonce = vm.getNonce(address(this));
        address treasuryAddress = vm.computeCreateAddress(address(this), nonce);
        address oracleAddress = vm.computeCreateAddress(address(this), nonce + 1);
        address registryAddress = vm.computeCreateAddress(address(this), nonce + 2);
        treasury = new BondTreasury(usdc, oracleAddress, registryAddress, gov);
        resolution = new ResolutionOracle(
            registryAddress, treasuryAddress, usdc, 2183018362218727504, gov, makeAddr("real-factory-guardian")
        );
        registry = new MarketRegistry(oracleAddress, treasuryAddress, address(0), usdc, gov, lister);
        bytes memory engineCreation = vm.getCode("RegistryBookRiskEngine.sol:RegistryBookRiskEngine");
        engineCreationBytes = engineCreation.length;
        (bytes memory first, bytes memory second) = EngineCodeParts.split(engineCreation);
        codeStoreInitcodeBytes =
            vm.getCode("EngineCodeStore.sol:EngineCodeStore").length + abi.encode(first).length;
        codeStoreTailInitcodeBytes =
            vm.getCode("EngineCodeStore.sol:EngineCodeStore").length + abi.encode(second).length;
        uint256 beforeGas = gasleft();
        codeStore = new EngineCodeStore(first);
        codeStoreDeploymentGas = beforeGas - gasleft();
        beforeGas = gasleft();
        codeStoreTail = new EngineCodeStore(second);
        codeStoreTailDeploymentGas = beforeGas - gasleft();
        bytes32 creationHash = keccak256(engineCreation);
        factoryInitcodeBytes = vm.getCode("MarketFactory.sol:MarketFactory").length
            + abi.encode(address(registry), usdc, gov, address(codeStore), address(codeStoreTail), creationHash).length;
        beforeGas = gasleft();
        factory = new MarketFactory(address(registry), usdc, gov, address(codeStore), address(codeStoreTail), creationHash);
        factoryDeploymentGas = beforeGas - gasleft();
        noop = new FactoryGasNoop();
        _configureOracle();
        token.mint(address(this), 10_000e6);
        token.approve(address(treasury), type(uint256).max);
        treasury.deposit(Ledger.ASSERTION, 1_000e6);
    }

    function _configureOracle() internal {
        address[] memory committee = new address[](3);
        committee[0] = address(0x101);
        committee[1] = address(0x102);
        committee[2] = address(0x103);
        TrustSetInput memory trust;
        trust.forwarder = address(0x104);
        trust.runnerAttestor = address(0x105);
        trust.committee = committee;
        trust.threshold = 2;
        trust.watchdog = address(0x106);
        trust.venue = address(assertionVenue);
        vm.startPrank(gov);
        resolution.createTrustSet(trust);
        resolution.activateTrustSet(1);
        registry.setFactory(address(factory));
        registry.setGlobals(_globals());
        registry.setProvider(HOST, true);
        registry.setProvider(OTHER, true);
        treasury.setLimits(100e6, 20);
        vm.stopPrank();
    }

    function test_factoryAndCodeStoreDeploymentBounds() public {
        emit log_named_uint("code store deployment gas", codeStoreDeploymentGas);
        emit log_named_uint("code store tail deployment gas", codeStoreTailDeploymentGas);
        emit log_named_uint("factory and collateral vault deployment gas", factoryDeploymentGas);
        emit log_named_uint("code store runtime bytes", address(codeStore).code.length);
        emit log_named_uint("code store tail runtime bytes", address(codeStoreTail).code.length);
        emit log_named_uint("factory runtime bytes", address(factory).code.length);
        emit log_named_uint("collateral vault runtime bytes", address(factory.collateralVault()).code.length);
        emit log_named_uint("code store initcode bytes", codeStoreInitcodeBytes);
        emit log_named_uint("factory initcode bytes", factoryInitcodeBytes);
        assertLe(codeStoreDeploymentGas, TRANSACTION_GAS_LIMIT);
        assertLe(codeStoreTailDeploymentGas, TRANSACTION_GAS_LIMIT);
        assertLe(factoryDeploymentGas, TRANSACTION_GAS_LIMIT);
        assertLe(address(codeStore).code.length, RUNTIME_BYTE_LIMIT);
        assertLe(address(codeStoreTail).code.length, RUNTIME_BYTE_LIMIT);
        assertLe(address(factory).code.length, RUNTIME_BYTE_LIMIT);
        assertLe(address(factory.collateralVault()).code.length, RUNTIME_BYTE_LIMIT);
        assertLe(codeStoreInitcodeBytes, INITCODE_BYTE_LIMIT);
        assertLe(codeStoreTailInitcodeBytes, INITCODE_BYTE_LIMIT);
        assertLe(factoryInitcodeBytes, INITCODE_BYTE_LIMIT);
        assertEq(factory.collateralVault().governor(), address(factory));
    }

    function test_createMarketSmallTextWithinTransactionLimit() public {
        _measureListing(0, true, false);
    }

    function test_createLeveragedMarketWithinTransactionLimit() public {
        _measureListing(0, true, true);
    }

    function test_createMarketEightKiBClaimWithinTransactionLimit() public {
        _measureListing(8_192, true, false);
    }

    function test_createMarketOversizedListingRevertsAtomicallyAtExecutionBudget() public {
        _measureListing(16_384, false, false);
    }

    function _measureListing(uint256 targetClaimLength, bool shouldSucceed, bool leveraged) internal {
        MarketInput memory market = _market();
        market.tau = NOW + 25 hours;
        market.windowEnd = market.tau;
        market.voidSecs = 26 hours;
        if (targetClaimLength != 0) {
            uint256 fixedLength = ClaimRenderer.worstCaseLength(
                market.claimTemplate, bytes(market.question).length, 0, bytes(market.feed.urlTemplate).length
            );
            bytes memory rules = new bytes(targetClaimLength - fixedLength);
            for (uint256 index; index < rules.length; ++index) {
                rules[index] = bytes1("r");
            }
            market.rules = string(rules);
        }
        IMarketConfig.Listing memory listing = SeamFixture.pack(usdc, gov);
        if (leveraged) {
            listing.deploymentCapX = 5;
            listing.maxLiqLotsPerBlock = 100_000;
        }
        bytes memory data = abi.encodeCall(registry.createMarket, (market, listing, ""));
        uint256 intrinsicGas = 21_000;
        for (uint256 index; index < data.length; ++index) {
            intrinsicGas += data[index] == 0 ? 4 : 16;
        }
        address expectedEngine = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        uint256 engineInitcodeBytes = engineCreationBytes + abi.encode(factory.collateralVault(), gov, listing).length;
        assertLe(engineInitcodeBytes, INITCODE_BYTE_LIMIT);
        vm.cool(address(registry));
        vm.cool(address(resolution));
        vm.cool(address(treasury));
        vm.cool(address(assertionVenue));
        vm.cool(address(factory));
        vm.cool(address(factory.collateralVault()));
        vm.cool(address(codeStore));
        vm.cool(address(codeStoreTail));
        vm.cool(address(token));
        vm.prank(lister);
        uint256 beforeGas = gasleft();
        (bool success, bytes memory result) = address(registry).call{gas: REGISTRY_EXECUTION_BUDGET}(data);
        uint256 usedGas = beforeGas - gasleft();
        // Isolated Monad calls can report only caller overhead through gasleft().
        // Check the recorded callee frame as well; code-deposit gas must be present.
        measuredFrameGas = vm.lastFrameGas().gasTotalUsed;
        if (!shouldSucceed) {
            assertFalse(success);
            assertEq(bytes4(result), bytes4(keccak256("DeploymentFailed()")));
            assertFalse(registry.isListed(market.marketId));
            assertEq(factory.engineOf(market.marketId), address(0));
            assertEq(expectedEngine.code.length, 0);
            assertFalse(factory.collateralVault().engines(expectedEngine));
            assertEq(treasury.committedListing(market.marketId), 0);
            return;
        }
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        assertLe(usedGas + intrinsicGas, TRANSACTION_GAS_LIMIT);
        assertGt(measuredFrameGas, 20_000_000, "creation measurement must include engine code deposit");
        assertLe(measuredFrameGas + intrinsicGas, TRANSACTION_GAS_LIMIT);
        emit log_named_uint("registry frame gas", measuredFrameGas);
        emit log_named_uint("createMarket isolated call gas", usedGas);
        emit log_named_uint("standard calldata intrinsic gas", intrinsicGas);
        emit log_named_uint("call gas plus intrinsic allowance", usedGas + intrinsicGas);
        emit log_named_uint("forwarded call gas limit", REGISTRY_EXECUTION_BUDGET);
        emit log_named_uint("rules bytes", bytes(market.rules).length);
        emit log_named_uint("engine initcode bytes", engineInitcodeBytes);
        vm.prank(lister);
        beforeGas = gasleft();
        (bool noopSuccess,) = address(noop).call(data);
        uint256 noopGas = beforeGas - gasleft();
        assertTrue(noopSuccess);
        emit log_named_uint("same calldata isolated no-op call gas", noopGas);
        address engine = abi.decode(result, (address));
        emit log_named_uint("engine runtime bytes", engine.code.length);
        emit log_named_uint("reserve vault runtime bytes", address(BookRiskEngine(engine).reserveVault()).code.length);
        assertLe(engine.code.length, RUNTIME_BYTE_LIMIT);
        assertLe(address(BookRiskEngine(engine).reserveVault()).code.length, RUNTIME_BYTE_LIMIT);
        assertTrue(factory.collateralVault().engines(engine));
        assertEq(factory.engineOf(market.marketId), engine);
        assertEq(registry.getMarketCore(market.marketId).engine, engine);
        assertEq(BookRiskEngine(engine).reserveVault().engine(), engine);
        assertEq(BookRiskEngine(engine).scheduledT(), market.tau);
        IMarketConfig.Listing memory boundListing = BookRiskEngine(engine).listing();
        assertEq(boundListing.registry, address(registry));
        assertEq(boundListing.resolutionAuthority, address(resolution));
        assertEq(boundListing.token, usdc);
        assertEq(boundListing.listedAt, NOW);
        assertEq(BookRiskEngine(engine).listingHash(), keccak256(abi.encode(boundListing)));
    }
}
