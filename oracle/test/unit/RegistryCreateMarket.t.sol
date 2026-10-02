// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {Globals, MarketInput, MarketCore, FeedSpec, AIConfig, UMAConfig} from "../../src/types/OracleTypes.sol";
import {IMarketRegistry} from "../../src/interfaces/IMarketRegistry.sol";
import {IBondTreasury} from "../../src/interfaces/IBondTreasury.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {ResolutionEngineStub} from "../../src/testnet/ResolutionEngineStub.sol";
import {StubMarketFactory} from "../../src/testnet/StubMarketFactory.sol";
import {RegistryFixture} from "./RegistryFixture.sol";
import {MockOracleView} from "../mocks/MockOracleView.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";
import {MockBondTreasury} from "../mocks/MockBondTreasury.sol";
import {MockMarketFactory} from "../mocks/MockMarketFactory.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O11.4: `createMarket` steps 7-9 (plan §6.3) and every C.4 market view.
/// @dev Expected values from the plan: the bond at the cap for 100,000 lots is max(2, 11.12) USDC =
///      11,120,000 atoms (§12.5); the B.3 FeedSpec hashes to the C.7 specHash in `vectors/spechash.json`;
///      the overwritten listing fields are §6.3 step 8; `umaConfigHash` is ADJ-14.
contract RegistryCreateMarketTest is RegistryFixture {
    using stdJson for string;

    uint256 internal constant BOND_AT_CAP = 11_120_000; // §12.5: 100,000 lots at 1,112 bps

    address internal lister = makeAddr("lister");
    MockBondTreasury internal treasury;
    MockMarketFactory internal factory;
    MarketRegistry internal reg;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(NOW);
        oracle = new MockOracleView();
        venue = new MockAssertionVenue(usdc, 2e6);
        _activateVenue(1, address(venue));
        treasury = new MockBondTreasury();
        factory = new MockMarketFactory();
        reg = new MarketRegistry(address(oracle), address(treasury), address(factory), usdc, gov, lister);
        vm.startPrank(gov);
        reg.setGlobals(_globals());
        reg.setProvider(HOST, true);
        reg.setProvider(OTHER, true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ fixtures

    /// Engine fields from the listing pack. The seam fields the registry overwrites hold junk on purpose.
    function _pack() internal pure returns (IMarketConfig.Listing memory l) {
        l.marketId = keccak256("junk id");
        l.token = address(0x05DC);
        l.registry = address(0xBAD1);
        l.resolutionAuthority = address(0xBAD2);
        l.monitor = address(0xBAD3);
        l.governance = address(0x60);
        l.scheduledT = 1;
        l.listedAt = 2;
        l.sourceHash = keccak256("junk source");
        l.rulesHash = keccak256("junk rules");
        l.invalidRule = IMarketConfig.InvalidRule(false, 1, 2, 3);
        l.deploymentCapX = 1;
        l.maxTraders = 1024;
        l.indexSourceId = keccak256("index-source");
        l.indexSigner = address(0x51);
        l.indexRulesHash = keccak256("index-rules");
        l.depthNLots = 500;
        l.maxSpreadWad = 5e16;
        l.bootstrapBandWad = 5e16;
        l.minOrderLots = 1;
        l.maxOrderLots = 1e9;
    }

    function _list(MarketInput memory m) internal returns (address engine) {
        vm.prank(lister);
        return reg.createMarket(m, _pack(), abi.encode(uint256(42)));
    }

    function _expectListRevert(MarketInput memory m, bytes memory err) internal {
        IMarketConfig.Listing memory l = _pack();
        vm.prank(lister);
        vm.expectRevert(err);
        reg.createMarket(m, l, abi.encode(uint256(42)));
    }

    /// The Appendix B.3 FeedSpec (C.7 vector 0), with globals that admit its 900 s buffer and 6 h timeout.
    function _b3Market() internal returns (MarketInput memory m, bytes32 specHash) {
        string memory j = vm.readFile("vectors/spechash.json");
        FeedSpec memory f;
        f.urlTemplate = j.readString(".vectors[0].spec.urlTemplate");
        f.urlParam = j.readString(".vectors[0].spec.urlParam");
        f.authRef = j.readBytes32(".vectors[0].spec.authRef");
        f.finalPath = j.readString(".vectors[0].spec.finalPath");
        f.finalValue = j.readString(".vectors[0].spec.finalValue");
        f.valuePath = j.readString(".vectors[0].spec.valuePath");
        f.valueType = uint8(j.readUint(".vectors[0].spec.valueType"));
        f.decimals = uint8(j.readUint(".vectors[0].spec.decimals"));
        f.op = uint8(j.readUint(".vectors[0].spec.op"));
        f.target = j.readString(".vectors[0].spec.target");
        f.bufferSecs = uint32(j.readUint(".vectors[0].spec.bufferSecs"));
        f.l1TimeoutSecs = uint32(j.readUint(".vectors[0].spec.l1TimeoutSecs"));
        specHash = j.readBytes32(".vectors[0].specHash");
        Globals memory g = _globals();
        g.bufferMaxSecs = 21_600;
        g.l1TimeoutMinSecs = 3_600;
        g.l1TimeoutMaxSecs = 86_400;
        vm.prank(gov);
        reg.setGlobals(g);
        m = _market();
        m.feed = f;
        m.voidSecs = 30_000; // bound 21,600 + 600 + 3*(300 + 600) + 2*(600 + 300) + 600 = 27,300
    }

    // ------------------------------------------------------------------ full round trip

    /// A full listing round trip: seam fields, commitment and init, core, text and struct views, event.
    function test_roundTrip() public {
        uint256 snap = vm.snapshotState();
        {
            // test_roundTrip_listingSeamFields
            (MarketInput memory m, bytes32 specHash) = _b3Market();
            address engine = _list(m);
            assertEq(engine, factory.lastEngine());
            assertEq(factory.lastEngineInit(), abi.encode(uint256(42)), "engineInit passed through");

            IMarketConfig.Listing memory l = MockResolutionEngine(engine).listing();
            assertEq(l.marketId, m.marketId);
            assertEq(l.registry, address(reg));
            assertEq(l.resolutionAuthority, address(oracle));
            assertEq(l.monitor, m.monitor);
            assertEq(l.scheduledT, m.tau);
            assertEq(l.listedAt, NOW);
            assertEq(l.rulesHash, keccak256(bytes(m.rules)));
            assertEq(l.sourceHash, keccak256(abi.encode(specHash, keccak256(abi.encode(m.allowList)))));
            assertTrue(l.invalidRule.fallbackListed);
            assertEq(l.invalidRule.captureGraceSecs, 3_600);
            assertEq(l.invalidRule.fallbackPriceWad, 5e17);
            assertEq(l.invalidRule.voidSecs, m.voidSecs);
            // Every other field comes from the pack unchanged.
            IMarketConfig.Listing memory p = _pack();
            assertEq(l.token, p.token);
            assertEq(l.governance, p.governance);
            assertEq(l.indexSigner, p.indexSigner);
            assertEq(l.indexSourceId, p.indexSourceId);
            assertEq(l.maxTraders, p.maxTraders);
            assertEq(l.maxOrderLots, p.maxOrderLots);
            assertEq(MockResolutionEngine(engine).listingHash(), keccak256(abi.encode(l)));
        }
        vm.revertToState(snap);
        {
            // test_roundTrip_commitmentAndInit
            bytes32 id = _market().marketId;
            _list(_market());
            assertEq(treasury.committedListing(id), BOND_AT_CAP);
            assertEq(treasury.totalCommitted(), BOND_AT_CAP);
            assertTrue(oracle.initialized(id));
            assertEq(oracle.initCount(), 1);
            assertTrue(reg.isListed(id));
        }
        vm.revertToState(snap);
        {
            // test_roundTrip_marketCore
            (MarketInput memory m, bytes32 specHash) = _b3Market();
            address engine = _list(m);
            MarketCore memory c = reg.getMarketCore(m.marketId);
            assertEq(c.engine, engine);
            assertTrue(c.questionPtr != address(0) && c.rulesPtr != address(0));
            assertEq(c.listedAt, NOW);
            assertEq(c.windowStart, m.windowStart);
            assertEq(c.windowEnd, m.windowEnd);
            assertEq(c.tau, m.tau);
            assertEq(c.groupId, 0);
            assertFalse(c.groupExclusive);
            assertTrue(c.hasFeed);
            assertEq(c.l2DeadlineSecs, m.l2DeadlineSecs);
            assertEq(c.voidSecs, m.voidSecs);
            assertEq(c.retryWindowSecs, 300, "copied from globals");
            assertEq(c.earlyTtlSecs, 600, "copied from globals");
            assertEq(c.monitor, m.monitor);
            assertEq(c.oiCapLots, m.oiCapLots);
            assertEq(c.rulesHash, keccak256(bytes(m.rules)));
            assertEq(c.specHash, specHash, "C.7 vector");
            assertEq(reg.getSpecHash(m.marketId), specHash);
            assertEq(
                c.gateHash,
                keccak256(abi.encode(m.ai.modelIdHashes, m.ai.promptHash, m.ai.calibratorHash, m.ai.highConfBps))
            );
        }
        vm.revertToState(snap);
        {
            // test_roundTrip_textAndStructViews
            MarketInput memory m = _market();
            m.ai.allowListPtr = address(0xDEAD); // ignored on input
            m.uma.claimTemplatePtr = address(0xBEEF); // ignored on input
            _list(m);
            bytes32 id = m.marketId;
            assertEq(reg.getQuestion(id), m.question);
            assertEq(reg.getRules(id), m.rules);
            assertEq(reg.getClaimTemplate(id), m.claimTemplate);
            assertEq(keccak256(abi.encode(reg.getAllowList(id))), keccak256(abi.encode(m.allowList)));
            assertEq(keccak256(abi.encode(reg.getFeedSpec(id))), keccak256(abi.encode(m.feed)));

            AIConfig memory ai = reg.getAIConfig(id);
            assertTrue(ai.allowListPtr != address(0) && ai.allowListPtr != address(0xDEAD));
            ai.allowListPtr = m.ai.allowListPtr;
            assertEq(keccak256(abi.encode(ai)), keccak256(abi.encode(m.ai)), "every other AI field as given");

            UMAConfig memory u = reg.getUMAConfig(id);
            assertTrue(u.claimTemplatePtr != address(0) && u.claimTemplatePtr != address(0xBEEF));
            u.claimTemplatePtr = m.uma.claimTemplatePtr;
            assertEq(keccak256(abi.encode(u)), keccak256(abi.encode(m.uma)), "every other UMA field as given");
        }
        vm.revertToState(snap);
        {
            // test_roundTrip_event
            MarketInput memory m = _market();
            m.dryRunHash = keccak256("reference.json");
            m.ambiguityLogHash = keccak256("ambiguity.log");
            bytes32 id = m.marketId;
            // List once to learn the stored values, roll back, then expect the event on the same listing.
            uint256 snap = vm.snapshotState();
            address engine = _list(m);
            MarketCore memory c = reg.getMarketCore(id);
            bytes32 umaConfigHash = keccak256(abi.encode(reg.getUMAConfig(id)));
            vm.revertToState(snap);
            _expectListed(m, engine, c, umaConfigHash);
            assertEq(_list(m), engine, "the same deterministic deployment");
        }
    }

    function test_noFeedMarketStoresHashOfZeroSpec() public {
        MarketInput memory m = _noFeed();
        _list(m);
        FeedSpec memory zero;
        assertEq(reg.getSpecHash(m.marketId), keccak256(abi.encode(zero)));
        assertTrue(reg.getSpecHash(m.marketId) != 0);
        assertEq(keccak256(abi.encode(reg.getFeedSpec(m.marketId))), keccak256(abi.encode(zero)));
        assertFalse(reg.getMarketCore(m.marketId).hasFeed);
    }

    function test_unlistedIdReadsEmpty() public view {
        bytes32 id = keccak256("never listed");
        assertFalse(reg.isListed(id));
        assertEq(reg.getMarketCore(id).engine, address(0));
        assertEq(reg.getSpecHash(id), 0);
        assertEq(reg.getAllowList(id).length, 0);
        assertEq(reg.getQuestion(id), "");
        assertEq(reg.getRules(id), "");
        assertEq(reg.getClaimTemplate(id), "");
        assertEq(bytes(reg.getFeedSpec(id).urlTemplate).length, 0);
        assertEq(reg.getAIConfig(id).highConfBps, 0);
        assertEq(reg.getUMAConfig(id).minBond, 0);
    }

    // ------------------------------------------------------------------ steps 7 and 8 failures

    /// Steps 7-9 refusals: non-lister, no factory, treasury below the cap, listing-hash mismatch, pre-halted engine.
    function test_listingRefusals() public {
        uint256 snap = vm.snapshotState();
        {
            // test_nonListerRefused
            address[3] memory callers = [gov, address(oracle), makeAddr("stranger")];
            for (uint256 i; i < callers.length; ++i) {
                IMarketConfig.Listing memory l = _pack();
                MarketInput memory m = _market();
                vm.prank(callers[i]);
                vm.expectRevert(IMarketRegistry.Unauthorized.selector);
                reg.createMarket(m, l, "");
            }
        }
        vm.revertToState(snap);
        {
            // test_noFactory
            vm.prank(gov);
            reg.setFactory(address(0));
            _expectListRevert(_market(), abi.encodeWithSelector(IMarketRegistry.NoFactory.selector));
        }
        vm.revertToState(snap);
        {
            // test_treasuryBelowCap
            treasury.setAvailable(BOND_AT_CAP - 1);
            _expectListRevert(
                _market(), abi.encodeWithSelector(IBondTreasury.BelowCommitments.selector, BOND_AT_CAP, BOND_AT_CAP - 1)
            );
            treasury.setAvailable(BOND_AT_CAP);
            _list(_market());
        }
        vm.revertToState(snap);
        {
            // test_listingHashMismatch
            factory.setMode(MockMarketFactory.Mode.WRONG_HASH);
            _expectListRevert(_market(), abi.encodeWithSelector(IMarketRegistry.ListingHashMismatch.selector));
        }
        vm.revertToState(snap);
        {
            // test_engineAlreadyHalted
            factory.setMode(MockMarketFactory.Mode.PRE_HALTED);
            _expectListRevert(_market(), abi.encodeWithSelector(IMarketRegistry.EngineAlreadyHalted.selector));
        }
    }

    function test_failedListingLeavesNothingBehind() public {
        factory.setMode(MockMarketFactory.Mode.REVERT);
        _expectListRevert(_market(), abi.encodeWithSelector(MockMarketFactory.MockFactoryReverted.selector));
        bytes32 id = _market().marketId;
        assertFalse(reg.isListed(id));
        assertEq(treasury.committedListing(id), 0);
        assertFalse(oracle.initialized(id));
    }

    function test_duplicateAfterListing() public {
        _list(_market());
        _expectListRevert(_market(), abi.encodeWithSelector(IMarketRegistry.DuplicateMarket.selector));
    }

    function test_rulesStillApply() public {
        MarketInput memory m = _market();
        m.uma.bondBps = 1_111;
        _expectListRevert(m, abi.encodeWithSelector(IMarketRegistry.BadUMAConfig.selector, uint8(3)));
    }

    // ------------------------------------------------------------------ setFactory affects later listings only

    function test_setFactoryAffectsOnlyLaterListings() public {
        MarketInput memory a = _market();
        address engineA = _list(a);
        MockMarketFactory second = new MockMarketFactory();
        vm.prank(gov);
        reg.setFactory(address(second));
        MarketInput memory b = _market();
        b.marketId = keccak256("market-2");
        address engineB = _list(b);
        assertEq(second.lastEngine(), engineB);
        assertEq(factory.lastEngine(), engineA, "the old factory deployed nothing new");
        assertEq(reg.getMarketCore(a.marketId).engine, engineA, "a listed market keeps its engine");
    }

    // ------------------------------------------------------------------ the real testnet stub factory

    function test_listsThroughStubMarketFactory() public {
        StubMarketFactory stub = new StubMarketFactory(address(reg));
        vm.prank(gov);
        reg.setFactory(address(stub));
        MarketInput memory m = _market();
        address engine = _list(m);
        assertEq(stub.engineOf(m.marketId), engine);
        ResolutionEngineStub e = ResolutionEngineStub(engine);
        assertEq(e.listing().resolutionAuthority, address(oracle));
        assertFalse(e.getHaltSnapshot().halted);
        vm.warp(m.tau);
        vm.prank(address(oracle));
        assertEq(e.halt().oiHaltLots, 42, "engineInit reached the stub");
    }

    function _expectListed(MarketInput memory m, address engine, MarketCore memory c, bytes32 umaConfigHash) internal {
        vm.expectEmit(address(reg));
        emit IMarketRegistry.MarketListed(
            m.marketId,
            engine,
            m.tau,
            m.hasFeed,
            m.groupId,
            c.rulesHash,
            c.specHash,
            c.gateHash,
            umaConfigHash,
            m.dryRunHash,
            m.ambiguityLogHash
        );
    }
}
