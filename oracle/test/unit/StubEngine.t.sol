// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {HaltView, SettlementView, FinalOutcome, ClearingPhase} from "@eros/interfaces/IResolutionIngress.sol";
import {LifecycleMath} from "@eros/math/LifecycleMath.sol";
import {RiskContextPort} from "@eros/risk/RiskContextPort.sol";
import {ResolutionIngress} from "@eros/settlement/ResolutionIngress.sol";
import {ResolutionEngineStub} from "../../src/testnet/ResolutionEngineStub.sol";
import {StubMarketFactory} from "../../src/testnet/StubMarketFactory.sol";

/// @notice Task O19.1. The stub against every case of `docs/counterpart-oracle-fixtures.json` that needs
///         no accounting (clock_cases, finality_cases), plus the B034 rules and the factory.
contract StubEngineTest is Test {
    uint64 internal constant L0 = 1_000_000;
    uint64 internal constant T = L0 + 10 days;
    address internal registry = makeAddr("registry");
    address internal oracle = makeAddr("oracle");
    address internal monitor = makeAddr("monitor");
    address internal keeper = makeAddr("keeper");

    StubMarketFactory internal factory;
    ResolutionEngineStub internal e;
    IMarketConfig.Listing internal l;

    function setUp() public {
        vm.warp(L0);
        factory = new StubMarketFactory(registry);
        l = _listing();
        vm.prank(registry);
        e = ResolutionEngineStub(factory.deployMarket(l, abi.encode(uint256(1_500_000))));
    }

    // ------------------------------------------------------------------ fixture clock_cases

    function test_fixture_scheduledLateKeeper() public {
        vm.warp(T + 500);
        vm.prank(keeper);
        HaltView memory h = e.materializeScheduledHalt();
        assertEq(h.economicHaltAt, T, "oracle haltedAt must copy this");
        assertEq(h.haltRecordedAt, T + 500);
    }

    function test_fixture_earlyHalt() public {
        vm.warp(T - 5 days);
        vm.prank(oracle);
        HaltView memory h = e.halt();
        assertEq(h.economicHaltAt, T - 5 days);
        assertEq(h.oiHaltLots, 1_500_000, "OI from engineInit");
        assertEq(h.snapshotId, keccak256(abi.encode(l.marketId, uint64(T - 5 days))));
    }

    function test_fixture_settleBeforeHalt() public {
        vm.warp(T - 5 days);
        vm.prank(oracle);
        assertTrue(e.settle(1));
        HaltView memory h = e.getHaltSnapshot();
        assertTrue(h.halted, "settle materializes the halt first");
        assertEq(h.economicHaltAt, T - 5 days);
        assertEq(uint8(e.getSettlementStatus().finalOutcome), uint8(FinalOutcome.YES));
    }

    // ------------------------------------------------------------------ fixture finality_cases

    function test_fixture_sameOutcomeRepeat() public {
        vm.startPrank(oracle);
        assertTrue(e.settle(0));
        assertFalse(e.settle(0), "repeat returns false");
        vm.stopPrank();
        assertEq(uint8(e.getSettlementStatus().finalOutcome), uint8(FinalOutcome.NO));
    }

    function test_fixture_conflictingOutcome() public {
        vm.startPrank(oracle);
        e.settle(1);
        vm.expectRevert(ResolutionEngineStub.ConflictingFinalOutcome.selector);
        e.settle(0);
        vm.expectRevert(ResolutionEngineStub.ConflictingFinalOutcome.selector);
        e.settleInvalid();
        vm.stopPrank();
    }

    function test_fixture_invalidThenBinaryConflicts() public {
        vm.startPrank(oracle);
        assertTrue(e.settleInvalid());
        assertFalse(e.settleInvalid());
        vm.expectRevert(ResolutionEngineStub.ConflictingFinalOutcome.selector);
        e.settle(1);
        vm.stopPrank();
    }

    function test_fixture_unauthorizedCaller() public {
        address[3] memory callers = [monitor, keeper, registry];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(ResolutionEngineStub.Unauthorized.selector);
            e.halt();
            vm.expectRevert(ResolutionEngineStub.Unauthorized.selector);
            e.settle(1);
            vm.expectRevert(ResolutionEngineStub.Unauthorized.selector);
            e.settleInvalid();
            vm.stopPrank();
        }
    }

    function test_fixture_earlyBinaryClaimableBeforeT() public {
        vm.warp(T - 5 days);
        vm.prank(oracle);
        e.settle(1);
        SettlementView memory v = e.getSettlementStatus();
        assertTrue(v.claimsEnabled);
        assertEq(v.settlementPriceE18, 1e18);
        assertEq(uint8(v.phase), uint8(ClearingPhase.READY));
    }

    function test_fixture_earlyInvalidWaitsForT() public {
        vm.warp(T - 5 days);
        vm.prank(oracle);
        e.settleInvalid();
        SettlementView memory v = e.getSettlementStatus();
        assertTrue(v.oracleFinalityAccepted);
        assertFalse(v.invalidPriceReady);
        assertFalse(v.claimsEnabled);
        assertEq(uint8(v.phase), uint8(ClearingPhase.PREPARING));
        vm.warp(T);
        v = e.getSettlementStatus();
        assertTrue(v.invalidPriceReady && v.claimsEnabled);
        assertEq(v.settlementPriceE18, 5e17, "listed fallback price");
    }

    function test_fixture_failedDeliveryLeavesStateRetryable() public {
        vm.startPrank(oracle);
        vm.expectRevert(ResolutionEngineStub.BadOutcome.selector);
        e.settle(2);
        assertFalse(e.getHaltSnapshot().halted, "a reverted delivery changes nothing");
        assertTrue(e.settle(1), "retry succeeds");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ B034 rules

    function test_onlyZeroOrOneY() public {
        vm.startPrank(oracle);
        for (uint8 y = 2; y < 6; ++y) {
            vm.expectRevert(ResolutionEngineStub.BadOutcome.selector);
            e.settle(y);
        }
        vm.stopPrank();
    }

    /// Halt timing: scheduled at T, early by the oracle before T, idempotent; live before the halt.
    function test_haltTiming() public {
        uint256 snap = vm.snapshotState();
        {
            // test_scheduledHaltNotBeforeT
            vm.warp(T - 1);
            vm.expectRevert(ResolutionEngineStub.ScheduledHaltNotYet.selector);
            e.materializeScheduledHalt();
        }
        vm.revertToState(snap);
        {
            // test_oracleHaltAtOrAfterTIsScheduled
            vm.warp(T + 3600);
            vm.prank(oracle);
            assertEq(e.halt().economicHaltAt, T);
        }
        vm.revertToState(snap);
        {
            // test_haltIdempotent
            vm.warp(T - 1 days);
            vm.prank(oracle);
            HaltView memory a = e.halt();
            vm.warp(T + 1 days);
            vm.prank(oracle);
            HaltView memory b = e.halt();
            e.materializeScheduledHalt();
            assertEq(b.economicHaltAt, a.economicHaltAt);
            assertEq(b.haltRecordedAt, a.haltRecordedAt);
            assertEq(b.snapshotId, a.snapshotId);
            assertEq(e.getHaltSnapshot().snapshotId, a.snapshotId);
        }
        vm.revertToState(snap);
        {
            // test_liveBeforeHalt
            SettlementView memory v = e.getSettlementStatus();
            assertEq(uint8(v.phase), uint8(ClearingPhase.LIVE));
            assertFalse(v.claimsEnabled);
        }
    }

    function test_errorSelectorsMatchTheRealEngine() public pure {
        assertEq(ResolutionEngineStub.BadOutcome.selector, LifecycleMath.BadOutcome.selector);
        assertEq(ResolutionEngineStub.ConflictingFinalOutcome.selector, LifecycleMath.ConflictingFinalOutcome.selector);
        assertEq(ResolutionEngineStub.Unauthorized.selector, RiskContextPort.Unauthorized.selector);
        assertEq(ResolutionEngineStub.ScheduledHaltNotYet.selector, ResolutionIngress.ScheduledHaltNotYet.selector);
        assertEq(ResolutionEngineStub.BadListing.selector, RiskContextPort.BadListing.selector);
        assertEq(ResolutionEngineStub.AlreadyInitialized.selector, RiskContextPort.AlreadyInitialized.selector);
    }

    // ------------------------------------------------------------------ config, monitor, initialize

    /// Listing: hash, one initialize by the factory, void gate, no horizon gate.
    function test_listing() public {
        uint256 snap = vm.snapshotState();
        {
            // test_listingAndHash
            assertEq(e.listingHash(), keccak256(abi.encode(l)));
            assertEq(keccak256(abi.encode(e.listing())), keccak256(abi.encode(l)));
            assertEq(e.activeProfile().version, 0);
        }
        vm.revertToState(snap);
        {
            // test_initializeOnceByFactoryOnly
            vm.prank(keeper);
            vm.expectRevert(ResolutionEngineStub.Unauthorized.selector);
            e.initialize(l, abi.encode(uint256(1)));
            vm.prank(address(factory));
            vm.expectRevert(ResolutionEngineStub.AlreadyInitialized.selector);
            e.initialize(l, abi.encode(uint256(1)));
        }
        vm.revertToState(snap);
        {
            // test_voidGate
            IMarketConfig.Listing memory bad = _listing();
            bad.marketId = keccak256("m2");
            bad.invalidRule.voidSecs = uint64(T - L0 + 3600 - 1); // one second short of T + grace
            vm.prank(registry);
            vm.expectRevert(abi.encodeWithSelector(ResolutionEngineStub.BadListing.selector, uint8(2)));
            factory.deployMarket(bad, abi.encode(uint256(0)));
            bad.invalidRule.voidSecs += 1; // exactly at the gate
            vm.prank(registry);
            factory.deployMarket(bad, abi.encode(uint256(0)));
        }
        vm.revertToState(snap);
        {
            // test_noHorizonGate
            IMarketConfig.Listing memory soon = _listing();
            soon.marketId = keccak256("m3");
            soon.scheduledT = L0 + 600; // 10 minutes: allowed on the stub (testnet), unlike the real engine
            soon.invalidRule.voidSecs = 2 hours;
            vm.prank(registry);
            factory.deployMarket(soon, abi.encode(uint256(0)));
        }
    }

    function test_monitorFlag() public {
        assertFalse(e.marketRiskView().monitorRestricted);
        vm.prank(monitor);
        e.setMonitorRestricted(true);
        assertTrue(e.marketRiskView().monitorRestricted);
        vm.prank(keeper);
        vm.expectRevert(ResolutionEngineStub.Unauthorized.selector);
        e.setMonitorRestricted(false);
    }

    // ------------------------------------------------------------------ factory

    /// StubMarketFactory: non-zero registry, registry only, one engine per market.
    function test_factory() public {
        uint256 snap = vm.snapshotState();
        {
            // test_factory_rejectsZeroRegistry
            vm.expectRevert(StubMarketFactory.ZeroAddress.selector);
            new StubMarketFactory(address(0));
        }
        vm.revertToState(snap);
        {
            // test_factory_onlyRegistry
            IMarketConfig.Listing memory m = _listing();
            m.marketId = keccak256("m4");
            vm.prank(keeper);
            vm.expectRevert(StubMarketFactory.OnlyRegistry.selector);
            factory.deployMarket(m, abi.encode(uint256(0)));
        }
        vm.revertToState(snap);
        {
            // test_factory_reusedMarketIdReverts
            vm.prank(registry);
            vm.expectRevert(StubMarketFactory.MarketExists.selector);
            factory.deployMarket(l, abi.encode(uint256(0)));
        }
        vm.revertToState(snap);
        {
            // test_factory_recordsEngine
            assertEq(factory.engineOf(l.marketId), address(e));
            assertEq(e.factory(), address(factory));
        }
    }

    // ------------------------------------------------------------------ helpers

    function _listing() internal view returns (IMarketConfig.Listing memory x) {
        x.marketId = keccak256("eros-market-1");
        x.token = address(0x05DC);
        x.registry = registry;
        x.resolutionAuthority = oracle;
        x.monitor = monitor;
        x.governance = address(0x60);
        x.listedAt = L0;
        x.scheduledT = T;
        x.rulesHash = keccak256("rules");
        x.sourceHash = keccak256("source");
        x.invalidRule = IMarketConfig.InvalidRule(true, 3600, 5e17, 45 days);
        x.deploymentCapX = 1;
        x.maxTraders = 1024;
        x.depthNLots = 500;
        x.minOrderLots = 1;
        x.maxOrderLots = 1e9;
    }
}
