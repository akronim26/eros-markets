pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../../src/Book.sol";
import {RiskAccountingBridge} from "../../src/engine/RiskAccountingBridge.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {CoverageMath} from "../../src/math/CoverageMath.sol";
import {LiquidationMath} from "../../src/math/LiquidationMath.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {RiskLiquidation} from "../../src/risk/RiskLiquidation.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {RiskFixture} from "../math/B/B011.t.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../risk/B/B019.t.sol";

contract RealBookEngine is RiskAccountingBridge, Book {
    uint256 public immutable takerFeeWad;
    uint256 public failAtPosting;
    uint256 public postings;

    error InjectedAccountingFailure();

    constructor(
        CollateralVault vault,
        address reserveTreasury,
        IMarketConfig.Listing memory listing,
        MarginMath.RiskParams memory parameters,
        uint256 feeWad
    )
        RiskStorage(vault, reserveTreasury, listing.scheduledT, false, listing.fundingEnabled)
        RiskAccountingBridge(1e18)
    {
        takerFeeWad = feeWad;
        _initMarket(listing, parameters);
        _initBook(64);
    }

    function feed(uint64 from, uint64 to, uint256 indexWad, uint256 bidWad, uint256 askWad) external {
        for (uint64 timestamp = from; timestamp <= to; timestamp += 10) {
            _onIndexObservation(timestamp, indexWad, true);
            _recordPerp(timestamp, bidWad, askWad, 1e6, 1e6);
        }
    }

    function failOnPosting(uint256 postingNumber) external {
        failAtPosting = postingNumber;
        postings = 0;
    }

    function _traderOf(address owner) internal override returns (uint32 traderId) {
        traderId = _idOf[owner];
        if (traderId != 0) return traderId;
        for (uint256 participantIndex; participantIndex < participants.length; ++participantIndex) {
            if (participants[participantIndex] == owner) {
                traderId = uint32(participantIndex + 1);
                _remember(traderId, owner);
                return traderId;
            }
        }
        revert UnknownTrader(0);
    }

    function _liqSubmitIoc(OrderRequest memory request) internal override returns (uint64, uint256) {
        return _placeForced(request);
    }

    function _tradeFeeQ(uint64 lots, uint16 tick, bool isMaker) internal view override returns (uint256) {
        return isMaker ? 0 : uint256(lots) * tick * takerFeeWad;
    }

    function _feeCapQ(uint64 lots, uint16 tick) internal view override returns (uint256) {
        return uint256(lots) * tick * takerFeeWad;
    }

    function _acctPostFill(FillDelta memory delta) internal override {
        ++postings;
        if (failAtPosting != 0 && postings == failAtPosting) revert InjectedAccountingFailure();
        super._acctPostFill(delta);
    }
}

contract RealBookIntegrationTest is Test {
    uint256 constant ATOM_Q = 1e18;
    uint256 constant USDC_Q = 1e24;
    uint64 constant LISTED_AT = 1_000_000;
    address constant GOVERNOR = address(0x60);
    address constant MONITOR = address(0x30);
    address constant SIGNER = address(0x51);
    address constant TREASURY = address(0x777);
    address constant RESERVE_PROVIDER = address(0xCAFE);
    address constant KEEPER = address(0xBEEF);

    RealBookEngine engine;
    CollateralVault vault;
    MockUSDC token;
    MockResolutionAuthority oracle;
    uint64 lastFeed;

    function setUp() public {
        _deploy(0);
    }

    function _deploy(uint256 feeWad) internal {
        vm.warp(LISTED_AT);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        oracle = new MockResolutionAuthority();
        IMarketConfig.Listing memory listing =
            ListingFixture.make(LISTED_AT, address(oracle), MONITOR, GOVERNOR, SIGNER);
        listing.scheduledT = LISTED_AT + 29 days + 12 hours;
        listing.token = address(token);
        listing.deploymentCapX = 5;
        engine = new RealBookEngine(vault, TREASURY, listing, RiskFixture.profile(5, true), feeWad);
        vault.registerEngine(address(engine));
        oracle.bind(engine);
        _fund(RESERVE_PROVIDER, 100_000e6, true);
        _fund(_trader(1), 120e6, false);
        _fund(_trader(2), 400e6, false);
        _fund(_trader(3), 1000e6, false);
        _fund(_trader(4), 400e6, false);
        _fund(_trader(5), 400e6, false);
        vm.prank(GOVERNOR);
        engine.activateMarket();
        lastFeed = LISTED_AT - 1000;
        _advance(LISTED_AT + 12 hours, 6e17);
    }

    function _fund(address owner, uint256 atoms, bool isReserve) internal {
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(engine), atoms, isReserve);
        vm.stopPrank();
    }

    function _trader(uint32 traderId) internal pure returns (address) {
        return address(uint160(0x1000 + traderId));
    }

    function _advance(uint64 timestamp, uint256 priceWad) internal {
        uint64 from = timestamp - 990 > lastFeed + 10 ? timestamp - 990 : lastFeed + 10;
        vm.warp(timestamp);
        engine.feed(from, timestamp, priceWad, priceWad - 1e16, priceWad + 1e16);
        lastFeed = timestamp - ((timestamp - from) % 10);
        (,, uint64 epochEnd,,,,) = engine.epoch();
        if (timestamp >= epochEnd) {
            engine.beginRollover();
            while (!engine.rollPage(32)) {}
            engine.finishRollover();
        }
    }

    function _place(
        uint32 traderId,
        IBookRiskHooks.OrderKind kind,
        bool isBuy,
        uint16 tick,
        uint64 lots,
        bool reduceOnly,
        uint32 expiryBlock
    ) internal returns (uint32) {
        vm.prank(_trader(traderId));
        return engine.placeOrder(Book.Place(kind, isBuy, reduceOnly, tick, lots, 8, expiryBlock));
    }

    function _post(uint32 traderId, bool isBuy, uint16 tick, uint64 lots) internal returns (uint32) {
        return _place(traderId, IBookRiskHooks.OrderKind.POST_ONLY, isBuy, tick, lots, false, 0);
    }

    function _ioc(uint32 traderId, bool isBuy, uint16 tick, uint64 lots) internal {
        _place(traderId, IBookRiskHooks.OrderKind.IOC, isBuy, tick, lots, false, 0);
    }

    function _cash(uint32 traderId) internal view returns (int256) {
        return engine.account(_trader(traderId)).value.cashQ;
    }

    function _lots(uint32 traderId) internal view returns (int256) {
        return engine.account(_trader(traderId)).value.lots;
    }

    function _orders(uint32 traderId) internal view returns (CoverageMath.Orders memory) {
        return engine.account(_trader(traderId)).orders;
    }

    function _assertEmptyReservation(uint32 traderId) internal view {
        CoverageMath.Orders memory orders = _orders(traderId);
        assertEq(orders.bidLots + orders.askLots, 0);
        assertEq(orders.bidValueQ + orders.askValueQ + orders.feeCapQ, 0);
    }

    function _assertAccounting() internal view {
        (int128 reserveLots, int256 reserveCash) = engine.reserve();
        int256 netLots = reserveLots;
        int256 totalCash = reserveCash;
        for (uint256 participantIndex; participantIndex < engine.participantCount(); ++participantIndex) {
            RiskStorage.Account memory account = engine.account(engine.participants(participantIndex));
            netLots += account.value.lots;
            totalCash += account.value.cashQ;
        }
        assertEq(netLots, 0, "net positions");
        assertEq(
            totalCash + int256(engine.protocolFeeQ() + engine.keeperPayableQ()) + engine.fundingClearingQ(),
            int256(engine.allocationQ()),
            "ledger conservation"
        );
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms(), "custody solvency");
        assertEq(
            vault.marketAtoms(address(engine)) * ATOM_Q - vault.marketDebitQ(address(engine)),
            engine.allocationQ(),
            "market allocation"
        );
        (int256 noSlack, int256 yesSlack) = engine.coverageSlacks();
        assertGe(noSlack, 0, "NO coverage");
        assertGe(yesSlack, 0, "YES coverage");
    }

    function _openLong() internal {
        _post(2, false, 600, 1_000_000);
        _ioc(1, true, 600, 1_000_000);
        assertEq(_lots(1), 1_000_000);
    }

    function testFirstTradeUsesAccountingRegistryAndPostsBothLegs() public {
        assertEq(engine.traderIdOf(_trader(1)), 0);
        assertEq(engine.traderIdOf(_trader(2)), 0);
        uint32 makerOrder = _post(2, false, 600, 1_000_000);
        assertEq(engine.traderIdOf(_trader(2)), 2);
        assertEq(_orders(2).askLots, 1_000_000);
        _ioc(1, true, 600, 1_000_000);
        assertEq(engine.traderIdOf(_trader(1)), 1);
        assertEq(_cash(1), -int256(480 * USDC_Q));
        assertEq(_cash(2), int256(1000 * USDC_Q));
        assertEq(_lots(1), 1_000_000);
        assertEq(_lots(2), -1_000_000);
        assertEq(engine.oiAllLots(), 1_000_000);
        assertEq(engine.getOrder(makerOrder).size, 0);
        _assertEmptyReservation(1);
        _assertEmptyReservation(2);
        _assertAccounting();
    }

    function testUnallocatedCallerCannotAcquireAnIndependentBookId() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(RiskAccountingBridge.UnknownTrader.selector, uint32(0)));
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, false, 600, 1, 8, 0));
        assertEq(engine.participantCount(), 5);
    }

    function testCancelReleasesExactTickAndCancelAllCannotReleaseNewEpoch() public {
        uint32 lowBid = _post(2, true, 400, 7);
        uint32 highBid = _post(2, true, 600, 11);
        vm.prank(_trader(2));
        engine.cancel(lowBid);
        assertEq(_orders(2).bidLots, 11);
        assertEq(_orders(2).bidValueQ, 6600 * ATOM_Q);
        vm.prank(_trader(2));
        engine.cancelAll();
        _assertEmptyReservation(2);
        uint32 freshBid = _post(2, true, 500, 3);
        vm.prank(_trader(2));
        engine.cancel(highBid);
        assertEq(_orders(2).bidLots, 3);
        assertEq(_orders(2).bidValueQ, 1500 * ATOM_Q);
        assertEq(engine.getOrder(freshBid).size, 3);
        _assertAccounting();
    }

    function testWrongOwnerCannotCancelAnotherAccountingReservation() public {
        uint32 makerOrder = _post(2, false, 600, 5);
        vm.prank(_trader(3));
        vm.expectRevert(Book.NotOwner.selector);
        engine.cancel(makerOrder);
        assertEq(engine.getOrder(makerOrder).size, 5);
        assertEq(_orders(2).askLots, 5);
        _assertEmptyReservation(3);
        _assertAccounting();
    }

    function testMatchingPrunesOldEpochWithoutDebitingFreshReservation() public {
        uint32 oldAsk = _post(2, false, 600, 5);
        vm.prank(_trader(2));
        engine.cancelAll();
        uint32 freshAsk = _post(2, false, 610, 3);
        _ioc(1, true, 610, 10);
        assertEq(_lots(1), 3);
        assertEq(_cash(1), int256(120 * USDC_Q) - int256(1830 * ATOM_Q));
        assertEq(engine.getOrder(oldAsk).size, 0);
        assertEq(engine.getOrder(freshAsk).size, 0);
        _assertEmptyReservation(1);
        _assertEmptyReservation(2);
        _assertAccounting();
    }

    function testMultipleMakerFillsPostActualFeesAndReleaseAllPermits() public {
        _deploy(1e15);
        _post(2, false, 600, 300_000);
        _post(4, false, 601, 700_000);
        _ioc(3, true, 601, 1_000_000);
        uint256 notional = (300_000 * 600 + 700_000 * 601) * ATOM_Q;
        uint256 fee = (300_000 * 600 + 700_000 * 601) * 1e15;
        assertEq(_cash(3), int256(1000 * USDC_Q - notional - fee));
        assertEq(_cash(2), int256(580 * USDC_Q));
        assertEq(_cash(4), int256(400 * USDC_Q + 420_700 * 1e21));
        assertEq(engine.protocolFeeQ(), fee);
        assertEq(engine.oiAllLots(), 1_000_000);
        _assertEmptyReservation(2);
        _assertEmptyReservation(3);
        _assertEmptyReservation(4);
        _assertAccounting();
    }

    function testPartialFillThenCancelReleasesRemainingFeeCap() public {
        _deploy(1e15);
        uint32 makerOrder = _post(2, false, 600, 3);
        assertEq(_orders(2).feeCapQ, 1800e15);
        _ioc(3, true, 600, 1);
        assertEq(engine.getOrder(makerOrder).size, 2);
        assertEq(engine.getOrder(makerOrder).feeCapQ, 1200e15);
        assertEq(_orders(2).askLots, 2);
        assertEq(_orders(2).feeCapQ, 1200e15);
        vm.prank(_trader(2));
        engine.cancel(makerOrder);
        assertEq(engine.protocolFeeQ(), 600e15);
        _assertEmptyReservation(2);
        _assertEmptyReservation(3);
        _assertAccounting();
    }

    function testReductionPermitContinuesAcrossItsOwnPositionVersionChanges() public {
        _openLong();
        uint32 firstBid = _post(3, true, 600, 250_000);
        uint32 secondBid = _post(4, true, 600, 250_000);
        uint64 versionBefore = engine.account(_trader(1)).positionVersion;
        _place(1, IBookRiskHooks.OrderKind.IOC, false, 600, 500_000, true, 0);
        assertEq(_lots(1), 500_000);
        assertEq(_cash(1), -int256(180 * USDC_Q));
        assertEq(engine.account(_trader(1)).positionVersion, versionBefore + 2);
        assertEq(engine.getOrder(firstBid).size, 0);
        assertEq(engine.getOrder(secondBid).size, 0);
        assertEq(_lots(4), 250_000);
        _assertEmptyReservation(1);
        _assertEmptyReservation(3);
        _assertEmptyReservation(4);
        _assertAccounting();
    }

    function testUnsafeVoluntaryReductionStopsBeforeFirstFill() public {
        _openLong();
        uint32 makerOrder = _post(3, true, 1, 500_000);
        _place(1, IBookRiskHooks.OrderKind.IOC, false, 1, 500_000, true, 0);
        assertEq(_lots(1), 1_000_000);
        assertEq(_cash(1), -int256(480 * USDC_Q));
        assertEq(engine.getOrder(makerOrder).size, 500_000);
        assertEq(_lots(3), 0);
        _assertEmptyReservation(1);
        _assertAccounting();
    }

    function testReductionAcrossMakersStillStopsBeforeUnsafeSecondFill() public {
        _openLong();
        uint32 firstBid = _post(3, true, 600, 250_000);
        uint32 unsafeBid = _post(4, true, 1, 250_000);
        _place(1, IBookRiskHooks.OrderKind.IOC, false, 1, 500_000, true, 0);
        assertEq(_lots(1), 750_000);
        assertEq(_cash(1), -int256(330 * USDC_Q));
        assertEq(engine.getOrder(firstBid).size, 0);
        assertEq(engine.getOrder(unsafeBid).size, 250_000);
        assertEq(_lots(4), 0);
        _assertEmptyReservation(1);
        _assertAccounting();
    }

    function testReductionAcrossMakersClipsAtFlatWithoutFlipping() public {
        _openLong();
        uint32 firstBid = _post(3, true, 600, 600_000);
        uint32 secondBid = _post(4, true, 600, 600_000);
        _place(1, IBookRiskHooks.OrderKind.IOC, false, 600, 2_000_000, true, 0);
        assertEq(_lots(1), 0);
        assertEq(_cash(1), int256(120 * USDC_Q));
        assertEq(engine.getOrder(firstBid).size, 0);
        assertEq(engine.getOrder(secondBid).size, 200_000);
        assertEq(_lots(3), 600_000);
        assertEq(_lots(4), 400_000);
        _assertEmptyReservation(1);
        _assertAccounting();
    }

    function testOwnTakerFillDoesNotRefreshAnOlderRestingReduction() public {
        _openLong();
        uint64 versionBefore = engine.account(_trader(1)).positionVersion;
        uint32 olderAsk = _place(1, IBookRiskHooks.OrderKind.POST_ONLY, false, 650, 100_000, true, 0);
        _post(3, true, 600, 100_000);
        _place(1, IBookRiskHooks.OrderKind.IOC, false, 600, 100_000, true, 0);
        assertEq(engine.getOrder(olderAsk).reduceVersion, versionBefore);
        assertEq(engine.account(_trader(1)).positionVersion, versionBefore + 1);
        _ioc(4, true, 650, 100_000);
        assertEq(engine.getOrder(olderAsk).size, 0);
        assertEq(_lots(1), 900_000);
        assertEq(_lots(4), 0);
        _assertEmptyReservation(1);
        _assertEmptyReservation(4);
        _assertAccounting();
    }

    function testPartiallyFilledReduceOnlyLimitRestUsesAcceptedPostingVersion() public {
        _openLong();
        _post(3, true, 600, 250_000);
        uint64 versionBefore = engine.account(_trader(1)).positionVersion;
        uint32 remainder = _place(1, IBookRiskHooks.OrderKind.LIMIT, false, 600, 500_000, true, 0);
        assertGt(remainder, 0);
        assertEq(engine.getOrder(remainder).size, 250_000);
        assertEq(engine.getOrder(remainder).reduceVersion, versionBefore + 1);
        assertEq(engine.account(_trader(1)).positionVersion, versionBefore + 1);
        _ioc(4, true, 600, 250_000);
        assertEq(engine.getOrder(remainder).size, 0);
        assertEq(_lots(1), 500_000);
        assertEq(_lots(4), 250_000);
        _assertEmptyReservation(1);
        _assertEmptyReservation(4);
        _assertAccounting();
    }

    function testConvertedRemainderIsStillInvalidatedByAnUnrelatedTrade() public {
        _openLong();
        _post(3, true, 600, 250_000);
        uint32 remainder = _place(1, IBookRiskHooks.OrderKind.LIMIT, false, 600, 500_000, true, 0);
        uint64 admittedVersion = engine.getOrder(remainder).reduceVersion;
        _post(1, true, 500, 10);
        _ioc(5, false, 500, 10);
        assertEq(engine.account(_trader(1)).positionVersion, admittedVersion + 1);
        assertEq(engine.getOrder(remainder).reduceVersion, admittedVersion);
        _ioc(4, true, 600, 250_000);
        assertEq(engine.getOrder(remainder).size, 0);
        assertEq(_lots(1), 750_010);
        assertEq(_lots(4), 0);
        _assertEmptyReservation(1);
        _assertEmptyReservation(4);
        _assertAccounting();
    }

    function testSecondReductionPostingFailureRollsBackRefreshedPermitAndBothFills() public {
        _openLong();
        uint32 firstBid = _post(3, true, 600, 250_000);
        uint32 secondBid = _post(4, true, 600, 250_000);
        uint64 versionBefore = engine.account(_trader(1)).positionVersion;
        engine.failOnPosting(2);
        vm.expectRevert(RealBookEngine.InjectedAccountingFailure.selector);
        _place(1, IBookRiskHooks.OrderKind.IOC, false, 600, 500_000, true, 0);
        assertEq(engine.postings(), 0);
        assertEq(_lots(1), 1_000_000);
        assertEq(_cash(1), -int256(480 * USDC_Q));
        assertEq(engine.account(_trader(1)).positionVersion, versionBefore);
        assertEq(engine.getOrder(firstBid).size, 250_000);
        assertEq(engine.getOrder(secondBid).size, 250_000);
        assertEq(_orders(3).bidLots, 250_000);
        assertEq(_orders(4).bidLots, 250_000);
        _assertEmptyReservation(1);
        _assertAccounting();
        engine.failOnPosting(0);
        _place(1, IBookRiskHooks.OrderKind.IOC, false, 600, 500_000, true, 0);
        assertEq(_lots(1), 500_000);
        _assertEmptyReservation(1);
        _assertEmptyReservation(3);
        _assertEmptyReservation(4);
        _assertAccounting();
    }

    function testUnsafeReduceOnlyMakerIsPrunedWithoutAccountingFill() public {
        _openLong();
        uint32 unsafeAsk = _place(1, IBookRiskHooks.OrderKind.POST_ONLY, false, 1, 500_000, true, 0);
        assertGt(unsafeAsk, 0);
        _ioc(3, true, 1, 500_000);
        assertEq(engine.getOrder(unsafeAsk).size, 0);
        assertEq(_lots(1), 1_000_000);
        assertEq(_cash(1), -int256(480 * USDC_Q));
        assertEq(_lots(3), 0);
        _assertEmptyReservation(1);
        _assertEmptyReservation(3);
        _assertAccounting();
    }

    function testExpiredOrderPrunesAndRecycledSlotKeepsNewReservation() public {
        uint32 expiredAsk =
            _place(2, IBookRiskHooks.OrderKind.POST_ONLY, false, 600, 5, false, uint32(block.number));
        vm.roll(block.number + 1);
        _ioc(1, true, 600, 5);
        assertEq(engine.getOrder(expiredAsk).size, 0);
        assertEq(_lots(1), 0);
        _assertEmptyReservation(2);
        uint32 freshAsk = _post(2, false, 610, 7);
        assertEq(expiredAsk & 0xFFFFFF, freshAsk & 0xFFFFFF);
        assertTrue(expiredAsk != freshAsk);
        vm.prank(_trader(2));
        vm.expectRevert(Book.NotLive.selector);
        engine.cancel(expiredAsk);
        assertEq(_orders(2).askLots, 7);
        assertEq(engine.getOrder(freshAsk).size, 7);
        _assertAccounting();
    }

    function testSecondPostingFailureRollsBackFirstFillAndBothOrders() public {
        uint32 firstAsk = _post(2, false, 600, 300_000);
        uint32 secondAsk = _post(4, false, 601, 300_000);
        engine.failOnPosting(2);
        vm.expectRevert(RealBookEngine.InjectedAccountingFailure.selector);
        _ioc(3, true, 601, 600_000);
        assertEq(engine.postings(), 0);
        assertEq(_cash(2), int256(400 * USDC_Q));
        assertEq(_cash(3), int256(1000 * USDC_Q));
        assertEq(_cash(4), int256(400 * USDC_Q));
        assertEq(engine.oiAllLots(), 0);
        assertEq(engine.getOrder(firstAsk).size, 300_000);
        assertEq(engine.getOrder(secondAsk).size, 300_000);
        assertEq(engine.getLevel(false, 600).size, 300_000);
        assertEq(engine.getLevel(false, 601).size, 300_000);
        assertEq(_orders(2).askLots, 300_000);
        assertEq(_orders(4).askLots, 300_000);
        _assertEmptyReservation(3);
        _assertAccounting();
    }

    function testForcedIocClosesRealPositionAndCreditsActualKeeperFee() public {
        _openLong();
        _advance(uint64(block.timestamp) + 20 minutes, 55e16);
        _advance(uint64(block.timestamp) + 20 minutes, 52e16);
        _advance(uint64(block.timestamp) + 20 minutes, 52e16);
        assertEq(uint8(engine.previewAccount(1).status), uint8(MarginMath.Status.BELOW_MM));
        uint32 bidOrder = _post(3, true, 510, 1_000_000);
        vm.prank(KEEPER);
        RiskLiquidation.LiquidationResult memory result = engine.liquidate(1, 10, 8, 0);
        assertEq(uint8(result.result), uint8(LiquidationMath.Result.NEEDS_MORE_WORK));
        assertEq(result.bookLots, 10);
        assertEq(result.pairedLots, 0);
        assertEq(_lots(1), 999_990);
        assertEq(_lots(3), 10);
        assertEq(engine.getOrder(bidOrder).size, 999_990);
        assertEq(engine.keeperQ(KEEPER), 5 * ATOM_Q);
        assertEq(engine.keeperPayableQ(), 5 * ATOM_Q);
        _assertEmptyReservation(1);
        _assertAccounting();
    }

    function testForcedReductionContinuesAcrossItsOwnPositionVersionChanges() public {
        _openLong();
        _advance(uint64(block.timestamp) + 20 minutes, 55e16);
        _advance(uint64(block.timestamp) + 20 minutes, 52e16);
        _advance(uint64(block.timestamp) + 20 minutes, 52e16);
        uint32 firstBid = _post(3, true, 510, 5);
        uint32 secondBid = _post(4, true, 510, 5);
        vm.prank(KEEPER);
        RiskLiquidation.LiquidationResult memory result = engine.liquidate(1, 10, 8, 0);
        assertEq(uint8(result.result), uint8(LiquidationMath.Result.NEEDS_MORE_WORK));
        assertEq(result.bookLots, 10);
        assertEq(engine.getOrder(firstBid).size, 0);
        assertEq(engine.getOrder(secondBid).size, 0);
        assertEq(_lots(1), 999_990);
        assertEq(_lots(3), 5);
        assertEq(_lots(4), 5);
        assertEq(engine.keeperQ(KEEPER), 5 * ATOM_Q);
        _assertEmptyReservation(1);
        _assertEmptyReservation(3);
        _assertEmptyReservation(4);
        _assertAccounting();
    }

    function testPairRestoringRealAccountHealthDoesNotUseBookLiquidity() public {
        _post(4, false, 600, 1_000_000);
        _ioc(1, true, 600, 1_000_000);
        _advance(uint64(block.timestamp) + 20 minutes, 55e16);
        _advance(uint64(block.timestamp) + 20 minutes, 50e16);
        _advance(uint64(block.timestamp) + 20 minutes, 48e16);
        vm.prank(_trader(2));
        engine.release(336e6);
        assertEq(_cash(2), int256(64 * USDC_Q));
        _post(2, false, 480, 600_000);
        _ioc(5, true, 480, 600_000);
        assertEq(_lots(2), -600_000);
        assertEq(_cash(2), int256(352 * USDC_Q));
        _advance(uint64(block.timestamp) + 20 minutes, 53e16);
        _advance(uint64(block.timestamp) + 20 minutes, 54e16);
        _advance(uint64(block.timestamp) + 20 minutes, 54e16);
        assertEq(uint8(engine.previewAccount(1).status), uint8(MarginMath.Status.BELOW_MM));
        assertEq(uint8(engine.previewAccount(2).status), uint8(MarginMath.Status.BELOW_MM));
        uint32 bidOrder = _post(3, true, 510, 400_000);
        vm.prank(KEEPER);
        RiskLiquidation.LiquidationResult memory result = engine.liquidate(1, 1_000_000, 8, 2);
        assertEq(result.pairedLots, 600_000);
        assertEq(result.bookLots, 0);
        assertEq(uint8(result.result), uint8(LiquidationMath.Result.DONE));
        assertEq(_lots(1), 400_000);
        assertEq(_lots(2), 0);
        assertEq(_lots(3), 0);
        assertEq(engine.getOrder(bidOrder).size, 400_000);
        assertEq(uint8(engine.previewAccount(1).status), uint8(MarginMath.Status.HEALTHY));
        _assertAccounting();
    }

    function testForcedReductionStopsOnceFirstBookFillRestoresHealth() public {
        _openLong();
        _advance(uint64(block.timestamp) + 20 minutes, 55e16);
        _advance(uint64(block.timestamp) + 20 minutes, 52e16);
        _advance(uint64(block.timestamp) + 20 minutes, 52e16);
        assertEq(uint8(engine.previewAccount(1).status), uint8(MarginMath.Status.BELOW_MM));
        uint32 firstBid = _post(3, true, 650, 300_000);
        uint32 secondBid = _post(4, true, 600, 1_000_000);
        vm.prank(KEEPER);
        RiskLiquidation.LiquidationResult memory result = engine.liquidate(1, 1_000_000, 8, 0);
        assertEq(result.bookLots, 300_000);
        assertEq(uint8(result.result), uint8(LiquidationMath.Result.DONE));
        assertEq(engine.getOrder(firstBid).size, 0);
        assertEq(engine.getOrder(secondBid).size, 1_000_000);
        assertEq(_lots(1), 700_000);
        assertEq(_lots(3), 300_000);
        assertEq(_lots(4), 0);
        assertEq(uint8(engine.previewAccount(1).status), uint8(MarginMath.Status.HEALTHY));
        _assertEmptyReservation(1);
        _assertAccounting();
    }

    function testRealBookTradeSettlesAndPaysRealVaultClaims() public {
        _openLong();
        oracle.haltEarly();
        assertTrue(oracle.finalize(1));
        assertFalse(engine.claimsEnabled());
        while (!engine.prepareSnapshotChunk(1).done) {}
        while (!engine.preparePayoutChunk(1).done) {}
        assertTrue(engine.finishPreparation());
        assertEq(engine.settlementPriceWad(), 1e18);
        assertEq(engine.traderAtoms(_trader(1)), 520e6);
        assertEq(engine.traderAtoms(_trader(2)), 0);
        for (uint32 traderId = 1; traderId <= 5; ++traderId) {
            address owner = _trader(traderId);
            uint256 claimAtoms = engine.traderAtoms(owner);
            if (claimAtoms == 0) continue;
            uint256 balanceBefore = token.balanceOf(owner);
            assertEq(engine.claimTrader(owner), claimAtoms);
            assertEq(token.balanceOf(owner) - balanceBefore, claimAtoms);
            assertTrue(engine.traderClaimed(owner));
        }
        assertTrue(engine.anyCashClaim());
        assertTrue(engine.allTraderClaimsPaid());
        assertEq(engine.unpaidTraderClaims(), 0);
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
        assertEq(
            vault.marketAtoms(address(engine)) * ATOM_Q - vault.marketDebitQ(address(engine)),
            engine.allocationQ()
        );
    }
}
