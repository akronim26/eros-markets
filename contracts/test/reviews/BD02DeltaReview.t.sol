pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {CombinedEngine} from "../integration/CombinedEngine.sol";
import {RiskAccountingBridge} from "../../src/engine/RiskAccountingBridge.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {TradePreview} from "../../src/risk/TradePreview.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {PremiumMath} from "../../src/math/PremiumMath.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {ListingFixture} from "../risk/B/B019.t.sol";
import {RiskFixture} from "../math/B/B011.t.sol";

contract BD02DeltaEngine is CombinedEngine {
    bool public constant IS_TEST = true;
    uint64 private reviewFreshThrough;

    constructor(
        CollateralVault collateral,
        IMarketConfig.Listing memory marketListing,
        MarginMath.RiskParams memory parameters
    ) CombinedEngine(collateral, address(0x777), marketListing, parameters, 1e18) {}

    function openReviewCase(int256 rate, int128 reservePosition, uint256 budgetLimit) external {
        reviewFreshThrough = uint64(block.timestamp + 1 hours);
        PremiumMath.Tariff memory nextTariff = PremiumMath.Tariff(1e14, 1e14, 1e18);
        _activate(0, nextTariff);
        _seedReviewAccount(participants[0], 1_000_000, -100e24);
        _seedReviewAccount(participants[1], -1_000_000 - reservePosition, 1100e24);
        reserve.lots = reservePosition;
        oiAllLots = 1_000_000 + _positiveLots(reservePosition);
        _openEpoch(rate, nextTariff, reviewFreshThrough);
        if (budgetLimit < fundingBudgetQ) fundingBudgetQ = budgetLimit;
        _assertCoverage();
    }

    function _seedReviewAccount(address owner, int128 position, int256 cashQ) private {
        Account storage accountState = accounts[owner];
        accountState.value.lots = position;
        accountState.value.cashQ = cashQ;
        accountState.segmentCash = cashQ;
        accountState.segmentStart = uint64(block.timestamp);
        accountState.lastTouchedAt = uint64(block.timestamp);
        accountState.surchargeUntil = uint64(block.timestamp + 6 hours);
        _replaceDeficits(accountState);
    }

    function _fundingFreshThrough() internal view override returns (uint64) {
        return reviewFreshThrough;
    }

    function reviewAccrual() external view returns (PreviewAccrual memory) {
        return _previewAccrual(uint64(block.timestamp));
    }

    function touchReviewAccounts() external nonReentrant {
        _acctBeginAction();
        _acctTouch(1);
        _acctTouch(2);
        _assertCoverage();
    }
}

contract BD02DeltaReviewTest is Test {
    uint256 private constant ATOM_Q = 1e18;
    uint64 private constant OPENING = 1_000_000;
    int256 private constant RATE_MAGNITUDE = 1e16;
    address private constant LONG_OWNER = address(0x1001);
    address private constant SHORT_OWNER = address(0x1002);
    address private constant RESERVE_OWNER = address(0xCAFE);

    BD02DeltaEngine private harness;
    CollateralVault private collateral;
    MockUSDC private token;

    function setUp() public {
        vm.warp(OPENING);
        token = new MockUSDC();
        collateral = new CollateralVault(address(token), address(this));
        IMarketConfig.Listing memory marketListing =
            ListingFixture.make(OPENING, address(0xAC), address(0x30), address(0x60), address(0x51));
        marketListing.token = address(token);
        harness = new BD02DeltaEngine(collateral, marketListing, RiskFixture.profile(5, true));
        collateral.registerEngine(address(harness));
        _fund(RESERVE_OWNER, 100_000e6, true);
        _fund(LONG_OWNER, 500e6, false);
        _fund(SHORT_OWNER, 500e6, false);
    }

    function _fund(address owner, uint256 atoms, bool reserveAllocation) private {
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(collateral), atoms);
        collateral.deposit(atoms);
        collateral.allocate(address(harness), atoms, reserveAllocation);
        vm.stopPrank();
    }

    function _assertParity() private returns (RiskAccountingBridge.PreviewAccrual memory projected) {
        int256 previousIndex = harness.fundingFQ();
        uint256 previousBudget = harness.fundingBudgetQ();
        int256 previousLongCash = harness.account(LONG_OWNER).value.cashQ;
        int256 previousShortCash = harness.account(SHORT_OWNER).value.cashQ;
        TradePreview.AccountPreview memory longPreview = harness.previewAccount(1);
        TradePreview.AccountPreview memory shortPreview = harness.previewAccount(2);
        projected = harness.reviewAccrual();
        assertEq(harness.fundingFQ(), previousIndex);
        assertEq(harness.fundingBudgetQ(), previousBudget);
        assertEq(harness.account(LONG_OWNER).value.cashQ, previousLongCash);
        assertEq(harness.account(SHORT_OWNER).value.cashQ, previousShortCash);
        assertGt(longPreview.projectedPremiumQ, 0);
        harness.touchReviewAccounts();
        assertEq(harness.account(LONG_OWNER).value.cashQ, longPreview.cashQ);
        assertEq(harness.account(SHORT_OWNER).value.cashQ, shortPreview.cashQ);
        assertEq(harness.fundingFQ(), projected.fundingIndex);
        assertEq(harness.fundingBudgetQ(), projected.budgetQ);
        (, int256 reserveCash) = harness.reserve();
        assertEq(
            reserveCash,
            projected.reserveCashQ + int256(longPreview.projectedPremiumQ + shortPreview.projectedPremiumQ)
        );
        assertEq(harness.fundingCushionQ(), 0);
        assertEq(harness.fundingClearingQ(), 0);
        assertEq(harness.previewAccount(1).projectedFundingQ, 0);
        assertEq(harness.previewAccount(1).projectedPremiumQ, 0);
        assertEq(harness.previewAccount(2).projectedFundingQ, 0);
        assertEq(harness.previewAccount(2).projectedPremiumQ, 0);
        assertEq(longPreview.cashQ + shortPreview.cashQ + reserveCash, int256(harness.allocationQ()));
        assertEq(collateral.marketAtoms(address(harness)) * ATOM_Q, harness.allocationQ());
    }

    function _assertNegativeRateReserveRole(int128 reservePosition) private {
        harness.openReviewCase(-RATE_MAGNITUDE, reservePosition, type(uint256).max);
        vm.warp(OPENING + 20);
        int256 expectedIndex = -RATE_MAGNITUDE * 20;
        int256 reservePayment = int256(reservePosition) * expectedIndex;
        uint256 totalFlow = harness.oiAllLots() * uint256(RATE_MAGNITUDE) * 20;
        uint256 expectedCushion = totalFlow - (reservePayment > 0 ? uint256(reservePayment) : 0);
        assertEq(harness.previewAccount(1).projectedFundingQ, 1_000_000 * expectedIndex);
        assertEq(
            harness.previewAccount(2).projectedFundingQ, int256(-1_000_000 - reservePosition) * expectedIndex
        );
        RiskAccountingBridge.PreviewAccrual memory projected = _assertParity();
        assertEq(projected.fundingIndex, expectedIndex);
        assertEq(projected.reserveCashQ, 100_000e24 - reservePayment);
        assertEq(projected.cushionQ, expectedCushion);
    }

    function testNegativeRateReservePayerPreviewMatchesTouch() public {
        _assertNegativeRateReserveRole(-250_000);
    }

    function testNegativeRateReserveRecipientPreviewMatchesTouch() public {
        _assertNegativeRateReserveRole(250_000);
    }

    function testBudgetStopsAtWholeSecondAndRetainsRemainder() public {
        uint256 flowPerSecond = 1_000_000 * uint256(RATE_MAGNITUDE);
        uint256 remainder = flowPerSecond / 2;
        harness.openReviewCase(RATE_MAGNITUDE, 0, flowPerSecond * 7 + remainder);
        vm.warp(OPENING + 20);
        assertEq(harness.previewAccount(1).projectedFundingQ, int256(flowPerSecond * 7));
        RiskAccountingBridge.PreviewAccrual memory projected = _assertParity();
        assertEq(projected.fundingStop, OPENING + 7);
        assertEq(projected.budgetQ, remainder);
        (,,, uint64 lastAccrued, uint64 fundingStop,, bool stopped) = harness.epoch();
        assertTrue(stopped);
        assertEq(lastAccrued, OPENING + 7);
        assertEq(fundingStop, OPENING + 7);
        vm.warp(OPENING + 25);
        assertEq(harness.previewAccount(1).projectedFundingQ, 0);
        _assertParity();
        assertEq(harness.fundingFQ(), RATE_MAGNITUDE * 7);
        assertEq(harness.fundingBudgetQ(), remainder);
    }

    function testExactEpochEndAndRepeatedTimestampDoNotDoubleCharge() public {
        harness.openReviewCase(-RATE_MAGNITUDE, 0, type(uint256).max);
        (,, uint64 epochEnd,,,,) = harness.epoch();
        vm.warp(epochEnd);
        RiskAccountingBridge.PreviewAccrual memory projected = _assertParity();
        assertEq(projected.fundingStop, epochEnd);
        assertEq(projected.cutoff, epochEnd);
        assertEq(projected.fundingIndex, -RATE_MAGNITUDE * int256(uint256(epochEnd - OPENING)));
        (,,, uint64 lastAccrued, uint64 fundingStop,, bool stopped) = harness.epoch();
        assertTrue(stopped);
        assertEq(lastAccrued, epochEnd);
        assertEq(fundingStop, epochEnd);
        RiskStorage.Account memory longAfter = harness.account(LONG_OWNER);
        RiskStorage.Account memory shortAfter = harness.account(SHORT_OWNER);
        (, int256 reserveAfter) = harness.reserve();
        harness.touchReviewAccounts();
        assertEq(harness.account(LONG_OWNER).value.cashQ, longAfter.value.cashQ);
        assertEq(harness.account(SHORT_OWNER).value.cashQ, shortAfter.value.cashQ);
        assertEq(harness.account(LONG_OWNER).premiumPaid, longAfter.premiumPaid);
        assertEq(harness.account(SHORT_OWNER).premiumPaid, shortAfter.premiumPaid);
        (, int256 reserveRepeated) = harness.reserve();
        assertEq(reserveRepeated, reserveAfter);
        assertEq(harness.fundingFQ(), projected.fundingIndex);
        assertEq(harness.fundingBudgetQ(), 0);
    }
}
