pragma solidity ^0.8.30;

import {Book} from "@eros/Book.sol";
import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {RegistryBookRiskEngine} from "../../src/integration/RegistryBookRiskEngine.sol";
import {MarketFactory} from "@eros/factory/MarketFactory.sol";
import {EngineCodeStore} from "@eros/factory/EngineCodeStore.sol";
import {EngineCodeParts} from "@eros/factory/EngineCodeParts.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IBookRiskHooks} from "@eros/interfaces/IBookRiskHooks.sol";
import {IPriceSource} from "@eros/interfaces/IPriceSource.sol";
import {CollateralVault} from "@eros/vaults/CollateralVault.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {ListingFixture} from "@eros-test/risk/B/B019.t.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {
    Ledger,
    MarketInput,
    Outcome,
    Phase,
    PanelResult,
    ReviewedProposal,
    Resolution,
    RState,
    Sig,
    TrustSetInput
} from "../../src/types/OracleTypes.sol";
import {RegistryFixture} from "../unit/RegistryFixture.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";

abstract contract RealMarketFixture is RegistryFixture {
    uint64 internal constant REAL_T = NOW + 25 hours;
    uint64 internal constant SELECTOR = 2183018362218727504;
    uint256 internal constant INDEX_KEY = 0x516;
    uint256 internal constant ATTESTOR_KEY = 0x517;
    string internal constant EVIDENCE_URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    address internal lister = makeAddr("real-lister");
    address internal buyer = makeAddr("real-buyer");
    address internal seller = makeAddr("real-seller");
    address internal reserveTreasury = makeAddr("reserve-treasury");
    address internal monitor = address(0x30);
    MockUSDC internal token;
    MockAssertionVenue internal assertionVenue;
    MarketRegistry internal registry;
    ResolutionOracle internal resolutionOracle;
    BondTreasury internal bondTreasury;
    MarketFactory internal realFactory;
    CollateralVault internal vault;
    address internal engineCodeStore;
    address internal engineCodeStoreTail;
    address[] internal committee;
    uint256[] internal committeeKeys;

    function setUp() public virtual {
        vm.chainId(10143);
        vm.warp(NOW);
        token = new MockUSDC();
        usdc = address(token);
        assertionVenue = new MockAssertionVenue(usdc, 2e6);
        uint256 nonce = vm.getNonce(address(this));
        address treasuryAddress = vm.computeCreateAddress(address(this), nonce);
        address oracleAddress = vm.computeCreateAddress(address(this), nonce + 1);
        address registryAddress = vm.computeCreateAddress(address(this), nonce + 2);
        bondTreasury = new BondTreasury(usdc, oracleAddress, registryAddress, gov);
        resolutionOracle = new ResolutionOracle(registryAddress, treasuryAddress, usdc, SELECTOR, gov, gov);
        registry = new MarketRegistry(oracleAddress, treasuryAddress, address(0), usdc, gov, lister);
        bytes memory creationCode = vm.getCode("RegistryBookRiskEngine.sol:RegistryBookRiskEngine");
        (bytes memory firstCode, bytes memory secondCode) = EngineCodeParts.split(creationCode);
        engineCodeStore = address(new EngineCodeStore(firstCode));
        engineCodeStoreTail = address(new EngineCodeStore(secondCode));
        realFactory =
            new MarketFactory(address(registry), usdc, reserveTreasury, engineCodeStore, engineCodeStoreTail, keccak256(creationCode));
        vault = realFactory.collateralVault();
        for (uint256 member = 0; member < 3; ++member) {
            committeeKeys.push(0x1000 + member);
            committee.push(vm.addr(committeeKeys[member]));
        }
        for (uint256 first = 0; first < 3; ++first) {
            for (uint256 second = first + 1; second < 3; ++second) {
                if (committee[first] > committee[second]) {
                    (committee[first], committee[second]) = (committee[second], committee[first]);
                    (committeeKeys[first], committeeKeys[second]) = (committeeKeys[second], committeeKeys[first]);
                }
            }
        }
        TrustSetInput memory trust;
        trust.forwarder = makeAddr("real-test-forwarder");
        trust.runnerAttestor = vm.addr(ATTESTOR_KEY);
        trust.committee = committee;
        trust.threshold = 2;
        trust.watchdog = makeAddr("real-test-watchdog");
        trust.venue = address(assertionVenue);
        vm.startPrank(gov);
        resolutionOracle.createTrustSet(trust);
        resolutionOracle.activateTrustSet(1);
        registry.setGlobals(_globals());
        registry.setProvider(HOST, true);
        registry.setProvider(OTHER, true);
        registry.setFactory(address(realFactory));
        bondTreasury.setLimits(100e6, 20);
        vm.stopPrank();
        token.mint(address(this), 10_000e6);
        token.approve(address(bondTreasury), type(uint256).max);
        bondTreasury.deposit(Ledger.ASSERTION, 1_000e6);
        bondTreasury.deposit(Ledger.WATCHDOG_FLOAT, 100e6);
    }

    function _input(bytes32 marketId, bool hasFeed) internal view returns (MarketInput memory market) {
        market = hasFeed ? _market() : _noFeed();
        market.marketId = marketId;
        market.tau = REAL_T;
        market.windowEnd = REAL_T;
        market.voidSecs = 26 hours;
    }

    function _listing() internal view returns (IMarketConfig.Listing memory configuration) {
        configuration = ListingFixture.make(NOW, address(resolutionOracle), monitor, gov, vm.addr(INDEX_KEY));
        configuration.token = usdc;
        configuration.registry = address(registry);
        configuration.deploymentCapX = 1;
        configuration.maxLiqLotsPerBlock = 0;
        configuration.fundingEnabled = false;
    }

    function _listReal(bytes32 marketId, bool hasFeed) internal returns (BookRiskEngine engine) {
        MarketInput memory market = _input(marketId, hasFeed);
        IMarketConfig.Listing memory configuration = _listing();
        vm.prank(lister);
        engine = BookRiskEngine(registry.createMarket(market, configuration, ""));
    }

    function _fund(BookRiskEngine engine, address owner) internal {
        token.mint(owner, 100e6);
        vm.startPrank(owner);
        token.approve(address(vault), 100e6);
        vault.deposit(100e6);
        vault.allocate(address(engine), 100e6, false);
        vm.stopPrank();
    }

    function _observation(BookRiskEngine engine, uint64 sequence)
        internal
        view
        returns (IPriceSource.Observation memory observation)
    {
        IMarketConfig.Listing memory configuration = engine.listing();
        observation = IPriceSource.Observation({
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

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 recovery, bytes32 signatureR, bytes32 signatureS) = vm.sign(key, digest);
        return abi.encodePacked(signatureR, signatureS, recovery);
    }

    function _warmIndex(BookRiskEngine engine) internal {
        for (uint64 sequence = 1; sequence <= 31; ++sequence) {
            IPriceSource.Observation memory observation = _observation(engine, sequence);
            engine.submitObservation(observation, _sign(INDEX_KEY, engine.observationDigest(observation)));
            if (sequence != 31) vm.warp(block.timestamp + 10);
        }
    }

    function _trade(BookRiskEngine engine) internal {
        _fund(engine, buyer);
        _fund(engine, seller);
        vm.prank(gov);
        engine.activateMarket();
        _warmIndex(engine);
        vm.prank(seller);
        uint32 orderId = engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 500, 100_000, 8, 0));
        vm.prank(buyer);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 100_000, 8, 0));
        assertEq(engine.getOrder(orderId).size, 0);
        assertEq(engine.oiAllLots(), 100_000);
    }

    function _panel(bytes32 marketId, bool early, uint8 label) internal view returns (PanelResult memory panel) {
        Resolution memory resolution = resolutionOracle.getResolution(marketId);
        panel.marketId = marketId;
        panel.phase = uint8(early ? Phase.EARLY : Phase.POST_T);
        panel.attempt = resolution.attempts;
        panel.labels = [label, label, label];
        panel.calibratedBps = [uint16(9500), uint16(9500), uint16(9500)];
        panel.evidenceHash = keccak256("fixture-evidence");
        panel.evidenceURIHash = keccak256(bytes(EVIDENCE_URI));
        panel.gateHash = registry.getMarketCore(marketId).gateHash;
        panel.trustSetId = resolution.trustSetId == 0 ? resolutionOracle.activeTrustSetId() : resolution.trustSetId;
        panel.deadline = uint64(block.timestamp + 1 hours);
    }

    function _enterReview(BookRiskEngine engine, bool early) internal {
        bytes32 marketId = engine.listing().marketId;
        if (early) {
            vm.startPrank(monitor);
            engine.requestReduceOnly(keccak256("explicit-test-incident"));
            resolutionOracle.requestEarlyCheck(marketId);
            vm.stopPrank();
        } else {
            vm.warp(REAL_T);
            resolutionOracle.haltScheduled(marketId);
        }
        PanelResult memory panel = _panel(marketId, early, 1);
        resolutionOracle.submitPanelResult(
            marketId, panel, EVIDENCE_URI, _sign(ATTESTOR_KEY, resolutionOracle.hashPanelResult(panel))
        );
        assertEq(
            uint8(resolutionOracle.getResolution(marketId).state), uint8(early ? RState.EarlyReview : RState.Review)
        );
    }

    function _propose(bytes32 marketId, Outcome outcome) internal {
        Resolution memory resolution = resolutionOracle.getResolution(marketId);
        ReviewedProposal memory proposal;
        proposal.marketId = marketId;
        proposal.outcome = uint8(outcome);
        proposal.evidenceHash = keccak256("fixture-evidence");
        proposal.evidenceURIHash = keccak256(bytes(EVIDENCE_URI));
        proposal.noteHash = keccak256("fixture-note");
        proposal.attempt = resolution.attempts;
        proposal.rejectedMask = resolution.rejectedMask;
        proposal.early = resolution.state == RState.EarlyReview;
        proposal.trustSetId = proposal.early ? resolutionOracle.activeTrustSetId() : resolution.trustSetId;
        proposal.deadline = uint64(block.timestamp + 1 hours);
        Sig[] memory signatures = new Sig[](2);
        bytes32 digest = resolutionOracle.hashReviewedProposal(proposal);
        for (uint256 member = 0; member < 2; ++member) {
            signatures[member] = Sig(committee[member], _sign(committeeKeys[member], digest));
        }
        resolutionOracle.submitReviewedProposal(marketId, proposal, EVIDENCE_URI, signatures);
    }

    function _finalize(bytes32 marketId, bool truth) internal {
        resolutionOracle.assertProposal(marketId);
        assertionVenue.setResult(resolutionOracle.getResolution(marketId).assertionId, truth);
        vm.warp(block.timestamp + 300);
        resolutionOracle.finalizeMarket(marketId);
    }

    function _prepare(BookRiskEngine engine) internal {
        for (uint256 page = 0; page < 32; ++page) {
            if (engine.prepareSnapshotChunk(32).done) break;
        }
        for (uint256 page = 0; page < 64; ++page) {
            if (engine.preparePayoutChunk(32).done) break;
        }
        assertTrue(engine.finishPreparation());
        assertTrue(engine.getSettlementStatus().claimsEnabled);
    }
}
