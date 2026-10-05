pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../../../src/Book.sol";
import {RealBookEngine} from "../../integration/RealBookIntegration.t.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {OrderAdmissionMath} from "../../../src/math/OrderAdmissionMath.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {RiskStorage} from "../../../src/risk/RiskStorage.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {MockUSDC} from "../../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../../risk/B/B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract RealBookInvariantEngine is RealBookEngine {
    bool public constant IS_TEST = true;

    constructor(
        CollateralVault collateral,
        address treasury,
        IMarketConfig.Listing memory marketListing,
        MarginMath.RiskParams memory parameters
    ) RealBookEngine(collateral, treasury, marketListing, parameters, 1e15) {}

    function auditOrders() external view returns (Book.Order[] memory orders, uint32 freeHead) {
        return (_book.orders, _book.freeHead);
    }

    function auditSlot(uint256 slot) external view returns (Book.Order memory order, uint32 orderId) {
        order = _book.orders[slot];
        orderId = _id(uint32(slot), order.gen);
    }

    function auditSlotCount() external view returns (uint256) {
        return _book.orders.length;
    }

    function auditBitmaps() external view returns (uint256[4][2] memory) {
        return _book.bits;
    }

    function auditReservations(uint32 traderId)
        external
        view
        returns (OrderAdmissionMath.OrderSums memory resting, OrderAdmissionMath.OrderSums memory permit)
    {
        return (_resSums(traderId), _permit[traderId]);
    }
}

contract RealBookInvariantHandler is Test {
    uint32 public constant TRADERS = 6;
    uint256 public constant MAX_SLOTS = 96;
    RealBookInvariantEngine public engine;
    CollateralVault public vault;
    MockUSDC public token;
    uint64 public lastFeed;
    uint256 public actions;
    uint256 public effectiveFills;
    uint256 public restedOrders;
    uint256 public cancelledOrders;
    uint256 public rollovers;
    uint256 public allocations;
    uint256 public releases;
    mapping(uint32 => bool) public issued;

    struct FundingCheckpoint {
        uint64 epochId;
        int256 index;
        uint256 budget;
        bool stopped;
    }

    constructor(RealBookInvariantEngine market, CollateralVault collateral, MockUSDC asset, uint64 feedTime) {
        engine = market;
        vault = collateral;
        token = asset;
        lastFeed = feedTime;
        for (uint256 slot = 1; slot < engine.auditSlotCount(); ++slot) {
            (, uint32 orderId) = engine.auditSlot(slot);
            issued[orderId] = true;
        }
    }

    modifier checkedAction() {
        FundingCheckpoint memory checkpoint;
        (checkpoint.epochId,,,,,, checkpoint.stopped) = engine.epoch();
        checkpoint.index = engine.fundingFQ();
        checkpoint.budget = engine.fundingBudgetQ();
        ++actions;
        _;
        (uint64 currentEpoch,,,,,,) = engine.epoch();
        if (currentEpoch == checkpoint.epochId) {
            assertLe(engine.fundingBudgetQ(), checkpoint.budget, "no intra-epoch authorization");
            if (checkpoint.stopped) assertEq(engine.fundingFQ(), checkpoint.index, "stopped funding");
        }
    }

    function ownerOf(uint32 traderId) public pure returns (address) {
        return address(uint160(0x1000 + traderId));
    }

    function _actor(uint256 seed) private pure returns (uint32) {
        return uint32(seed % TRADERS) + 1;
    }

    function _positionFingerprint() private view returns (bytes32 fingerprint) {
        (int128 reservePosition,) = engine.reserve();
        fingerprint = keccak256(abi.encode(reservePosition));
        for (uint32 traderId = 1; traderId <= TRADERS; ++traderId) {
            fingerprint = keccak256(abi.encode(fingerprint, engine.account(ownerOf(traderId)).value.lots));
        }
    }

    function _request(uint256 seed) private view returns (Book.Place memory request) {
        request.kind = IBookRiskHooks.OrderKind(seed % 3);
        if (engine.auditSlotCount() >= MAX_SLOTS) request.kind = IBookRiskHooks.OrderKind.IOC;
        request.isBuy = (seed >> 8) % 2 == 0;
        request.reduceOnly = (seed >> 10) % 4 == 0;
        request.tick = uint16(590 + (seed >> 16) % 61);
        request.size = uint64(1 + (seed >> 32) % 200_000);
        request.maxFills = uint8(1 + (seed >> 56) % 8);
        if ((seed >> 64) % 4 == 0) request.expiryBlock = uint32(block.number + (seed >> 72) % 4);
    }

    function _record(uint32 orderId) private {
        if (orderId == 0) return;
        assertFalse(issued[orderId], "public order id reused");
        issued[orderId] = true;
        ++restedOrders;
    }

    function placeOrder(uint256 actorSeed, uint256 orderSeed) external checkedAction {
        Book.Place[] memory requests = new Book.Place[](1);
        requests[0] = _request(orderSeed);
        uint256 postingsBefore = engine.postings();
        vm.prank(ownerOf(_actor(actorSeed)));
        uint32[] memory orderIds = engine.batch(new uint32[](0), requests);
        _record(orderIds[0]);
        effectiveFills += engine.postings() - postingsBefore;
    }

    function requote(uint256 actorSeed, uint256 firstSeed, uint256 secondSeed) external checkedAction {
        uint32 traderId = _actor(actorSeed);
        uint32[] memory cancellations = new uint32[](2);
        uint256 count;
        for (uint256 slot = 1; slot < engine.auditSlotCount() && count < 2; ++slot) {
            (Book.Order memory order, uint32 orderId) = engine.auditSlot(slot);
            if (order.size != 0 && order.owner == traderId) cancellations[count++] = orderId;
        }
        Book.Place[] memory requests = new Book.Place[](2);
        requests[0] = _request(firstSeed);
        requests[1] = _request(secondSeed);
        uint256 postingsBefore = engine.postings();
        vm.prank(ownerOf(traderId));
        uint32[] memory orderIds = engine.batch(cancellations, requests);
        for (uint256 index; index < orderIds.length; ++index) {
            _record(orderIds[index]);
        }
        effectiveFills += engine.postings() - postingsBefore;
        cancelledOrders += count;
    }

    function cancelOrder(uint256 slotSeed) external checkedAction {
        bytes32 positionsBefore = _positionFingerprint();
        uint256 count = engine.auditSlotCount();
        if (count > 1) {
            (Book.Order memory order, uint32 orderId) = engine.auditSlot(1 + slotSeed % (count - 1));
            if (order.size != 0) {
                vm.prank(ownerOf(order.owner));
                engine.cancel(orderId);
                ++cancelledOrders;
            }
        }
        assertEq(_positionFingerprint(), positionsBefore, "cancel changes position");
    }

    function cancelAllOrders(uint256 actorSeed) external checkedAction {
        bytes32 positionsBefore = _positionFingerprint();
        vm.prank(ownerOf(_actor(actorSeed)));
        engine.cancelAll();
        assertEq(_positionFingerprint(), positionsBefore, "cancel-all changes position");
    }

    function allocate(uint256 actorSeed, uint256 amountSeed) external checkedAction {
        bytes32 positionsBefore = _positionFingerprint();
        address owner = ownerOf(_actor(actorSeed));
        uint256 atoms = 1 + amountSeed % 100e6;
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(engine), atoms, false);
        vm.stopPrank();
        ++allocations;
        assertEq(_positionFingerprint(), positionsBefore, "allocation changes position");
    }

    function release(uint256 actorSeed, uint256 amountSeed) external checkedAction {
        bytes32 positionsBefore = _positionFingerprint();
        uint32 traderId = _actor(actorSeed);
        uint256 available = engine.previewAccount(traderId).usableReleaseAtoms;
        if (available != 0) {
            uint256 limit = available < 100e6 ? available : 100e6;
            uint256 atoms = 1 + amountSeed % limit;
            vm.prank(ownerOf(traderId));
            engine.release(atoms);
            ++releases;
        }
        assertEq(_positionFingerprint(), positionsBefore, "release changes position");
    }

    function advanceTime(uint256 secondsSeed, bool refresh) external checkedAction {
        bytes32 positionsBefore = _positionFingerprint();
        uint64 timestamp = uint64(block.timestamp + 900 + secondsSeed % 301);
        vm.warp(timestamp);
        vm.roll(block.number + 1 + secondsSeed % 4);
        if (refresh) {
            uint64 from = timestamp - 990 > lastFeed + 10 ? timestamp - 990 : lastFeed + 10;
            engine.feed(from, timestamp, 6e17, 61e16, 63e16);
            lastFeed = timestamp - ((timestamp - from) % 10);
        }
        (,, uint64 epochEnd,,,,) = engine.epoch();
        if (timestamp >= epochEnd) {
            engine.beginRollover();
            bool complete;
            for (uint256 page; page < TRADERS && !complete; ++page) {
                complete = engine.rollPage(2);
            }
            assertTrue(complete, "bounded rollover progresses");
            engine.finishRollover();
            ++rollovers;
        }
        assertEq(_positionFingerprint(), positionsBefore, "time or sweep changes position");
    }
}

contract RealBookInvariantsTest is Test {
    uint256 private constant ATOM_Q = 1e18;
    uint64 private constant LISTED_AT = 1_000_000;
    uint32 private constant TRADERS = 6;
    address private constant GOVERNOR = address(0x60);
    address private constant RESERVE_PROVIDER = address(0xCAFE);
    address private constant TREASURY = address(0x777);

    RealBookInvariantEngine private engine;
    RealBookInvariantHandler private handler;
    CollateralVault private vault;
    MockUSDC private token;
    MockResolutionAuthority private oracle;

    function setUp() public {
        vm.warp(LISTED_AT);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        oracle = new MockResolutionAuthority();
        IMarketConfig.Listing memory marketListing =
            ListingFixture.make(LISTED_AT, address(oracle), address(0x30), GOVERNOR, address(0x51));
        marketListing.token = address(token);
        marketListing.scheduledT = LISTED_AT + 29 days + 12 hours;
        engine = new RealBookInvariantEngine(vault, TREASURY, marketListing, RiskFixture.profile(5, true));
        vault.registerEngine(address(engine));
        oracle.bind(engine);
        _fund(RESERVE_PROVIDER, 100_000e6, true);
        for (uint32 traderId = 1; traderId <= TRADERS; ++traderId) {
            _fund(_owner(traderId), traderId == 1 ? 125e6 : 1000e6, false);
        }
        vm.prank(GOVERNOR);
        engine.activateMarket();
        uint64 opening = LISTED_AT + 12 hours;
        vm.warp(opening);
        engine.feed(opening - 990, opening, 6e17, 61e16, 63e16);
        _roll();
        vm.prank(_owner(2));
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, 600, 1_000_000, 8, 0));
        vm.prank(_owner(1));
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 600, 1_000_000, 8, 0));
        assertEq(engine.account(_owner(1)).value.lots, 1_000_000, "non-vacuous real fill");
        handler = new RealBookInvariantHandler(engine, vault, token, opening);
        handler.advanceTime(300, true);
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.placeOrder.selector;
        selectors[1] = handler.requote.selector;
        selectors[2] = handler.cancelOrder.selector;
        selectors[3] = handler.cancelAllOrders.selector;
        selectors[4] = handler.allocate.selector;
        selectors[5] = handler.release.selector;
        selectors[6] = handler.advanceTime.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _owner(uint32 traderId) private pure returns (address) {
        return address(uint160(0x1000 + traderId));
    }

    function _fund(address owner, uint256 atoms, bool reserveAllocation) private {
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(engine), atoms, reserveAllocation);
        vm.stopPrank();
    }

    function _roll() private {
        engine.beginRollover();
        bool complete;
        for (uint256 page; page < TRADERS && !complete; ++page) {
            complete = engine.rollPage(2);
        }
        assertTrue(complete);
        engine.finishRollover();
    }

    function invariantPositionsOiAndLedgerConserve() public view {
        (int128 reservePosition, int256 reserveCash) = engine.reserve();
        int256 netPosition = reservePosition;
        int256 totalCash = reserveCash;
        uint256 positivePositions = reservePosition > 0 ? uint256(uint128(reservePosition)) : 0;
        for (uint32 traderId = 1; traderId <= TRADERS; ++traderId) {
            RiskStorage.Account memory account = engine.account(_owner(traderId));
            netPosition += account.value.lots;
            totalCash += account.value.cashQ;
            if (account.value.lots > 0) positivePositions += uint256(uint128(account.value.lots));
        }
        assertEq(netPosition, 0);
        assertEq(engine.oiAllLots(), positivePositions);
        assertEq(
            totalCash + int256(engine.protocolFeeQ() + engine.keeperPayableQ()) + engine.fundingClearingQ(),
            int256(engine.allocationQ())
        );
    }

    function invariantCustodyAndCoverageRemainExact() public view {
        uint256 freeAtoms = vault.freeAtoms(RESERVE_PROVIDER);
        for (uint32 traderId = 1; traderId <= TRADERS; ++traderId) {
            freeAtoms += vault.freeAtoms(_owner(traderId));
        }
        assertEq(vault.recognizedAtoms() * ATOM_Q, freeAtoms * ATOM_Q + engine.allocationQ());
        assertEq(token.balanceOf(address(vault)), vault.recognizedAtoms());
        assertEq(
            vault.marketAtoms(address(engine)) * ATOM_Q - vault.marketDebitQ(address(engine)),
            engine.allocationQ()
        );
        (int128 reservePosition, int256 reserveCash) = engine.reserve();
        int256 noSlack =
            reserveCash - int256(engine.deficitSum0() + engine.fundingCushionQ() + engine.fundingBudgetQ());
        int256 yesSlack = reserveCash + int256(reservePosition) * 1000 * int256(ATOM_Q)
            - int256(engine.deficitSum1() + engine.fundingCushionQ() + engine.fundingBudgetQ());
        assertGe(noSlack, 0);
        assertGe(yesSlack, 0);
        (int256 storedNo, int256 storedYes) = engine.coverageSlacks();
        assertEq(storedNo, noSlack);
        assertEq(storedYes, yesSlack);
    }

    function invariantDeficitsAndFundingCushionMatchAccounts() public view {
        uint256 noDeficits;
        uint256 yesDeficits;
        uint256 payerFunding;
        for (uint32 traderId = 1; traderId <= TRADERS; ++traderId) {
            RiskStorage.Account memory account = engine.account(_owner(traderId));
            int256 netCash = account.value.cashQ - int256(account.orders.feeCapQ);
            int256 noDeficit = int256(account.orders.bidValueQ) - netCash;
            int256 yesDeficit = -netCash - int256(account.value.lots) * 1000 * int256(ATOM_Q)
                + int256(uint256(account.orders.askLots) * 1000 * ATOM_Q) - int256(account.orders.askValueQ);
            assertEq(account.deficit0, noDeficit > 0 ? uint256(noDeficit) : 0);
            assertEq(account.deficit1, yesDeficit > 0 ? uint256(yesDeficit) : 0);
            noDeficits += account.deficit0;
            yesDeficits += account.deficit1;
            int256 pendingFunding =
                int256(account.value.lots) * (engine.fundingFQ() - account.fundingCheckpoint);
            if (pendingFunding > 0) payerFunding += uint256(pendingFunding);
        }
        assertEq(engine.deficitSum0(), noDeficits);
        assertEq(engine.deficitSum1(), yesDeficits);
        assertEq(engine.fundingCushionQ(), payerFunding);
    }

    function invariantCurrentBookReservationsMatchBothAccountingLanes() public view {
        (Book.Order[] memory orders,) = engine.auditOrders();
        uint64 marketEpoch = engine.marketOrderEpoch();
        for (uint32 traderId = 1; traderId <= TRADERS; ++traderId) {
            RiskStorage.Account memory account = engine.account(_owner(traderId));
            OrderAdmissionMath.OrderSums memory expected;
            for (uint256 slot = 1; slot < orders.length; ++slot) {
                Book.Order memory order = orders[slot];
                if (
                    order.size == 0 || order.owner != traderId || order.marketEpoch != marketEpoch
                        || order.accountEpoch != account.orderEpoch
                ) continue;
                if (order.flags & engine.FLAG_BUY() != 0) {
                    expected.bidLots += order.size;
                    expected.bidValueQ += uint256(order.size) * order.tick * ATOM_Q;
                } else {
                    expected.askLots += order.size;
                    expected.askValueQ += uint256(order.size) * order.tick * ATOM_Q;
                }
                expected.feeCapQ += order.feeCapQ;
            }
            (OrderAdmissionMath.OrderSums memory resting, OrderAdmissionMath.OrderSums memory permit) =
                engine.auditReservations(traderId);
            assertEq(resting.bidLots, expected.bidLots);
            assertEq(resting.bidValueQ, expected.bidValueQ);
            assertEq(resting.askLots, expected.askLots);
            assertEq(resting.askValueQ, expected.askValueQ);
            assertEq(resting.feeCapQ, expected.feeCapQ);
            assertEq(account.orders.bidLots, expected.bidLots);
            assertEq(account.orders.bidValueQ, expected.bidValueQ);
            assertEq(account.orders.askLots, expected.askLots);
            assertEq(account.orders.askValueQ, expected.askValueQ);
            assertEq(account.orders.feeCapQ, expected.feeCapQ);
            assertEq(permit.bidLots + permit.askLots, 0);
            assertEq(permit.bidValueQ + permit.askValueQ + permit.feeCapQ, 0);
        }
    }

    function invariantBookTopologyAndBestPricesMatchPhysicalOrders() public view {
        (Book.Order[] memory orders, uint32 freeHead) = engine.auditOrders();
        bool[] memory visited = new bool[](orders.length);
        bool[2000] memory checkedLevel;
        uint16 bestBid;
        uint16 bestAsk;
        for (uint256 slot = 1; slot < orders.length; ++slot) {
            Book.Order memory order = orders[slot];
            if (order.size == 0) continue;
            assertTrue(order.flags & engine.FLAG_LIVE() != 0);
            assertGe(order.owner, 1);
            assertLe(order.owner, TRADERS);
            assertGe(order.tick, 1);
            assertLe(order.tick, 999);
            bool isBuy = order.flags & engine.FLAG_BUY() != 0;
            if (isBuy && order.tick > bestBid) bestBid = order.tick;
            if (!isBuy && (bestAsk == 0 || order.tick < bestAsk)) bestAsk = order.tick;
            uint256 levelIndex = uint256(order.tick) * 2 + (isBuy ? 1 : 0);
            if (checkedLevel[levelIndex]) continue;
            checkedLevel[levelIndex] = true;
            _assertLevel(orders, visited, isBuy, order.tick);
        }
        _assertGeneratedLevelsAndBitmaps(orders);
        uint32 freeSlot = freeHead;
        for (uint256 step; freeSlot != 0 && step < orders.length; ++step) {
            assertLt(freeSlot, orders.length);
            assertFalse(visited[freeSlot], "free-list cycle or live slot");
            visited[freeSlot] = true;
            assertEq(orders[freeSlot].size, 0);
            assertEq(orders[freeSlot].flags, 0);
            assertLt(orders[freeSlot].gen, type(uint8).max);
            freeSlot = orders[freeSlot].next;
        }
        assertEq(freeSlot, 0, "bounded free-list traversal");
        for (uint256 slot = 1; slot < orders.length; ++slot) {
            if (orders[slot].size == 0 && orders[slot].gen == type(uint8).max) continue;
            assertTrue(visited[slot], "orphaned order slot");
        }
        (uint16 actualBid, uint16 actualAsk) = engine.bestBidAsk();
        assertEq(actualBid, bestBid);
        assertEq(actualAsk, bestAsk);
        if (bestBid != 0 && bestAsk != 0) assertLt(bestBid, bestAsk, "uncrossed book");
    }

    function _assertGeneratedLevelsAndBitmaps(Book.Order[] memory orders) private view {
        uint256[61][2] memory levelLots;
        uint256[4][2] memory expectedBits;
        for (uint256 side; side < 2; ++side) {
            for (uint256 word; word < 4; ++word) {
                expectedBits[side][word] = uint256(1) << 255;
            }
        }
        for (uint256 slot = 1; slot < orders.length; ++slot) {
            Book.Order memory order = orders[slot];
            if (order.size == 0) continue;
            assertGe(order.tick, 590);
            assertLe(order.tick, 650);
            uint256 sideIndex = order.flags & engine.FLAG_BUY() != 0 ? 1 : 0;
            levelLots[sideIndex][order.tick - 590] += order.size;
            expectedBits[sideIndex][(order.tick - 1) / 250] |= uint256(1) << ((order.tick - 1) % 250);
        }
        uint256[4][2] memory actualBits = engine.auditBitmaps();
        for (uint256 side; side < 2; ++side) {
            for (uint256 word; word < 4; ++word) {
                assertEq(actualBits[side][word], expectedBits[side][word]);
            }
            for (uint16 offset; offset < 61; ++offset) {
                Book.Level memory level = engine.getLevel(side == 1, 590 + offset);
                assertEq(level.size, levelLots[side][offset], "all generated level sizes");
                if (levelLots[side][offset] == 0) {
                    assertEq(level.head, 0, "empty level head");
                    assertEq(level.tail, 0, "empty level tail");
                }
            }
        }
    }

    function _assertLevel(Book.Order[] memory orders, bool[] memory visited, bool isBuy, uint16 tick)
        private
        view
    {
        Book.Level memory level = engine.getLevel(isBuy, tick);
        uint32 previous;
        uint32 current = level.head;
        uint256 totalLots;
        for (uint256 step; current != 0 && step < orders.length; ++step) {
            assertLt(current, orders.length);
            assertFalse(visited[current], "duplicate or cyclic live order");
            visited[current] = true;
            Book.Order memory order = orders[current];
            assertGt(order.size, 0);
            assertEq(order.prev, previous);
            assertEq(order.tick, tick);
            assertEq(order.flags & engine.FLAG_BUY() != 0, isBuy);
            totalLots += order.size;
            previous = current;
            current = order.next;
        }
        assertEq(current, 0, "bounded live-level traversal");
        assertEq(previous, level.tail);
        assertEq(totalLots, level.size);
    }

    function _checkAll() private view {
        invariantPositionsOiAndLedgerConserve();
        invariantCustodyAndCoverageRemainExact();
        invariantDeficitsAndFundingCushionMatchAccounts();
        invariantCurrentBookReservationsMatchBothAccountingLanes();
        invariantBookTopologyAndBestPricesMatchPhysicalOrders();
    }

    function testFuzzExactPartialFillFeesAndCancellation(uint64 requestedLots, uint64 requestedFill) public {
        uint64 lots = uint64(bound(requestedLots, 2, 100_000));
        uint64 fill = uint64(bound(requestedFill, 1, lots - 1));
        int256 makerCash = engine.account(_owner(5)).value.cashQ;
        int256 takerCash = engine.account(_owner(6)).value.cashQ;
        uint256 protocolBefore = engine.protocolFeeQ();
        vm.prank(_owner(5));
        uint32 orderId =
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, 620, lots, 8, 0));
        assertGt(orderId, 0);
        vm.prank(_owner(6));
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 620, fill, 8, 0));
        uint256 notional = uint256(fill) * 620 * ATOM_Q;
        uint256 fee = uint256(fill) * 620 * 1e15;
        assertEq(engine.account(_owner(5)).value.cashQ, makerCash + int256(notional));
        assertEq(engine.account(_owner(6)).value.cashQ, takerCash - int256(notional + fee));
        assertEq(engine.protocolFeeQ(), protocolBefore + fee);
        assertEq(engine.getOrder(orderId).size, lots - fill);
        assertEq(engine.getOrder(orderId).feeCapQ, uint256(lots - fill) * 620 * 1e15);
        _checkAll();
        vm.prank(_owner(5));
        engine.cancel(orderId);
        assertEq(engine.account(_owner(5)).orders.askLots, 0);
        assertEq(engine.account(_owner(5)).orders.feeCapQ, 0);
        _checkAll();
    }

    function testRolloverInvalidatesOldBookEpochWithoutReleasingFreshOrders() public {
        vm.prank(_owner(5));
        uint32 oldOrder =
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, 620, 70, 8, 0));
        assertGt(oldOrder, 0);
        uint64 previousEpoch = engine.marketOrderEpoch();
        for (uint256 step; step < 4 && engine.marketOrderEpoch() == previousEpoch; ++step) {
            handler.advanceTime(300, true);
        }
        assertGt(engine.marketOrderEpoch(), previousEpoch);
        _checkAll();
        vm.prank(_owner(5));
        uint32 freshOrder =
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, 630, 90, 8, 0));
        assertGt(freshOrder, 0);
        vm.prank(_owner(5));
        engine.cancel(oldOrder);
        assertEq(engine.account(_owner(5)).orders.askLots, 90);
        assertEq(engine.account(_owner(5)).orders.askValueQ, 90 * 630 * ATOM_Q);
        assertEq(engine.getOrder(freshOrder).size, 90);
        _checkAll();
    }

    function testEightAdditionalFillsPreserveInvariantsAfterEveryAction() public {
        uint256 postingsBefore = engine.postings();
        for (uint16 round; round < 4; ++round) {
            vm.prank(_owner(3));
            uint32 firstOrder = engine.placeOrder(
                Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, 620 + round, 100, 8, 0)
            );
            assertGt(firstOrder, 0);
            _checkAll();
            vm.prank(_owner(5));
            uint32 secondOrder = engine.placeOrder(
                Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, 621 + round, 150, 8, 0)
            );
            assertGt(secondOrder, 0);
            _checkAll();
            vm.prank(_owner(6));
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 621 + round, 250, 8, 0));
            assertEq(engine.getOrder(firstOrder).size, 0);
            assertEq(engine.getOrder(secondOrder).size, 0);
            assertEq(engine.postings(), postingsBefore + (uint256(round) + 1) * 2);
            _checkAll();
        }
        assertEq(engine.account(_owner(3)).value.lots, -400);
        assertEq(engine.account(_owner(5)).value.lots, -600);
        assertEq(engine.account(_owner(6)).value.lots, 1000);
    }

    function afterInvariant() external {
        assertGt(engine.postings(), 0, "real fills exercised");
        emit log_named_uint("real-book actions", handler.actions());
        emit log_named_uint("real-book additional fills", handler.effectiveFills());
        emit log_named_uint("real-book rests", handler.restedOrders());
        emit log_named_uint("real-book cancels", handler.cancelledOrders());
        emit log_named_uint("real-book rollovers", handler.rollovers());
        emit log_named_uint("real-book allocations", handler.allocations());
        emit log_named_uint("real-book releases", handler.releases());
    }
}
