pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {BookRiskEngine} from "../src/engine/BookRiskEngine.sol";
import {IMarketConfig} from "../src/interfaces/IMarketConfig.sol";
import {IResolutionEngine} from "../src/interfaces/IResolutionIngress.sol";
import {MarginMath} from "../src/math/MarginMath.sol";
import {CollateralVault} from "../src/vaults/CollateralVault.sol";
import {
    TestnetRiskCollateral,
    TestnetResolutionAuthority
} from "../test/mocks/integration/TestnetRiskFixtures.sol";

contract DeployTestnetRiskBook is Script {
    error TestnetDeploymentOnly();
    error InvalidTestnetDeployer();
    error InvalidListingTimestamp();

    event TestnetFixturePrepared(
        address indexed controller,
        address indexed engine,
        address collateral,
        address vault,
        address resolutionAuthority,
        bytes32 listingHash
    );

    function run()
        external
        returns (
            TestnetRiskCollateral collateral,
            CollateralVault vault,
            TestnetResolutionAuthority authority,
            BookRiskEngine engine
        )
    {
        if (block.chainid != 10143) revert TestnetDeploymentOnly();
        address deployer = vm.envAddress("TESTNET_DEPLOYER");
        if (deployer == address(0)) revert InvalidTestnetDeployer();
        if (block.timestamp > type(uint64).max - 10 days) revert InvalidListingTimestamp();
        uint64 listedAt = uint64(block.timestamp);
        vm.startBroadcast(deployer);
        collateral = new TestnetRiskCollateral(deployer);
        vault = new CollateralVault(address(collateral), deployer);
        authority = new TestnetResolutionAuthority(deployer);
        IMarketConfig.Listing memory configuration =
            _testListing(address(collateral), address(authority), deployer, listedAt);
        engine = new BookRiskEngine(vault, deployer, configuration);
        vault.registerEngine(address(engine));
        authority.bind(IResolutionEngine(address(engine)));
        vm.stopBroadcast();
        emit TestnetFixturePrepared(
            deployer,
            address(engine),
            address(collateral),
            address(vault),
            address(authority),
            engine.listingHash()
        );
    }

    function _testListing(address collateral, address authority, address controller, uint64 listedAt)
        internal
        view
        returns (IMarketConfig.Listing memory configuration)
    {
        configuration.marketId = keccak256(
            abi.encode("EROS_RISK_BOOK_TESTNET_FIXTURE_V1", block.chainid, collateral, controller, listedAt)
        );
        configuration.token = collateral;
        configuration.registry = controller;
        configuration.resolutionAuthority = authority;
        configuration.monitor = controller;
        configuration.governance = controller;
        configuration.scheduledT = listedAt + 10 days;
        configuration.listedAt = listedAt;
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
        configuration.maxLiqLotsPerBlock = 0;
        configuration.fundingEnabled = false;
    }
}
