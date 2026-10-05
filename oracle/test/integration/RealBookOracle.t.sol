pragma solidity ^0.8.30;

import {Book} from "@eros/Book.sol";
import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "@eros/interfaces/IBookRiskHooks.sol";
import {IPriceSource} from "@eros/interfaces/IPriceSource.sol";
import {LifecycleMath} from "@eros/math/LifecycleMath.sol";
import {MathTypes} from "@eros/math/MathTypes.sol";
import {SettlementController} from "@eros/settlement/SettlementController.sol";
import {RiskContextPort} from "@eros/risk/RiskContextPort.sol";
import {CollateralVault} from "@eros/vaults/CollateralVault.sol";
import {MarketCore, MarketInput, Outcome, RState, TrustSetInput} from "../../src/types/OracleTypes.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IMarketRegistry} from "../../src/interfaces/IMarketRegistry.sol";
import {RealMarketFixture} from "./RealMarketFixture.sol";
import {RegistryBookRiskEngine} from "../../src/integration/RegistryBookRiskEngine.sol";

contract RealBookOracleTest is RealMarketFixture {
    bytes32 internal constant MARKET_ID = keccak256("real-book-oracle");

    function testRegistryOiCapRejectsGrowthAtomicallyButAllowsClose() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        assertEq(RegistryBookRiskEngine(address(engine)).marketOiCapLots(), 100_000);
        vm.prank(seller);
        uint32 ask = engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 500, 1, 8, 0));
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(RegistryBookRiskEngine.OpenInterestCapExceeded.selector, 100_001, 100_000)
        );
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 1, 8, 0));
        assertEq(engine.oiAllLots(), 100_000);
        assertEq(engine.getOrder(ask).size, 1);
        assertEq(vault.marketAtoms(address(engine)), 200e6);
        vm.prank(seller);
        engine.cancel(ask);
        vm.prank(buyer);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, true, 500, 100_000, 8, 0));
        vm.prank(seller);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, true, 500, 100_000, 8, 0));
        assertEq(engine.oiAllLots(), 0);
    }

    function testPositionTransferAtCapDoesNotIncreaseOpenInterest() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        address replacement = makeAddr("replacement-owner");
        _fund(engine, replacement);
        vm.prank(buyer);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, true, 500, 100_000, 8, 0));
        vm.prank(replacement);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 100_000, 8, 0));
        assertEq(engine.oiAllLots(), 100_000);
        assertEq(engine.account(buyer).value.lots, 0);
        assertEq(engine.account(replacement).value.lots, 100_000);
    }

    function testMultiFillCapViolationRollsBackEarlierFillsAndOrders() public {
        MarketInput memory market = _input(MARKET_ID, false);
        market.oiCapLots = 100_001;
        IMarketConfig.Listing memory configuration = _listing();
        vm.prank(lister);
        BookRiskEngine engine = BookRiskEngine(registry.createMarket(market, configuration, ""));
        _trade(engine);
        vm.startPrank(seller);
        uint32 first = engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 500, 1, 8, 0));
        uint32 second = engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 500, 1, 8, 0));
        vm.stopPrank();
        bytes32 buyerBefore = keccak256(abi.encode(engine.account(buyer)));
        bytes32 sellerBefore = keccak256(abi.encode(engine.account(seller)));
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(RegistryBookRiskEngine.OpenInterestCapExceeded.selector, 100_002, 100_001)
        );
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 2, 8, 0));
        assertEq(engine.getOrder(first).size, 1);
        assertEq(engine.getOrder(second).size, 1);
        assertEq(engine.oiAllLots(), 100_000);
        assertEq(keccak256(abi.encode(engine.account(buyer))), buyerBefore);
        assertEq(keccak256(abi.encode(engine.account(seller))), sellerBefore);
    }

    function testRegistryBindingMustMatchBeforePosting() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        MarketCore memory core = registry.getMarketCore(MARKET_ID);
        core.engine = buyer;
        vm.mockCall(address(registry), abi.encodeCall(IMarketRegistry.getMarketCore, (MARKET_ID)), abi.encode(core));
        vm.expectRevert(RegistryBookRiskEngine.InvalidMarketRegistration.selector);
        RegistryBookRiskEngine(address(engine)).marketOiCapLots();
    }

    function testSamplerDoesNotInventExecutionCapacityAtOiCap() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        vm.prank(buyer);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, true, false, 490, 500, 8, 0));
        vm.prank(seller);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 510, 500, 8, 0));
        assertEq(engine.bookDepth().bidDepthLots, 0);
        assertEq(engine.bookDepth().askDepthLots, 0);
        assertTrue(engine.riskContext().indexOk);
        assertFalse(engine.samplePerp());
    }

    function testSamplerWorksWhenFullDepthFitsRemainingOiCapacity() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _fund(engine, buyer);
        _fund(engine, seller);
        vm.prank(gov);
        engine.activateMarket();
        _warmIndex(engine);
        vm.prank(buyer);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, true, false, 490, 500, 8, 0));
        vm.prank(seller);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 510, 500, 8, 0));
        assertEq(engine.bookDepth().bidDepthLots, 500);
        assertEq(engine.bookDepth().askDepthLots, 500);
    }

    function testRealFillEarlyYesFinalityAndOwnerClaimsBeforeT() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        _enterReview(engine, true);
        _propose(MARKET_ID, Outcome.YES);
        assertEq(engine.getHaltSnapshot().oiHaltLots, 100_000);
        _finalize(MARKET_ID, true);
        assertEq(uint8(resolutionOracle.getResolution(MARKET_ID).state), uint8(RState.Final));
        assertFalse(engine.claimsEnabled());
        _prepare(engine);
        assertLt(block.timestamp, REAL_T);
        assertEq(vault.claim(address(engine), buyer), 150e6);
        assertEq(vault.claim(address(engine), seller), 50e6);
        assertEq(token.balanceOf(buyer), 150e6);
        assertEq(token.balanceOf(seller), 50e6);
        assertEq(vault.marketAtoms(address(engine)), 0);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        vault.claim(address(engine), buyer);
    }

    function testRealFillScheduledNoAndClaimCannotPayEarly() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        _enterReview(engine, false);
        _propose(MARKET_ID, Outcome.NO);
        _finalize(MARKET_ID, true);
        vm.expectRevert(CollateralVault.Unauthorized.selector);
        vault.claim(address(engine), buyer);
        _prepare(engine);
        assertEq(vault.claim(address(engine), buyer), 50e6);
        assertEq(vault.claim(address(engine), seller), 150e6);
    }

    function testEarlyInvalidWaitsForScheduledWindowAndGrace() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        _enterReview(engine, true);
        _propose(MARKET_ID, Outcome.INVALID);
        _finalize(MARKET_ID, true);
        assertEq(uint8(engine.finalOutcome()), uint8(MathTypes.FinalOutcome.INVALID));
        engine.prepareSnapshotChunk(32);
        vm.expectRevert(SettlementController.OutcomeOrPricePending.selector);
        engine.preparePayoutChunk(32);
        (, bool captured) = engine.captureInvalidPrice();
        assertFalse(captured);
        vm.warp(REAL_T);
        (LifecycleMath.InvalidReadiness readiness, bool capturedAtT) = engine.captureInvalidPrice();
        assertFalse(capturedAtT);
        assertEq(uint8(readiness), uint8(LifecycleMath.InvalidReadiness.WAIT_GRACE));
        vm.warp(REAL_T + 1 hours);
        (, captured) = engine.captureInvalidPrice();
        assertTrue(captured);
        _prepare(engine);
        assertEq(vault.claim(address(engine), buyer), 100e6);
        assertEq(vault.claim(address(engine), seller), 100e6);
    }

    function testRejectedYesThenAcceptedNoDoesNotPrematurelySettleEngine() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        _enterReview(engine, false);
        _propose(MARKET_ID, Outcome.YES);
        _finalize(MARKET_ID, false);
        assertEq(uint8(resolutionOracle.getResolution(MARKET_ID).state), uint8(RState.Review));
        assertFalse(engine.claimsEnabled());
        _propose(MARKET_ID, Outcome.NO);
        _finalize(MARKET_ID, true);
        _prepare(engine);
        assertEq(vault.claim(address(engine), buyer), 50e6);
        assertEq(vault.claim(address(engine), seller), 150e6);
    }

    function testBothRejectedProduceInvalidNotAnUnbackedPayout() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        _enterReview(engine, false);
        _propose(MARKET_ID, Outcome.YES);
        _finalize(MARKET_ID, false);
        _propose(MARKET_ID, Outcome.NO);
        _finalize(MARKET_ID, false);
        assertEq(uint8(resolutionOracle.getResolution(MARKET_ID).outcome), uint8(Outcome.INVALID));
        assertFalse(engine.claimsEnabled());
        vm.warp(REAL_T + 1 hours);
        engine.captureInvalidPrice();
        _prepare(engine);
        assertEq(vault.claim(address(engine), buyer), 100e6);
    }

    function testCancellationSafeReleaseAndWithdrawalUseRealOwner() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _fund(engine, buyer);
        vm.prank(gov);
        engine.activateMarket();
        _warmIndex(engine);
        vm.startPrank(buyer);
        uint32 orderId = engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, true, false, 500, 100_000, 8, 0));
        engine.cancel(orderId);
        engine.release(25e6);
        assertEq(vault.freeAtoms(buyer), 25e6);
        vault.withdraw(25e6);
        vm.stopPrank();
        assertEq(token.balanceOf(buyer), 25e6);
        assertEq(vault.marketAtoms(address(engine)), 75e6);
        assertEq(vault.freeAtoms(seller), 0);
    }

    function testWrongAuthorityCannotHaltSettleOrRestrict() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        vm.expectRevert(RiskContextPort.RiskUnauthorized.selector);
        engine.halt();
        vm.expectRevert(RiskContextPort.RiskUnauthorized.selector);
        engine.settle(1);
        vm.expectRevert(RiskContextPort.RiskUnauthorized.selector);
        engine.requestReduceOnly(keccak256("unauthorized"));
    }

    function testFactoryMarketsRejectCrossEngineSignedIndexReplay() public {
        BookRiskEngine first = _listReal(MARKET_ID, false);
        BookRiskEngine second = _listReal(keccak256("other-engine"), false);
        IPriceSource.Observation memory observation = _observation(first, 1);
        bytes memory signature = _sign(INDEX_KEY, first.observationDigest(observation));
        first.submitObservation(observation, signature);
        vm.expectRevert();
        second.submitObservation(observation, signature);
    }

    function testDisputedAssertionWaitsThenPaysOnlyAfterResolutionAndPreparation() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        _enterReview(engine, false);
        _propose(MARKET_ID, Outcome.YES);
        resolutionOracle.assertProposal(MARKET_ID);
        bytes32 assertionId = resolutionOracle.getResolution(MARKET_ID).assertionId;
        assertionVenue.markDisputed(assertionId, seller);
        resolutionOracle.syncAssertion(MARKET_ID);
        assertEq(uint8(resolutionOracle.getResolution(MARKET_ID).state), uint8(RState.Disputed));
        resolutionOracle.finalizeMarket(MARKET_ID);
        assertFalse(engine.getSettlementStatus().oracleFinalityAccepted);
        vm.warp(block.timestamp + 300);
        assertionVenue.setResult(assertionId, true);
        resolutionOracle.finalizeMarket(MARKET_ID);
        _prepare(engine);
        assertEq(vault.claim(address(engine), buyer), 150e6);
    }

    function testPermissionlessResolutionUsesCallerBondAndRealClaims() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        vm.warp(REAL_T);
        resolutionOracle.haltScheduled(MARKET_ID);
        vm.warp(REAL_T + 600);
        assertTrue(resolutionOracle.openAfterDeadline(MARKET_ID));
        token.approve(address(assertionVenue), type(uint256).max);
        bytes32 assertionId = resolutionOracle.proposePermissionless(
            MARKET_ID, Outcome.NO, EVIDENCE_URI, keccak256("permissionless-fixture")
        );
        assertionVenue.setResult(assertionId, true);
        vm.warp(block.timestamp + 300);
        resolutionOracle.finalizeMarket(MARKET_ID);
        _prepare(engine);
        assertEq(vault.claim(address(engine), seller), 150e6);
    }

    function testVoidWithUnansweredDisputeSettlesInvalidAndRemainsClaimable() public {
        BookRiskEngine engine = _listReal(MARKET_ID, false);
        _trade(engine);
        _enterReview(engine, false);
        _propose(MARKET_ID, Outcome.YES);
        resolutionOracle.assertProposal(MARKET_ID);
        assertionVenue.markDisputed(resolutionOracle.getResolution(MARKET_ID).assertionId, seller);
        resolutionOracle.syncAssertion(MARKET_ID);
        vm.warp(resolutionOracle.getResolution(MARKET_ID).voidDeadline);
        assertTrue(resolutionOracle.voidMarket(MARKET_ID));
        assertEq(uint8(resolutionOracle.getResolution(MARKET_ID).outcome), uint8(Outcome.INVALID));
        engine.captureInvalidPrice();
        _prepare(engine);
        assertEq(vault.claim(address(engine), buyer), 100e6);
        assertEq(vault.claim(address(engine), seller), 100e6);
    }

    function testL1ProductionShapedMetadataAndReplayProtectionWithRealEngine() public {
        BookRiskEngine engine = _listReal(MARKET_ID, true);
        _trade(engine);
        bytes32 workflow = keccak256("fixture-workflow");
        address workflowOwner = makeAddr("workflow-owner");
        address forwarder = makeAddr("authenticated-forwarder-fixture");
        TrustSetInput memory trust;
        trust.production = true;
        trust.forwarder = forwarder;
        trust.workflowIds = [workflow, bytes32(0)];
        trust.workflowOwner = workflowOwner;
        trust.runnerAttestor = vm.addr(ATTESTOR_KEY);
        trust.committee = committee;
        trust.threshold = 2;
        trust.watchdog = makeAddr("production-shaped-watchdog");
        trust.venue = address(assertionVenue);
        vm.startPrank(gov);
        resolutionOracle.createTrustSet(trust);
        resolutionOracle.activateTrustSet(2);
        vm.stopPrank();
        vm.warp(REAL_T + 60);
        resolutionOracle.requestResolution(MARKET_ID);
        bytes memory report = abi.encode(
            uint8(1),
            SELECTOR,
            address(resolutionOracle),
            MARKET_ID,
            uint8(Outcome.YES),
            uint64(block.timestamp),
            keccak256("fixture-value"),
            registry.getSpecHash(MARKET_ID)
        );
        bytes memory metadata = abi.encodePacked(workflow, bytes10("eros-res"), workflowOwner, bytes2(0));
        assertEq(metadata.length, 64);
        vm.prank(forwarder);
        resolutionOracle.onReport(metadata, report);
        vm.prank(forwarder);
        vm.expectRevert();
        resolutionOracle.onReport(metadata, report);
        _finalize(MARKET_ID, true);
        _prepare(engine);
        assertEq(vault.claim(address(engine), buyer), 150e6);
    }

    function testExclusiveGroupCannotResolveTwoRealMarketsYes() public {
        bytes32 groupId = keccak256("real-exclusive-group");
        MarketInput memory firstInput = _input(MARKET_ID, false);
        firstInput.groupId = groupId;
        firstInput.groupExclusive = true;
        MarketInput memory secondInput = _input(keccak256("second-exclusive-market"), false);
        secondInput.groupId = groupId;
        secondInput.groupExclusive = true;
        IMarketConfig.Listing memory configuration = _listing();
        vm.startPrank(lister);
        BookRiskEngine first = BookRiskEngine(registry.createMarket(firstInput, configuration, ""));
        BookRiskEngine second = BookRiskEngine(registry.createMarket(secondInput, configuration, ""));
        vm.stopPrank();
        _trade(first);
        _trade(second);
        _enterReview(first, false);
        _enterReview(second, false);
        _propose(MARKET_ID, Outcome.YES);
        _propose(secondInput.marketId, Outcome.YES);
        _finalize(MARKET_ID, true);
        assertFalse(resolutionOracle.assertProposal(secondInput.marketId));
        assertFalse(second.getSettlementStatus().oracleFinalityAccepted);
        _propose(secondInput.marketId, Outcome.NO);
        _finalize(secondInput.marketId, true);
        _prepare(first);
        _prepare(second);
        assertEq(vault.claim(address(first), buyer), 150e6);
        assertEq(vault.claim(address(second), buyer), 50e6);
    }
}
