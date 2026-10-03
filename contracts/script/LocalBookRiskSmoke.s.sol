pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Book} from "../src/Book.sol";
import {BookRiskEngine} from "../src/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../src/interfaces/IMarketConfig.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {MarginMath} from "../src/math/MarginMath.sol";
import {CollateralVault} from "../src/vaults/CollateralVault.sol";
import {MockUSDC} from "../test/mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../test/mocks/B/MockResolutionAuthority.sol";

contract LocalSmokeTrader {
    address public immutable controller = msg.sender;

    function fund(MockUSDC token, CollateralVault vault, BookRiskEngine engine) external {
        require(msg.sender == controller, "controller only");
        token.approve(address(vault), 100e6);
        vault.deposit(100e6);
        vault.allocate(address(engine), 100e6, false);
    }

    function place(BookRiskEngine engine, bool isBuy, IBookRiskHooks.OrderKind kind)
        external
        returns (uint32)
    {
        require(msg.sender == controller, "controller only");
        return engine.placeOrder(Book.Place(kind, isBuy, false, 500, 100_000, 64, 0));
    }
}

contract LocalBookRiskSmoke is Script {
    uint256 constant LOCAL_INDEX_KEY = 0xA11CE;

    function run() external {
        require(block.chainid == 31337, "local chain only: mock collateral and oracle");
        address deployer = vm.envAddress("LOCAL_SMOKE_SENDER");
        vm.startBroadcast(deployer);
        MockUSDC token = new MockUSDC();
        CollateralVault vault = new CollateralVault(address(token), deployer);
        MockResolutionAuthority oracle = new MockResolutionAuthority();
        IMarketConfig.Listing memory configuration = _configuration(token, oracle, deployer);
        BookRiskEngine engine = new BookRiskEngine(vault, deployer, configuration);
        vault.registerEngine(address(engine));
        oracle.bind(engine);
        LocalSmokeTrader buyer = new LocalSmokeTrader();
        LocalSmokeTrader seller = new LocalSmokeTrader();
        token.mint(address(buyer), 100e6);
        token.mint(address(seller), 100e6);
        buyer.fund(token, vault, engine);
        seller.fund(token, vault, engine);
        engine.activateMarket();
        _submitIndex(engine, configuration);
        require(engine.riskContext().indexOk, "index window unavailable");
        require(!engine.riskContext().markOk, "unexpected normal mark");
        uint32 askId = seller.place(engine, false, IBookRiskHooks.OrderKind.LIMIT);
        require(askId != 0, "ask not admitted");
        buyer.place(engine, true, IBookRiskHooks.OrderKind.IOC);
        require(engine.getOrder(askId).size == 0, "trade incomplete");
        require(engine.oiAllLots() == 100_000, "wrong open interest");
        oracle.haltEarly();
        require(oracle.finalize(1), "finality not accepted");
        require(!engine.claimsEnabled(), "premature claims");
        require(engine.prepareSnapshotChunk(32).done, "snapshot incomplete");
        require(engine.preparePayoutChunk(32).done, "payout incomplete");
        require(engine.finishPreparation(), "claims not ready");
        require(engine.claimTrader(address(buyer)) == 150e6, "buyer payout");
        require(engine.claimTrader(address(seller)) == 50e6, "seller payout");
        require(engine.allTraderClaimsPaid(), "unpaid claims");
        require(vault.recognizedAtoms() == 0, "recognized custody remains");
        require(token.balanceOf(address(vault)) == 0, "token custody remains");
        require(token.balanceOf(address(buyer)) == 150e6, "buyer token balance");
        require(token.balanceOf(address(seller)) == 50e6, "seller token balance");
        vm.stopBroadcast();
        console2.log("Engine", address(engine));
        console2.log("Vault", address(vault));
        console2.log("Local mock collateral", address(token));
        console2.log("Local mock oracle", address(oracle));
        console2.log("Buyer", address(buyer));
        console2.log("Seller", address(seller));
        console2.log("Runtime bytes", address(engine).code.length);
    }

    function _configuration(MockUSDC token, MockResolutionAuthority oracle, address deployer)
        internal
        view
        returns (IMarketConfig.Listing memory configuration)
    {
        configuration.marketId = keccak256("LOCAL MONAD RISK BOOK SMOKE");
        configuration.token = address(token);
        configuration.registry = deployer;
        configuration.resolutionAuthority = address(oracle);
        configuration.monitor = deployer;
        configuration.governance = deployer;
        configuration.scheduledT = uint64(block.timestamp + 10 days);
        configuration.listedAt = uint64(block.timestamp);
        configuration.sourceHash = keccak256("LOCAL MOCK RESOLUTION SOURCE");
        configuration.rulesHash = keccak256("LOCAL YES NO INVALID RULES");
        configuration.invalidRule = IMarketConfig.InvalidRule(true, 3600, 5e17, 30 days);
        configuration.template = MarginMath.Template.SCHEDULED;
        configuration.deploymentCapX = 1;
        configuration.maxTraders = 1024;
        configuration.indexSourceId = keccak256("LOCAL SIGNED INDEX FIXTURE");
        configuration.indexSigner = vm.addr(LOCAL_INDEX_KEY);
        configuration.indexRulesHash = keccak256("LOCAL DEPTH 500 SPREAD 0.05");
        configuration.depthNLots = 500;
        configuration.maxSpreadWad = 5e16;
        configuration.bootstrapBandWad = 5e16;
        configuration.minOrderLots = 1;
        configuration.maxOrderLots = 1_000_000;
    }

    function _submitIndex(BookRiskEngine engine, IMarketConfig.Listing memory configuration) internal {
        uint64 start = uint64(block.timestamp - 300);
        for (uint64 sequence = 1; sequence <= 31; ++sequence) {
            uint64 observedAt = start + (sequence - 1) * 10;
            IPriceSource.Observation memory observation = IPriceSource.Observation({
                marketId: configuration.marketId,
                sourceId: configuration.indexSourceId,
                sequence: sequence,
                observedAt: observedAt,
                publishedAt: uint64(block.timestamp),
                priceWad: 5e17,
                impactBidWad: 49e16,
                impactAskWad: 51e16,
                bidDepthLots: 500,
                askDepthLots: 500,
                sourceRulesHash: configuration.indexRulesHash
            });
            (uint8 recovery, bytes32 signatureR, bytes32 signatureS) =
                vm.sign(LOCAL_INDEX_KEY, engine.observationDigest(observation));
            engine.submitObservation(observation, abi.encodePacked(signatureR, signatureS, recovery));
        }
    }
}
