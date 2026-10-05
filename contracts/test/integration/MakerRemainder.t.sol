pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../../src/Book.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {RealBookEngine} from "./RealBookIntegration.t.sol";
import {RiskFixture} from "../math/B/B011.t.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../risk/B/B019.t.sol";

contract MakerRemainderTest is Test {
    uint256 constant USDC_Q = 1e24;
    uint64 constant LISTED_AT = 1_000_000;
    address constant GOVERNOR = address(0x60);
    address constant TREASURY = address(0x777);

    RealBookEngine engine;
    CollateralVault vault;
    MockUSDC token;
    MockResolutionAuthority oracle;

    function setUp() public {
        _deploy(0);
    }

    function _deploy(uint256 feeWad) internal {
        vm.warp(LISTED_AT);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        oracle = new MockResolutionAuthority();
        IMarketConfig.Listing memory listing =
            ListingFixture.make(LISTED_AT, address(oracle), address(0x30), GOVERNOR, address(0x51));
        listing.scheduledT = LISTED_AT + 29 days + 12 hours;
        listing.token = address(token);
        listing.deploymentCapX = 5;
        engine = new RealBookEngine(vault, TREASURY, listing, RiskFixture.profile(5, true), feeWad);
        vault.registerEngine(address(engine));
        oracle.bind(engine);
        for (uint32 traderId = 1; traderId <= 5; ++traderId) {
            address owner = _trader(traderId);
            token.mint(owner, 2000e6);
            vm.startPrank(owner);
            token.approve(address(vault), 2000e6);
            vault.deposit(2000e6);
            vault.allocate(address(engine), 2000e6, false);
            vm.stopPrank();
        }
        vm.prank(GOVERNOR);
        engine.activateMarket();
        vm.warp(LISTED_AT + 12 hours);
        engine.feed(uint64(block.timestamp - 990), uint64(block.timestamp), 6e17, 59e16, 61e16);
        engine.beginRollover();
        while (!engine.rollPage(32)) {}
        engine.finishRollover();
    }

    function _trader(uint32 traderId) internal pure returns (address) {
        return address(uint160(0x1000 + traderId));
    }

    function _order(uint32 traderId, bool buy, bool reduceOnly, uint16 tick, uint64 lots, bool rests)
        internal
        returns (uint32)
    {
        vm.prank(_trader(traderId));
        return engine.placeOrder(
            Book.Place(
                rests ? IBookRiskHooks.OrderKind.POST_ONLY : IBookRiskHooks.OrderKind.IOC,
                buy,
                reduceOnly,
                tick,
                lots,
                8,
                0
            )
        );
    }

    function _open() internal {
        _order(2, false, false, 600, 1_000_000, true);
        _order(1, true, false, 600, 1_000_000, false);
        assertEq(_lots(1), 1_000_000);
        assertEq(_lots(2), -1_000_000);
    }

    function _lots(uint32 traderId) internal view returns (int256) {
        return engine.account(_trader(traderId)).value.lots;
    }

    function _version(uint32 traderId) internal view returns (uint64) {
        return engine.account(_trader(traderId)).positionVersion;
    }

    function _assertConservation() internal view {
        (int128 reserveLots, int256 reserveCash) = engine.reserve();
        int256 totalLots = reserveLots;
        int256 totalCash = reserveCash;
        for (uint32 traderId = 1; traderId <= 5; ++traderId) {
            RiskStorage.Account memory account = engine.account(_trader(traderId));
            totalLots += account.value.lots;
            totalCash += account.value.cashQ;
        }
        assertEq(totalLots, 0);
        assertEq(
            totalCash + int256(engine.protocolFeeQ() + engine.keeperPayableQ()) + engine.fundingClearingQ(),
            int256(engine.allocationQ())
        );
        assertEq(vault.recognizedAtoms(), 10_000e6);
        assertEq(token.balanceOf(address(vault)), 10_000e6);
        (int256 noSlack, int256 yesSlack) = engine.coverageSlacks();
        assertGe(noSlack, 0);
        assertGe(yesSlack, 0);
    }

    function testLongMakerRemainderFillsAcrossIndependentTakers() public {
        _open();
        uint32 makerOrder = _order(1, false, true, 600, 500_000, true);
        uint64 beforeVersion = _version(1);
        _order(3, true, false, 600, 250_000, false);
        assertEq(engine.getOrder(makerOrder).reduceVersion, beforeVersion + 1);
        assertEq(engine.getOrder(makerOrder).size, 250_000);
        _order(4, true, false, 600, 250_000, false);
        assertEq(_lots(1), 500_000);
        assertEq(_lots(4), 250_000);
        assertEq(engine.getOrder(makerOrder).size, 0);
        assertEq(_version(1), beforeVersion + 2);
        assertEq(engine.account(_trader(1)).value.cashQ, 1700 * int256(USDC_Q));
        assertEq(engine.account(_trader(1)).orders.askLots, 0);
        _assertConservation();
    }

    function testShortMakerRemainderFillsAcrossIndependentTakers() public {
        _open();
        uint32 makerOrder = _order(2, true, true, 600, 500_000, true);
        _order(3, false, false, 600, 250_000, false);
        assertEq(engine.getOrder(makerOrder).reduceVersion, _version(2));
        _order(4, false, false, 600, 250_000, false);
        assertEq(_lots(2), -500_000);
        assertEq(_lots(4), -250_000);
        assertEq(engine.account(_trader(2)).value.cashQ, 2300 * int256(USDC_Q));
        assertEq(engine.account(_trader(2)).orders.bidLots, 0);
        _assertConservation();
    }

    function testOwnMakerFillDoesNotReviveAnUnrelatedRestingOrder() public {
        _open();
        uint32 unrelated = _order(1, false, true, 610, 100_000, true);
        uint32 filledMaker = _order(1, false, true, 600, 500_000, true);
        uint64 staleVersion = _version(1);
        _order(3, true, false, 600, 250_000, false);
        assertEq(engine.getOrder(filledMaker).reduceVersion, staleVersion + 1);
        assertEq(engine.getOrder(unrelated).reduceVersion, staleVersion);
        _order(4, true, false, 610, 400_000, false);
        assertEq(_lots(4), 250_000);
        assertEq(_lots(1), 500_000);
        assertEq(engine.getOrder(unrelated).size, 0);
        assertEq(engine.account(_trader(1)).orders.askLots, 0);
        _assertConservation();
    }

    function testInterveningUnrelatedTradeStillInvalidatesRefreshedMaker() public {
        _open();
        uint32 makerOrder = _order(1, false, true, 600, 500_000, true);
        _order(3, true, false, 600, 250_000, false);
        uint64 acceptedVersion = engine.getOrder(makerOrder).reduceVersion;
        _order(1, true, false, 500, 10, true);
        _order(5, false, false, 500, 10, false);
        assertEq(_version(1), acceptedVersion + 1);
        _order(4, true, false, 600, 250_000, false);
        assertEq(_lots(1), 750_010);
        assertEq(_lots(4), 0);
        assertEq(engine.getOrder(makerOrder).size, 0);
        _assertConservation();
    }

    function testCloseAndReopenCannotReviveAnOldMakerRemainder() public {
        _open();
        uint32 makerOrder = _order(1, false, true, 600, 500_000, true);
        _order(3, true, false, 600, 250_000, false);
        uint64 acceptedVersion = engine.getOrder(makerOrder).reduceVersion;
        _order(5, true, false, 590, 750_000, true);
        _order(1, false, true, 590, 750_000, false);
        assertEq(_lots(1), 0);
        _order(5, false, false, 590, 100_000, true);
        _order(1, true, false, 590, 100_000, false);
        assertEq(_version(1), acceptedVersion + 2);
        _order(4, true, false, 600, 250_000, false);
        assertEq(_lots(1), 100_000);
        assertEq(_lots(4), 0);
        assertEq(engine.getOrder(makerOrder).size, 0);
        _assertConservation();
    }

    function testAccountEpochInvalidationCannotDebitFreshReservation() public {
        _open();
        uint32 oldMaker = _order(1, false, true, 600, 500_000, true);
        _order(3, true, false, 600, 250_000, false);
        vm.prank(_trader(1));
        engine.cancelAll();
        uint32 freshMaker = _order(1, false, true, 610, 100_000, true);
        assertGt(engine.getOrder(freshMaker).accountEpoch, engine.getOrder(oldMaker).accountEpoch);
        _order(4, true, false, 610, 350_000, false);
        assertEq(_lots(1), 650_000);
        assertEq(_lots(4), 100_000);
        assertEq(engine.getOrder(oldMaker).size, 0);
        assertEq(engine.getOrder(freshMaker).size, 0);
        assertEq(engine.account(_trader(1)).orders.askLots, 0);
        _assertConservation();
    }

    function testMarketHaltInvalidatesRefreshedNodeAndPreventsFurtherFills() public {
        _open();
        uint32 makerOrder = _order(1, false, true, 600, 500_000, true);
        _order(3, true, false, 600, 250_000, false);
        uint64 oldEpoch = engine.getOrder(makerOrder).marketEpoch;
        oracle.haltEarly();
        assertGt(engine.marketOrderEpoch(), oldEpoch);
        _order(4, true, false, 600, 250_000, false);
        assertEq(_lots(1), 750_000);
        assertEq(_lots(4), 0);
        vm.prank(_trader(1));
        engine.cancel(makerOrder);
        assertEq(engine.getOrder(makerOrder).size, 0);
        _assertConservation();
    }

    function testPartialMakerFeeReservationSurvivesRepeatedFillsThenCancelsExactly() public {
        _deploy(1e15);
        _open();
        uint32 makerOrder = _order(1, false, true, 600, 500_000, true);
        assertEq(engine.getOrder(makerOrder).feeCapQ, 300_000_000 * uint256(1e15));
        _order(3, true, false, 600, 250_000, false);
        _order(4, true, false, 600, 125_000, false);
        assertEq(engine.getOrder(makerOrder).size, 125_000);
        assertEq(engine.getOrder(makerOrder).feeCapQ, 75_000_000 * uint256(1e15));
        assertEq(engine.account(_trader(1)).orders.feeCapQ, 75_000_000 * uint256(1e15));
        assertEq(engine.protocolFeeQ(), 825_000_000 * uint256(1e15));
        vm.prank(_trader(1));
        engine.cancel(makerOrder);
        assertEq(engine.account(_trader(1)).orders.askLots, 0);
        assertEq(engine.account(_trader(1)).orders.feeCapQ, 0);
        _assertConservation();
    }

    function testRefreshedMakerClosesAtFlatWithoutFlipping() public {
        _open();
        uint32 makerOrder = _order(1, false, true, 600, 1_000_000, true);
        _order(3, true, false, 600, 400_000, false);
        _order(4, true, false, 600, 800_000, false);
        assertEq(_lots(1), 0);
        assertEq(_lots(4), 600_000);
        assertEq(engine.getOrder(makerOrder).size, 0);
        assertEq(engine.account(_trader(1)).orders.askLots, 0);
        _assertConservation();
    }

    function testSlotReuseDoesNotCarryAcceptedVersionOrAuthorizeOldId() public {
        _open();
        uint32 oldMaker = _order(1, false, true, 600, 500_000, true);
        _order(3, true, false, 600, 250_000, false);
        vm.prank(_trader(1));
        engine.cancel(oldMaker);
        uint32 freshMaker = _order(1, false, true, 610, 100_000, true);
        assertEq(oldMaker & 0xFFFFFF, freshMaker & 0xFFFFFF);
        assertTrue(oldMaker != freshMaker);
        assertEq(engine.getOrder(freshMaker).reduceVersion, _version(1));
        vm.prank(_trader(1));
        vm.expectRevert(Book.NotLive.selector);
        engine.cancel(oldMaker);
        assertEq(engine.getOrder(freshMaker).size, 100_000);
        assertEq(engine.account(_trader(1)).orders.askLots, 100_000);
        _assertConservation();
    }

    function testSecondPostingFailureRollsBackPartialMakerVersionAndEveryLedger() public {
        _deploy(1e15);
        _open();
        uint32 makerOrder = _order(1, false, true, 600, 500_000, true);
        bytes32 beforeOrder = keccak256(abi.encode(engine.getOrder(makerOrder)));
        bytes32 beforeMaker = keccak256(abi.encode(engine.account(_trader(1))));
        bytes32 beforeTaker = keccak256(abi.encode(engine.account(_trader(3))));
        bytes32 beforeLevel = keccak256(abi.encode(engine.getLevel(false, 600)));
        uint256 beforeFees = engine.protocolFeeQ();
        uint64 beforeVersion = _version(1);
        Book.Place[] memory orders = new Book.Place[](2);
        orders[0] = Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 600, 150_000, 8, 0);
        orders[1] = orders[0];
        engine.failOnPosting(2);
        vm.prank(_trader(3));
        vm.expectRevert(RealBookEngine.InjectedAccountingFailure.selector);
        engine.batch(new uint32[](0), orders);
        assertEq(keccak256(abi.encode(engine.getOrder(makerOrder))), beforeOrder);
        assertEq(keccak256(abi.encode(engine.account(_trader(1)))), beforeMaker);
        assertEq(keccak256(abi.encode(engine.account(_trader(3)))), beforeTaker);
        assertEq(keccak256(abi.encode(engine.getLevel(false, 600))), beforeLevel);
        assertEq(engine.protocolFeeQ(), beforeFees);
        assertEq(engine.postings(), 0);
        _assertConservation();
        engine.failOnPosting(0);
        vm.prank(_trader(3));
        engine.batch(new uint32[](0), orders);
        assertEq(engine.getOrder(makerOrder).size, 200_000);
        assertEq(engine.getOrder(makerOrder).reduceVersion, beforeVersion + 2);
        assertEq(_lots(1), 700_000);
        assertEq(_lots(3), 300_000);
        _assertConservation();
    }
}
