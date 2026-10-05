pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RealBookEngine} from "../integration/RealBookIntegration.t.sol";
import {Book} from "../../src/Book.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {ListingFixture} from "../risk/B/B019.t.sol";
import {RiskFixture} from "../math/B/B011.t.sol";

abstract contract RealBookPolicyReviewBase is Test {
    uint64 internal constant OPENING = 1_000_000;
    address internal constant GOVERNOR = address(0x60);
    address internal constant MONITOR = address(0x30);
    address internal constant MAKER = address(0x1001);
    address internal constant TAKER = address(0x1002);
    address internal constant OTHER = address(0x1003);
    RealBookEngine internal engine;
    CollateralVault internal vault;
    MockUSDC internal token;

    function setUp() public virtual {
        vm.warp(OPENING);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        IMarketConfig.Listing memory configuration =
            ListingFixture.make(OPENING, address(0xAC), MONITOR, GOVERNOR, address(0x51));
        configuration.token = address(token);
        configuration.deploymentCapX = 1;
        configuration.fundingEnabled = false;
        engine = new RealBookEngine(vault, address(0x777), configuration, RiskFixture.profile(1, false), 0);
        vault.registerEngine(address(engine));
        _fund(MAKER);
        _fund(TAKER);
        _fund(OTHER);
        vm.prank(GOVERNOR);
        engine.activateMarket();
    }

    function _fund(address owner) internal {
        token.mint(owner, 100e6);
        vm.startPrank(owner);
        token.approve(address(vault), 100e6);
        vault.deposit(100e6);
        vault.allocate(address(engine), 100e6, false);
        vm.stopPrank();
    }

    function _place(address owner, bool isBuy, uint16 tick, uint64 lots, bool reduceOnly, bool rest)
        internal
        returns (uint32)
    {
        vm.prank(owner);
        return engine.placeOrder(
            Book.Place(
                rest ? IBookRiskHooks.OrderKind.POST_ONLY : IBookRiskHooks.OrderKind.IOC,
                isBuy,
                reduceOnly,
                tick,
                lots,
                8,
                0
            )
        );
    }

    function _indexOnly(uint64 from, uint64 until, uint256 indexWad) internal {
        vm.warp(until);
        engine.feed(from, until, indexWad, 0, 0);
        assertTrue(engine.riskContext().indexOk);
        assertFalse(engine.riskContext().markOk);
    }

    function _assertConservation() internal view {
        int256 cash = engine.account(MAKER).value.cashQ + engine.account(TAKER).value.cashQ
            + engine.account(OTHER).value.cashQ;
        int256 lots = int256(engine.account(MAKER).value.lots) + engine.account(TAKER).value.lots
            + engine.account(OTHER).value.lots;
        assertEq(cash, 300e24);
        assertEq(lots, 0);
        assertEq(engine.protocolFeeQ(), 0);
        assertEq(vault.marketAtoms(address(engine)), 300e6);
        assertEq(token.balanceOf(address(vault)), 300e6);
        (int256 slackNo, int256 slackYes) = engine.coverageSlacks();
        assertGe(slackNo, 0);
        assertGe(slackYes, 0);
    }
}

contract BootstrapPriceBandReviewTest is RealBookPolicyReviewBase {
    function testOldAskOutsideRecoveredIndexBandCannotExecute() public {
        _indexOnly(OPENING - 300, OPENING, 45e16);
        uint32 oldAsk = _place(MAKER, false, 400, 100_000, false, true);
        assertGt(oldAsk, 0);
        _indexOnly(OPENING + 10, OPENING + 300, 51e16);
        assertEq(engine.riskContext().indexWad, 508e15);
        _place(TAKER, true, 510, 100_000, false, false);
        assertEq(engine.account(MAKER).value.lots, 0);
        assertEq(engine.account(TAKER).value.lots, 0);
        assertEq(engine.getOrder(oldAsk).size, 0);
        assertEq(engine.account(MAKER).orders.askLots, 0);
        _assertConservation();
    }

    function testOldBidOutsideRecoveredIndexBandCannotExecute() public {
        _indexOnly(OPENING - 300, OPENING, 55e16);
        uint32 oldBid = _place(MAKER, true, 600, 100_000, false, true);
        assertGt(oldBid, 0);
        _indexOnly(OPENING + 10, OPENING + 300, 49e16);
        assertEq(engine.riskContext().indexWad, 492e15);
        _place(TAKER, false, 490, 100_000, false, false);
        assertEq(engine.account(MAKER).value.lots, 0);
        assertEq(engine.account(TAKER).value.lots, 0);
        assertEq(engine.getOrder(oldBid).size, 0);
        assertEq(engine.account(MAKER).orders.bidLots, 0);
        _assertConservation();
    }

    function testPruningOutsideBandPrefixPreservesInBandMakerExecution() public {
        _indexOnly(OPENING - 300, OPENING, 45e16);
        uint32 oldAsk = _place(MAKER, false, 400, 50_000, false, true);
        _indexOnly(OPENING + 10, OPENING + 300, 51e16);
        uint32 goodAsk = _place(OTHER, false, 500, 50_000, false, true);
        assertGt(goodAsk, 0);
        _place(TAKER, true, 510, 100_000, false, false);
        assertEq(engine.getOrder(oldAsk).size, 0);
        assertEq(engine.getOrder(goodAsk).size, 0);
        assertEq(engine.account(MAKER).value.lots, 0);
        assertEq(engine.account(OTHER).value.lots, -50_000);
        assertEq(engine.account(TAKER).value.lots, 50_000);
        assertEq(engine.account(TAKER).value.cashQ, 75e24);
        _assertConservation();
    }

    function testCurrentBandBoundaryStillExecutesAtMakerPrice() public {
        _indexOnly(OPENING - 300, OPENING, 5e17);
        uint32 boundaryAsk = _place(MAKER, false, 450, 100_000, false, true);
        _place(TAKER, true, 550, 100_000, false, false);
        assertEq(engine.getOrder(boundaryAsk).size, 0);
        assertEq(engine.account(MAKER).value.lots, -100_000);
        assertEq(engine.account(TAKER).value.lots, 100_000);
        assertEq(engine.account(TAKER).value.cashQ, 55e24);
        _assertConservation();
    }

    function testReduceOnlyMakerCannotBypassCurrentBootstrapExecutionBand() public {
        _indexOnly(OPENING - 300, OPENING, 45e16);
        _place(OTHER, false, 450, 100_000, false, true);
        _place(MAKER, true, 450, 100_000, false, false);
        assertEq(engine.account(MAKER).value.lots, 100_000);
        uint32 reducingAsk = _place(MAKER, false, 400, 100_000, true, true);
        assertGt(reducingAsk, 0);
        _indexOnly(OPENING + 10, OPENING + 300, 51e16);
        _place(TAKER, true, 510, 100_000, false, false);
        assertEq(engine.getOrder(reducingAsk).size, 0);
        assertEq(engine.account(MAKER).orders.askLots, 0);
        assertEq(engine.account(MAKER).value.lots, 100_000);
        assertEq(engine.account(TAKER).value.lots, 0);
        assertEq(engine.account(OTHER).value.lots, -100_000);
        _assertConservation();
    }
}
