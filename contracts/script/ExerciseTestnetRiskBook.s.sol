pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {Book} from "../src/Book.sol";
import {BookRiskEngine} from "../src/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../src/interfaces/IMarketConfig.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {PriceIngress} from "../src/pricing/PriceIngress.sol";
import {CollateralVault} from "../src/vaults/CollateralVault.sol";
import {
    TestnetRiskCollateral,
    TestnetResolutionAuthority
} from "../test/mocks/integration/TestnetRiskFixtures.sol";

contract TestnetRiskTrader {
    address public immutable controller;
    BookRiskEngine public immutable engine;
    bool public funded;

    error TraderUnauthorized();
    error TraderAlreadyFunded();
    error ApprovalFailed();

    constructor(BookRiskEngine engine_) {
        controller = msg.sender;
        engine = engine_;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert TraderUnauthorized();
        _;
    }

    function fund() external onlyController {
        if (funded) revert TraderAlreadyFunded();
        funded = true;
        CollateralVault vault = engine.collateralVault();
        if (!vault.token().approve(address(vault), 100e6)) revert ApprovalFailed();
        vault.deposit(100e6);
        vault.allocate(address(engine), 100e6, false);
    }

    function place(bool isBuy) external onlyController returns (uint32) {
        return engine.placeOrder(
            Book.Place(
                isBuy ? IBookRiskHooks.OrderKind.IOC : IBookRiskHooks.OrderKind.LIMIT,
                isBuy,
                false,
                500,
                100_000,
                1,
                0
            )
        );
    }
}

contract TestnetRiskSmoke {
    address public immutable controller;
    BookRiskEngine public immutable engine;
    TestnetRiskCollateral public immutable collateral;
    TestnetResolutionAuthority public immutable authority;
    TestnetRiskTrader public immutable buyer;
    TestnetRiskTrader public immutable seller;
    bool public funded;
    bool public traded;
    bool public completed;

    error TestnetSmokeOnly();
    error SmokeUnauthorized();
    error NotControlledFixture();
    error UnexpectedSmokeState();
    error InvalidWindow();
    error UnusableIndex();
    error TradeMismatch();
    error SettlementMismatch();

    event FixtureActorsPrepared(address indexed engine, address buyer, address seller);
    event SyntheticIndexWindowRelayed(uint64 firstSequence, uint64 lastSequence, uint64 observedAt);
    event RealBookFixtureTrade(uint32 indexed makerOrder, uint256 lots, uint256 tick);
    event FixtureCashSettlement(address buyer, uint256 buyerAtoms, address seller, uint256 sellerAtoms);

    constructor(BookRiskEngine engine_, address controller_) {
        if (block.chainid != 10143) revert TestnetSmokeOnly();
        if (controller_ == address(0)) revert NotControlledFixture();
        IMarketConfig.Listing memory configuration = engine_.listing();
        CollateralVault vault = engine_.collateralVault();
        TestnetRiskCollateral token = TestnetRiskCollateral(configuration.token);
        TestnetResolutionAuthority oracle = TestnetResolutionAuthority(configuration.resolutionAuthority);
        if (
            configuration.governance != controller_ || configuration.registry != controller_
                || configuration.monitor != controller_ || configuration.indexSigner != controller_
                || token.controller() != controller_ || oracle.controller() != controller_
                || address(oracle.engine()) != address(engine_) || vault.governor() != controller_
                || address(vault.token()) != address(token) || !vault.engines(address(engine_))
                || engine_.treasury() != controller_ || token.decimals() != 6
                || keccak256(bytes(token.name())) != keccak256("Risk Book Testnet Fixture Collateral")
                || keccak256(bytes(token.symbol())) != keccak256("RISK-TEST")
                || configuration.sourceHash
                    != keccak256("TESTNET_ONLY_CONTROLLER_SIGNED_INDEX_NOT_LIVE_SOURCE")
                || configuration.rulesHash
                    != keccak256("TESTNET_ONLY_CONTROLLER_FINALITY_NOT_PRODUCTION_ORACLE")
                || configuration.indexSourceId != keccak256("TESTNET_ONLY_SIGNED_INDEX")
                || configuration.indexRulesHash != keccak256("TESTNET_ONLY_INDEX_DEPTH_500_SPREAD_0_05")
                || configuration.deploymentCapX != 1 || configuration.fundingEnabled
                || engine_.fundingFeatureEnabled() || engine_.recoveryEnabled()
                || engine_.participantCount() != 0 || engine_.active() || engine_.halted()
        ) revert NotControlledFixture();
        controller = controller_;
        engine = engine_;
        collateral = token;
        authority = oracle;
        buyer = new TestnetRiskTrader(engine_);
        seller = new TestnetRiskTrader(engine_);
        emit FixtureActorsPrepared(address(engine_), address(buyer), address(seller));
    }

    modifier onlyController() {
        if (block.chainid != 10143) revert TestnetSmokeOnly();
        if (msg.sender != controller) revert SmokeUnauthorized();
        _;
    }

    function fund() external onlyController {
        if (funded || engine.active() || engine.participantCount() != 0) revert UnexpectedSmokeState();
        buyer.fund();
        seller.fund();
        if (engine.allocationQ() != 200e24 || engine.participantCount() != 2) {
            revert UnexpectedSmokeState();
        }
        funded = true;
    }

    function relayWindow(IPriceSource.Observation[] calldata observations, bytes[] calldata signatures)
        external
        onlyController
    {
        if (traded || engine.halted()) revert UnexpectedSmokeState();
        _relayWindow(observations, signatures);
    }

    function executeTrade(IPriceSource.Observation[] calldata observations, bytes[] calldata signatures)
        external
        onlyController
    {
        if (!funded || traded || !engine.active() || engine.participantCount() != 2) {
            revert UnexpectedSmokeState();
        }
        _relayWindow(observations, signatures);
        if (!engine.riskContext().indexOk || engine.riskContext().markOk) revert UnusableIndex();
        uint32 makerOrder = seller.place(false);
        buyer.place(true);
        if (
            makerOrder == 0 || engine.getOrder(makerOrder).size != 0 || engine.oiAllLots() != 100_000
                || engine.account(address(buyer)).value.lots != 100_000
                || engine.account(address(seller)).value.lots != -100_000
                || engine.account(address(buyer)).value.cashQ != 50e24
                || engine.account(address(seller)).value.cashQ != 150e24 || engine.protocolFeeQ() != 0
        ) revert TradeMismatch();
        traded = true;
        emit RealBookFixtureTrade(makerOrder, 100_000, 500);
    }

    function completeSettlement() external onlyController {
        if (!traded || completed || !engine.halted() || engine.participantCount() != 2) {
            revert UnexpectedSmokeState();
        }
        engine.prepareSnapshotChunk(1);
        if (!engine.prepareSnapshotChunk(1).done) revert SettlementMismatch();
        for (uint256 page; page < 3; ++page) {
            engine.preparePayoutChunk(1);
        }
        if (!engine.preparePayoutChunk(1).done || !engine.finishPreparation()) {
            revert SettlementMismatch();
        }
        if (engine.traderAtoms(address(buyer)) != 150e6 || engine.traderAtoms(address(seller)) != 50e6) {
            revert SettlementMismatch();
        }
        if (!engine.traderClaimed(address(buyer))) engine.claimTrader(address(buyer));
        if (!engine.traderClaimed(address(seller))) engine.claimTrader(address(seller));
        if (
            collateral.balanceOf(address(buyer)) != 150e6 || collateral.balanceOf(address(seller)) != 50e6
                || !engine.allTraderClaimsPaid() || engine.collateralVault().recognizedAtoms() != 0
                || collateral.balanceOf(address(engine.collateralVault())) != 0
        ) revert SettlementMismatch();
        completed = true;
        emit FixtureCashSettlement(address(buyer), 150e6, address(seller), 50e6);
    }

    function _relayWindow(IPriceSource.Observation[] calldata observations, bytes[] calldata signatures)
        internal
    {
        if (observations.length == 0 || observations.length > 31 || observations.length != signatures.length)
        {
            revert InvalidWindow();
        }
        for (uint256 index; index < observations.length; ++index) {
            if (
                observations[index].priceWad != 5e17 || observations[index].impactBidWad != 49e16
                    || observations[index].impactAskWad != 51e16
            ) revert InvalidWindow();
            engine.submitObservation(observations[index], signatures[index]);
        }
        emit SyntheticIndexWindowRelayed(
            observations[0].sequence,
            observations[observations.length - 1].sequence,
            observations[observations.length - 1].observedAt
        );
    }
}

contract ExerciseTestnetRiskBook is Script {
    error InvalidSmokeController();
    error InvalidWindowClock();

    event SmokePrepared(address indexed smoke, address indexed engine, address buyer, address seller);

    function setup(address engineAddress) external returns (TestnetRiskSmoke smoke) {
        address deployer = _deployer();
        BookRiskEngine engine = BookRiskEngine(engineAddress);
        vm.startBroadcast(deployer);
        smoke = new TestnetRiskSmoke(engine, deployer);
        smoke.collateral().mint(address(smoke.buyer()), 100e6);
        smoke.collateral().mint(address(smoke.seller()), 100e6);
        smoke.fund();
        engine.activateMarket();
        vm.stopBroadcast();
        emit SmokePrepared(address(smoke), engineAddress, address(smoke.buyer()), address(smoke.seller()));
    }

    function feed(address smokeAddress) external {
        TestnetRiskSmoke smoke = _smoke(smokeAddress);
        (IPriceSource.Observation[] memory observations, bytes[] memory signatures) = _window(smoke.engine());
        vm.startBroadcast(smoke.controller());
        smoke.relayWindow(observations, signatures);
        vm.stopBroadcast();
    }

    function trade(address smokeAddress) external {
        TestnetRiskSmoke smoke = _smoke(smokeAddress);
        (IPriceSource.Observation[] memory observations, bytes[] memory signatures) = _window(smoke.engine());
        vm.startBroadcast(smoke.controller());
        smoke.executeTrade(observations, signatures);
        vm.stopBroadcast();
    }

    function settle(address smokeAddress) external {
        TestnetRiskSmoke smoke = _smoke(smokeAddress);
        if (!smoke.traded() || smoke.completed()) revert TestnetRiskSmoke.UnexpectedSmokeState();
        vm.startBroadcast(smoke.controller());
        smoke.authority().halt();
        smoke.authority().finalize(1);
        smoke.completeSettlement();
        vm.stopBroadcast();
    }

    function _deployer() internal view returns (address deployer) {
        if (block.chainid != 10143) revert TestnetRiskSmoke.TestnetSmokeOnly();
        deployer = vm.envAddress("TESTNET_DEPLOYER");
        if (deployer == address(0)) revert InvalidSmokeController();
    }

    function _smoke(address smokeAddress) internal view returns (TestnetRiskSmoke smoke) {
        smoke = TestnetRiskSmoke(smokeAddress);
        if (smoke.controller() != _deployer()) revert InvalidSmokeController();
    }

    function _window(BookRiskEngine engine)
        internal
        view
        returns (IPriceSource.Observation[] memory observations, bytes[] memory signatures)
    {
        if (block.timestamp < 300 || block.timestamp > type(uint64).max) revert InvalidWindowClock();
        IMarketConfig.Listing memory configuration = engine.listing();
        PriceIngress.SourceState memory source = engine.sourceState(configuration.indexSourceId);
        uint64 latestAt = uint64(block.timestamp);
        uint64 firstAt = latestAt - 300;
        if (source.lastObservedAt > firstAt) firstAt = source.lastObservedAt;
        if (firstAt > latestAt) revert InvalidWindowClock();
        uint256 count = (uint256(latestAt - firstAt) + 9) / 10 + 1;
        observations = new IPriceSource.Observation[](count);
        signatures = new bytes[](count);
        for (uint256 index; index < count; ++index) {
            uint64 observedAt = firstAt + uint64(index * 10);
            if (observedAt > latestAt) observedAt = latestAt;
            observations[index] = IPriceSource.Observation({
                marketId: configuration.marketId,
                sourceId: configuration.indexSourceId,
                sequence: source.lastSequence + uint64(index) + 1,
                observedAt: observedAt,
                publishedAt: latestAt,
                priceWad: 5e17,
                impactBidWad: 49e16,
                impactAskWad: 51e16,
                bidDepthLots: configuration.depthNLots,
                askDepthLots: configuration.depthNLots,
                sourceRulesHash: configuration.indexRulesHash
            });
            signatures[index] = _signObservation(engine, observations[index], configuration.indexSigner);
        }
    }

    function _signObservation(
        BookRiskEngine engine,
        IPriceSource.Observation memory observation,
        address signer
    ) internal view returns (bytes memory) {
        (uint8 recovery, bytes32 signatureR, bytes32 signatureS) =
            vm.sign(signer, engine.observationDigest(observation));
        return abi.encodePacked(signatureR, signatureS, recovery);
    }
}
