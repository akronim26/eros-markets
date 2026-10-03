pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../../../src/Book.sol";
import {BookRiskEngine} from "../../../src/engine/BookRiskEngine.sol";
import {BookDepthSampler} from "../../../src/pricing/BookDepthSampler.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {IPriceSource} from "../../../src/interfaces/IPriceSource.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {MockUSDC} from "../../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../../risk/B/B019.t.sol";

contract BoundedHistoryBookRiskEngine is BookRiskEngine {
    constructor(CollateralVault vault, address treasury, IMarketConfig.Listing memory configuration)
        BookRiskEngine(vault, treasury, configuration)
    {}

    function seedFullHistoryForTest(uint64 start, bool normalPricing) external {
        for (uint64 offset; offset <= 1024; ++offset) {
            uint64 observedAt = start + offset;
            _onIndexObservation(observedAt, 5e17, true);
            _recordPerp(
                observedAt,
                normalPricing ? 49e16 : 0,
                normalPricing ? 51e16 : 0,
                normalPricing ? _depthRule.depthNLots : 0,
                normalPricing ? _depthRule.depthNLots : 0
            );
        }
    }

    function setMaximumExaminedForTest(uint8 maximum) external {
        _setMaxFills(maximum);
    }
}

abstract contract ConcreteBookBoundedGasFixture is Test {
    uint64 internal constant LISTED_AT = 1_000_000;
    uint64 internal constant MAKER_LOTS = 1000;
    uint256 internal constant MAKER_COUNT = 64;
    uint256 internal constant CALL_GAS_BUDGET = 29_500_000;
    uint256 internal constant INDEX_SIGNER_KEY = 0x516;
    address internal constant TAKER = address(0x101);
    BoundedHistoryBookRiskEngine internal engine;
    CollateralVault internal vault;
    MockUSDC internal token;

    function _normalPricing() internal pure virtual returns (bool);

    function setUp() public {
        vm.warp(LISTED_AT);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        MockResolutionAuthority authority = new MockResolutionAuthority();
        IMarketConfig.Listing memory configuration = ListingFixture.make(
            LISTED_AT, address(authority), address(0x3031), address(this), vm.addr(INDEX_SIGNER_KEY)
        );
        configuration.token = address(token);
        configuration.deploymentCapX = 1;
        configuration.fundingEnabled = false;
        configuration.maxLiqLotsPerBlock = 0;
        configuration.maxOrderLots = uint64(type(uint48).max);
        configuration.depthNLots = 32_000;
        engine = new BoundedHistoryBookRiskEngine(vault, address(0x777), configuration);
        vault.registerEngine(address(engine));
        authority.bind(engine);
        _fund(TAKER, 100e6);
        for (uint256 index; index < MAKER_COUNT; ++index) {
            _fund(address(uint160(10_000 + index)), 1e6);
        }
        vm.warp(LISTED_AT + 1024);
        engine.seedFullHistoryForTest(LISTED_AT, _normalPricing());
        engine.activateMarket();
        assertEq(engine.ringCount(0), 1024);
        assertEq(engine.ringCount(1), 1024);
        assertEq(engine.ringCount(2), 1024);
        assertTrue(engine.riskContext().indexOk);
        assertEq(engine.riskContext().markOk, _normalPricing());
        for (uint256 index; index < MAKER_COUNT; ++index) {
            vm.prank(address(uint160(10_000 + index)));
            engine.placeOrder(
                Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, 500, MAKER_LOTS, 0, 0)
            );
        }
    }

    function _fund(address owner, uint256 atoms) private {
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(engine), atoms, false);
        vm.stopPrank();
    }

    function _sealIndexPrefix() private {
        vm.warp(block.timestamp + 1);
        IMarketConfig.Listing memory configuration = engine.listing();
        IPriceSource.Observation memory observation = IPriceSource.Observation({
            marketId: configuration.marketId,
            sourceId: configuration.indexSourceId,
            sequence: 1,
            observedAt: uint64(block.timestamp),
            publishedAt: uint64(block.timestamp),
            priceWad: 5e17,
            impactBidWad: 49e16,
            impactAskWad: 51e16,
            bidDepthLots: configuration.depthNLots,
            askDepthLots: configuration.depthNLots,
            sourceRulesHash: configuration.indexRulesHash
        });
        (uint8 recovery, bytes32 signatureR, bytes32 signatureS) =
            vm.sign(INDEX_SIGNER_KEY, engine.observationDigest(observation));
        engine.submitObservation(observation, abi.encodePacked(signatureR, signatureS, recovery));
    }

    function _measure(uint8 maximum, uint64 requestedLots) internal {
        engine.setMaximumExaminedForTest(maximum);
        vm.cool(address(engine));
        vm.prank(TAKER);
        uint256 beforeGas = gasleft();
        engine.placeOrder(
            Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, requestedLots, maximum, 0)
        );
        uint256 callGas = beforeGas - gasleft();
        emit log_named_uint("examined_makers", maximum);
        emit log_named_uint("full_history_fill_call_gas", callGas);
        _checkGas(maximum, callGas);
        _assertFillState(maximum);
    }

    function _checkGas(uint8 maximum, uint256 callGas) private view {
        if (maximum == 8) _checkProductionGas(callGas);
    }

    function _checkProductionGas(uint256 callGas) private view {
        if (vm.envOr("MONAD_GAS_CHECK", false)) assertLt(callGas, CALL_GAS_BUDGET);
    }

    function _assertFillState(uint8 maximum) private view {
        uint256 expectedLots = uint256(maximum) * MAKER_LOTS;
        assertEq(engine.oiAllLots(), expectedLots);
        assertEq(int256(engine.account(TAKER).value.lots), int256(expectedLots));
        int256 totalCash = engine.account(TAKER).value.cashQ;
        for (uint256 index; index < MAKER_COUNT; ++index) {
            address maker = address(uint160(10_000 + index));
            bool filled = index < maximum;
            assertEq(
                int256(engine.account(maker).value.lots), filled ? -int256(uint256(MAKER_LOTS)) : int256(0)
            );
            assertEq(engine.account(maker).orders.askLots, filled ? 0 : MAKER_LOTS);
            totalCash += engine.account(maker).value.cashQ;
        }
        assertEq(totalCash, 164e24);
        assertEq(engine.account(TAKER).orders.bidLots, 0);
        assertEq(vault.marketAtoms(address(engine)), 164e6);
        assertEq(token.balanceOf(address(vault)), 164e6);
        (int256 slackNo, int256 slackYes) = engine.coverageSlacks();
        assertGe(slackNo, 0);
        assertGe(slackYes, 0);
        (uint16 bid, uint16 ask) = engine.bestBidAsk();
        assertEq(bid, 0);
        assertEq(ask, 500);
    }

    function _measureBatchPlacements(uint8 maximum) private {
        engine.setMaximumExaminedForTest(maximum);
        Book.Place[] memory places = new Book.Place[](maximum);
        for (uint256 index; index < maximum; ++index) {
            places[index] = Book.Place(
                IBookRiskHooks.OrderKind.POST_ONLY, true, false, 490, uint64(type(uint48).max), 0, 0
            );
        }
        vm.cool(address(engine));
        vm.prank(TAKER);
        uint256 beforeGas = gasleft();
        uint32[] memory identifiers = engine.batch(new uint32[](0), places);
        uint256 callGas = beforeGas - gasleft();
        emit log_named_uint("batch_actions", maximum);
        emit log_named_uint("full_history_halving_batch_call_gas", callGas);
        _checkGas(maximum, callGas);
        uint256 restingLots;
        for (uint256 index; index < maximum; ++index) {
            if (identifiers[index] != 0) restingLots += engine.getOrder(identifiers[index]).size;
        }
        assertGt(restingLots, 0);
        assertEq(engine.account(TAKER).orders.bidLots, restingLots);
        assertLe(engine.account(TAKER).orders.bidValueQ, 100e24);
        assertEq(engine.account(TAKER).value.lots, 0);
        assertEq(engine.account(TAKER).value.cashQ, 100e24);
        assertEq(engine.oiAllLots(), 0);
        assertEq(vault.marketAtoms(address(engine)), 164e6);
        assertEq(token.balanceOf(address(vault)), 164e6);
        (int256 slackNo, int256 slackYes) = engine.coverageSlacks();
        assertGe(slackNo, 0);
        assertGe(slackYes, 0);
    }

    function _measureBatchCancels(uint8 maximum) private {
        engine.setMaximumExaminedForTest(maximum);
        uint32[] memory identifiers = new uint32[](maximum);
        vm.startPrank(TAKER);
        for (uint256 index; index < maximum; ++index) {
            identifiers[index] = engine.placeOrder(
                Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, false, 490, MAKER_LOTS, 0, 0)
            );
            assertGt(identifiers[index], 0);
        }
        vm.cool(address(engine));
        uint256 beforeGas = gasleft();
        engine.batch(identifiers, new Book.Place[](0));
        uint256 callGas = beforeGas - gasleft();
        vm.stopPrank();
        emit log_named_uint("batch_actions", maximum);
        emit log_named_uint("full_history_cancel_batch_call_gas", callGas);
        _checkGas(maximum, callGas);
        for (uint256 index; index < maximum; ++index) {
            assertEq(engine.getOrder(identifiers[index]).size, 0);
        }
        assertEq(engine.account(TAKER).orders.bidLots, 0);
        assertEq(engine.account(TAKER).orders.bidValueQ, 0);
        assertEq(engine.account(TAKER).value.lots, 0);
        assertEq(engine.account(TAKER).value.cashQ, 100e24);
        assertEq(engine.oiAllLots(), 0);
    }

    function _measureBatchMatching(uint8 maximum) private {
        engine.setMaximumExaminedForTest(maximum);
        Book.Place[] memory places = new Book.Place[](maximum);
        for (uint256 index; index < maximum; ++index) {
            places[index] = Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, MAKER_LOTS, 1, 0);
        }
        vm.cool(address(engine));
        vm.prank(TAKER);
        uint256 beforeGas = gasleft();
        engine.batch(new uint32[](0), places);
        uint256 callGas = beforeGas - gasleft();
        emit log_named_uint("batch_actions", maximum);
        emit log_named_uint("full_history_matching_batch_call_gas", callGas);
        _checkGas(maximum, callGas);
        _assertFillState(maximum);
    }

    function _measureMixedBatch() private {
        engine.setMaximumExaminedForTest(8);
        Book.Place[] memory places = new Book.Place[](8);
        for (uint256 index; index < 7; ++index) {
            places[index] = Book.Place(
                IBookRiskHooks.OrderKind.POST_ONLY, false, false, 510, uint64(type(uint48).max), 0, 0
            );
        }
        places[7] = Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 8 * MAKER_LOTS, 8, 0);
        vm.cool(address(engine));
        vm.prank(TAKER);
        uint256 beforeGas = gasleft();
        engine.batch(new uint32[](0), places);
        uint256 callGas = beforeGas - gasleft();
        emit log_named_uint("full_history_mixed_halving_and_fill_batch_call_gas", callGas);
        _checkGas(8, callGas);
        assertGt(engine.account(TAKER).orders.askLots, 0);
        _assertFillState(8);
    }

    function testBenchmarkEightFullHistoryMakerFills() public {
        _measure(8, uint64(MAKER_COUNT) * MAKER_LOTS);
    }

    function testBenchmarkSixteenFullHistoryMakerFills() public {
        _measure(16, uint64(MAKER_COUNT) * MAKER_LOTS);
    }

    function testBenchmarkTwentyFourFullHistoryMakerFills() public {
        _measure(24, uint64(MAKER_COUNT) * MAKER_LOTS);
    }

    function testBenchmarkTwentyFourFillsAfterMaximumSizeHalving() public {
        _measure(24, uint64(type(uint48).max));
    }

    function testBenchmarkEightFillsAfterMaximumSizeHalving() public {
        _measure(8, uint64(type(uint48).max));
    }

    function testBenchmarkEightActionMixedHalvingAndMatchingBatch() public {
        _measureMixedBatch();
    }

    function testBenchmarkFullHistorySixtyFourAccountSampler() public {
        for (uint256 index = 32; index < MAKER_COUNT; ++index) {
            vm.prank(address(uint160(10_000 + index)));
            engine.placeOrder(
                Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, false, 490, MAKER_LOTS, 0, 0)
            );
        }
        vm.cool(address(engine));
        uint256 beforeGas = gasleft();
        BookDepthSampler.BookDepthQuote memory quote = engine.bookDepth();
        uint256 callGas = beforeGas - gasleft();
        emit log_named_uint("full_history_64_account_depth_view_gas", callGas);
        _checkProductionGas(callGas);
        assertEq(quote.examined, 64);
        assertEq(quote.bidDepthLots, 32_000);
        assertEq(quote.askDepthLots, 32_000);
        assertEq(quote.bidWad, 490e15);
        assertEq(quote.askWad, 500e15);

        vm.roll(block.number + 1);
        vm.cool(address(engine));
        beforeGas = gasleft();
        bool published = engine.samplePerp();
        callGas = beforeGas - gasleft();
        emit log_named_uint("full_history_64_account_depth_capture_gas", callGas);
        _checkProductionGas(callGas);
        assertFalse(published);

        _sealIndexPrefix();
        vm.roll(block.number + 1);
        vm.cool(address(engine));
        beforeGas = gasleft();
        published = engine.samplePerp();
        callGas = beforeGas - gasleft();
        emit log_named_uint("full_history_64_account_depth_promotion_gas", callGas);
        _checkProductionGas(callGas);
        assertTrue(published);
        assertEq(engine.getLevel(true, 490).size, 32_000);
        assertEq(engine.getLevel(false, 500).size, 64_000);
        assertEq(engine.oiAllLots(), 0);
        assertEq(vault.marketAtoms(address(engine)), 164e6);
        assertEq(token.balanceOf(address(vault)), 164e6);
    }

    function testBenchmarkEightMaximumSizeBatchPlacements() public {
        _measureBatchPlacements(8);
    }

    function testBenchmarkSixteenMaximumSizeBatchPlacements() public {
        _measureBatchPlacements(16);
    }

    function testBenchmarkTwentyFourMaximumSizeBatchPlacements() public {
        _measureBatchPlacements(24);
    }

    function testBenchmarkEightBatchCancels() public {
        _measureBatchCancels(8);
    }

    function testBenchmarkSixteenBatchCancels() public {
        _measureBatchCancels(16);
    }

    function testBenchmarkTwentyFourBatchCancels() public {
        _measureBatchCancels(24);
    }

    function testBenchmarkEightBatchMatchingOrders() public {
        _measureBatchMatching(8);
    }

    function testBenchmarkSixteenBatchMatchingOrders() public {
        _measureBatchMatching(16);
    }

    function testBenchmarkTwentyFourBatchMatchingOrders() public {
        _measureBatchMatching(24);
    }
}

contract ConcreteBookBootstrapBoundedGasTest is ConcreteBookBoundedGasFixture {
    function _normalPricing() internal pure override returns (bool) {
        return false;
    }
}

contract ConcreteBookNormalBoundedGasTest is ConcreteBookBoundedGasFixture {
    function _normalPricing() internal pure override returns (bool) {
        return true;
    }
}
