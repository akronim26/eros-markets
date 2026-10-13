// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {HaltView} from "@eros/interfaces/IResolutionIngress.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {Resolution, TrustSet, RState} from "../../src/types/OracleTypes.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";
import {IBondTreasury} from "../../src/interfaces/IBondTreasury.sol";
import {ResolutionEngineStub} from "../../src/testnet/ResolutionEngineStub.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";
import {MockMarketFactory} from "../mocks/MockMarketFactory.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";
import {MockOracleView} from "../mocks/MockOracleView.sol";
import {MockBondTreasury} from "../mocks/MockBondTreasury.sol";

/// @notice Task O11.1: one smoke test per knob of every test double.
contract MocksTest is Test {
    uint64 internal constant L0 = 1_000_000;
    uint64 internal constant T = L0 + 10 days;
    address internal oracle = makeAddr("oracle");

    MockMarketFactory internal factory;

    function setUp() public {
        vm.warp(L0);
        factory = new MockMarketFactory();
    }

    // ------------------------------------------------------------------ MockResolutionEngine

    /// MockResolutionEngine knobs.
    function test_engine() public {
        uint256 snap = vm.snapshotState();
        {
            // test_engine_knobs
            MockResolutionEngine e = _engine("e1");
            e.setOiLots(42);
            e.setHaltTimeSkew(-60);
            vm.warp(T - 1 days);
            vm.prank(oracle);
            HaltView memory h = e.halt();
            assertEq(h.oiHaltLots, 42, "setOiLots");
            assertEq(h.economicHaltAt, T - 1 days - 60, "misbehaving halt time");

            e.setRevertOnSettle(true);
            vm.prank(oracle);
            vm.expectRevert(MockResolutionEngine.MockSettleReverted.selector);
            e.settle(1);
            e.setRevertOnSettle(false);
            vm.prank(oracle);
            assertTrue(e.settle(1));
            assertEq(e.settleCalls(), 1);
            vm.prank(oracle);
            vm.expectRevert(ResolutionEngineStub.ConflictingFinalOutcome.selector);
            e.settleInvalid();
        }
        vm.revertToState(snap);
        {
            // test_engine_listingHashOverrideAndForceHalted
            MockResolutionEngine e = _engine("e2");
            bytes32 real = e.listingHash();
            e.setListingHashOverride(keccak256("x"));
            assertEq(e.listingHash(), keccak256("x"));
            e.setListingHashOverride(bytes32(0));
            assertEq(e.listingHash(), real);
            e.forceHalted();
            assertTrue(e.getHaltSnapshot().halted);
        }
        vm.revertToState(snap);
        {
            // test_engine_keepsStubAuthority
            MockResolutionEngine e = _engine("e3");
            vm.expectRevert(ResolutionEngineStub.RiskUnauthorized.selector);
            e.settle(1);
        }
    }

    // ------------------------------------------------------------------ MockMarketFactory

    /// MockMarketFactory modes.
    function test_factory() public {
        uint256 snap = vm.snapshotState();
        {
            // test_factory_modes
            IMarketConfig.Listing memory l = _listing("f1");
            MockResolutionEngine e = MockResolutionEngine(factory.deployMarket(l, abi.encode(uint256(7))));
            assertEq(e.listingHash(), keccak256(abi.encode(l)), "NORMAL");
            assertEq(factory.lastEngine(), address(e));
            assertEq(keccak256(abi.encode(factory.lastListing())), keccak256(abi.encode(l)));

            factory.setMode(MockMarketFactory.Mode.WRONG_HASH);
            e = MockResolutionEngine(factory.deployMarket(_listing("f2"), abi.encode(uint256(7))));
            assertEq(e.listingHash(), keccak256("wrong listing hash"));

            factory.setMode(MockMarketFactory.Mode.PRE_HALTED);
            e = MockResolutionEngine(factory.deployMarket(_listing("f3"), abi.encode(uint256(7))));
            assertTrue(e.getHaltSnapshot().halted);

            factory.setMode(MockMarketFactory.Mode.REVERT);
            vm.expectRevert(MockMarketFactory.MockFactoryReverted.selector);
            factory.deployMarket(_listing("f4"), abi.encode(uint256(7)));
        }
        vm.revertToState(snap);
        {
            // test_factory_reusedMarketIdReverts
            factory.deployMarket(_listing("f5"), abi.encode(uint256(0)));
            vm.expectRevert(MockMarketFactory.MarketExists.selector);
            factory.deployMarket(_listing("f5"), abi.encode(uint256(0)));
        }
    }

    // ------------------------------------------------------------------ MockAssertionVenue

    /// MockAssertionVenue scripting.
    function test_venue() public {
        uint256 snap = vm.snapshotState();
        {
            // test_venue_scriptedTrueReturnsBond
            (MockUSDC usdc, MockAssertionVenue v, address treasury) = _venue();
            bytes32 id = _assert(v, treasury, 5e6);
            assertEq(usdc.balanceOf(treasury), 95e6, "bond pulled from the payer");
            assertFalse(v.trySettle(id), "unanswered by default");
            v.setResult(id, true);
            assertTrue(v.trySettle(id));
            IAssertionVenue.AssertionStatus memory s = v.statusOf(id);
            assertTrue(s.exists && s.settled && s.truthful);
            assertEq(usdc.balanceOf(treasury), 100e6, "bond back to the asserter");
            assertFalse(v.trySettle(id), "settles once");
            assertEq(v.marketOf(id), keccak256("m"));
            assertEq(s.expiresAt, block.timestamp + 7200);
        }
        vm.revertToState(snap);
        {
            // test_venue_scriptedFalseKeepsBond
            (MockUSDC usdc, MockAssertionVenue v, address treasury) = _venue();
            bytes32 id = _assert(v, treasury, 5e6);
            v.setResult(id, false);
            assertTrue(v.trySettle(id));
            assertFalse(v.statusOf(id).truthful);
            assertEq(usdc.balanceOf(treasury), 95e6);
        }
        vm.revertToState(snap);
        {
            // test_venue_disputesAndDirectSettlement
            (MockUSDC usdc, MockAssertionVenue v, address treasury) = _venue();
            bytes32 id = _assert(v, treasury, 5e6);
            v.markDisputed(id, address(0xD15));
            assertTrue(v.statusOf(id).disputed);
            assertEq(v.statusOf(id).disputer, address(0xD15));
            v.settleDirectly(id, true);
            assertTrue(v.statusOf(id).settled);
            assertFalse(v.trySettle(id), "already settled on the venue");

            bytes32 id2 = _assert(v, treasury, 5e6);
            vm.prank(treasury);
            usdc.approve(address(v), 5e6);
            v.disputeFor(id2, treasury, treasury);
            assertTrue(v.statusOf(id2).disputed);
            assertEq(usdc.balanceOf(address(v)), 10e6, "dispute bond pulled");
            vm.expectRevert(MockAssertionVenue.UnknownAssertion.selector);
            v.disputeFor(keccak256("none"), treasury, treasury);
        }
        vm.revertToState(snap);
        {
            // test_venue_minimumBondAndCurrency
            (MockUSDC usdc, MockAssertionVenue v,) = _venue();
            assertEq(v.minimumBond(), 2e6);
            v.setMinimumBond(3e6);
            assertEq(v.minimumBond(), 3e6);
            assertEq(v.bondCurrency(), address(usdc));
            MockAssertionVenue noToken = new MockAssertionVenue(address(0), 0);
            bytes32 id = noToken.assertOutcome(IAssertionVenue.AssertRequest(keccak256("m"), "c", oracle, oracle, 1, 9));
            assertTrue(noToken.statusOf(id).exists, "works without token transfers");
        }
    }

    // ------------------------------------------------------------------ MockOracleView

    /// MockOracleView.
    function test_oracleView() public {
        uint256 snap = vm.snapshotState();
        {
            // test_oracleView_trustSetAndInit
            MockOracleView o = new MockOracleView();
            TrustSet memory t;
            t.cfg.venue = address(0xBEEF);
            t.cfg.threshold = 2;
            o.setTrustSet(3, t, true);
            assertEq(o.activeTrustSetId(), 3);
            assertEq(o.trustSet(3).cfg.venue, address(0xBEEF));
            o.initResolution(keccak256("m"));
            assertTrue(o.initialized(keccak256("m")));
            assertEq(o.initCount(), 1);
            vm.expectRevert(MockOracleView.AlreadyInitialized.selector);
            o.initResolution(keccak256("m"));
        }
        vm.revertToState(snap);
        {
            // test_oracleView_resolutionAndWatchdog
            MockOracleView o = new MockOracleView();
            Resolution memory r;
            r.state = RState.Proposed;
            r.assertionId = keccak256("a");
            o.setResolution(keccak256("m"), r);
            o.setWatchdog(keccak256("m"), address(0x3D));
            assertEq(uint8(o.getResolution(keccak256("m")).state), uint8(RState.Proposed));
            assertEq(o.getResolution(keccak256("m")).assertionId, keccak256("a"));
            assertEq(o.watchdogOf(keccak256("m")), address(0x3D));
        }
    }

    // ------------------------------------------------------------------ MockBondTreasury

    function test_treasury_commitments() public {
        MockBondTreasury t = new MockBondTreasury();
        t.setAvailable(100);
        t.commitListing(keccak256("a"), 60);
        assertEq(t.totalCommitted(), 60);
        vm.expectRevert(abi.encodeWithSelector(IBondTreasury.BelowCommitments.selector, 101, 100));
        t.commitListing(keccak256("b"), 41);
        vm.expectRevert(IBondTreasury.AlreadyCommitted.selector);
        t.commitListing(keccak256("a"), 1);
        t.releaseListing(keccak256("a"));
        assertEq(t.totalCommitted(), 0);
        assertTrue(t.released(keccak256("a")));
        t.commitListing(keccak256("b"), 41);
    }

    // ------------------------------------------------------------------ helpers

    function _engine(string memory id) internal returns (MockResolutionEngine) {
        return MockResolutionEngine(factory.deployMarket(_listing(id), abi.encode(uint256(1_000))));
    }

    function _venue() internal returns (MockUSDC usdc, MockAssertionVenue v, address treasury) {
        usdc = new MockUSDC();
        v = new MockAssertionVenue(address(usdc), 2e6);
        treasury = makeAddr("treasury");
        usdc.mint(treasury, 100e6);
    }

    function _assert(MockAssertionVenue v, address payer, uint256 bond) internal returns (bytes32) {
        MockUSDC token = MockUSDC(v.token()); // read before the prank: the prank applies to the next call
        vm.prank(payer);
        token.approve(address(v), bond);
        return v.assertOutcome(IAssertionVenue.AssertRequest(keccak256("m"), "claim", payer, payer, 7200, bond));
    }

    function _listing(string memory id) internal view returns (IMarketConfig.Listing memory x) {
        x.marketId = keccak256(bytes(id));
        x.token = address(0x05DC);
        x.registry = address(this);
        x.resolutionAuthority = oracle;
        x.monitor = address(0x30);
        x.governance = address(0x60);
        x.listedAt = L0;
        x.scheduledT = T;
        x.invalidRule = IMarketConfig.InvalidRule(true, 3600, 5e17, 45 days);
        x.deploymentCapX = 1;
        x.maxTraders = 1024;
        x.depthNLots = 500;
        x.minOrderLots = 1;
        x.maxOrderLots = 1e9;
    }
}
