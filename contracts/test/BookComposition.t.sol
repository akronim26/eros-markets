// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {TraderIds} from "./BookHarness.sol";

// Four independent modules, each touching only its own part of Book, composed the way the
// EventPerp core will be (spec §11.2: one contract composing Book, Clearing, Pricing, Markets...).
// The logic inside is deliberately minimal; the point is that the seams compose.

/// Markets / oracle (R4): owns market creation and the stage gate.
abstract contract MarketsModule is Book {
    enum Stage {
        Open,
        ReduceOnly,
        Halted
    }

    error MarketHalted();
    error ReduceOnlyStage();

    Stage public stage;

    function createMarket(uint8 maxFills_) external {
        _initBook(maxFills_);
    }

    function setStage(Stage s) external {
        stage = s;
    }

    function _admit(uint32, Place calldata p) internal view override {
        Stage s = stage;
        if (s == Stage.Halted) revert MarketHalted();
        if (s == Stage.ReduceOnly && !p.reduceOnly) revert ReduceOnlyStage();
    }
}

/// Clearing (R2): owns accounts and their trader ids. The taker is written once, from Book's totals.
abstract contract ClearingModule is TraderIds {
    mapping(uint32 => int256) public position;
    mapping(uint32 => int256) public cash; // -sum(lots x tick), USDC atoms
    mapping(uint32 => mapping(bool => uint256)) public reserved;
    uint256 public takerWrites;

    function _signed(bool isBuy, uint256 x) private pure returns (int256) {
        return isBuy ? int256(x) : -int256(x);
    }

    function _takerStart(Ctx memory, uint64 size) internal pure override returns (uint64) {
        return size;
    }

    function _makerFill(Ctx memory c, uint32 maker, bool makerBuys, uint16 tick, uint64 size, uint8)
        internal
        override
        returns (uint64)
    {
        position[maker] += _signed(makerBuys, size);
        cash[maker] -= _signed(makerBuys, uint256(size) * tick);
        return size;
    }

    function _takerFill(Ctx memory, bool, uint16, uint64) internal pure override {}

    function _takerDone(Ctx memory c) internal override {
        if (c.filled == 0) return;
        position[c.taker] += _signed(c.takerBuys, c.filled);
        cash[c.taker] -= _signed(c.takerBuys, c.cost);
        ++takerWrites;
    }

    function _onRest(uint32 trader, uint16, uint64 size, uint8 flags) internal override {
        reserved[trader][flags & FLAG_BUY != 0] += size;
    }

    function _onUnrest(uint32 trader, uint64 size, uint8 flags) internal override {
        reserved[trader][flags & FLAG_BUY != 0] -= size;
    }
}

/// Pricing (R3): reads the touch with a minimum-depth filter; a thin level counts as missing.
abstract contract PricingModule is Book {
    uint96 public constant D_MIN = 250;

    function filteredTouch() external view returns (uint16 bid, uint16 ask) {
        (uint16 b, uint96 bs, uint16 a, uint96 as_) = _touch();
        bid = bs >= D_MIN ? b : 0; // missing bid reads as 0
        ask = as_ >= D_MIN ? a : 1000; // missing ask reads as 1.000
    }
}

/// Liquidation (R3): pulls an account's resting orders before taking over its position.
abstract contract LiquidationModule is Book {
    function pullOrders(uint32[] calldata ids) external returns (uint256 cancelled) {
        for (uint256 i; i < ids.length; ++i) {
            if (_forceCancel(ids[i], CancelReason.RISK)) ++cancelled;
        }
    }
}

contract ComposedCore is MarketsModule, ClearingModule, PricingModule, LiquidationModule {}

contract BookCompositionTest is Test {
    ComposedCore core;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests
    address alice = makeAddr("alice"); // trader 1
    address bob = makeAddr("bob"); // trader 2

    function setUp() public {
        core = new ComposedCore();
        core.createMarket(MAX_FILLS);
    }

    function _place(address who, Book.OrderType kind, bool isBuy, uint16 tick, uint64 size)
        internal
        returns (uint32)
    {
        vm.prank(who);
        return core.placeOrder(Book.Place(kind, isBuy, false, tick, size, 8));
    }

    function test_TradeSettlesThroughClearingWithOneTakerWrite() public {
        _place(alice, Book.OrderType.POST_ONLY, false, 600, 300);
        _place(alice, Book.OrderType.POST_ONLY, false, 610, 300);
        _place(bob, Book.OrderType.IOC, true, 610, 400);

        assertEq(core.position(2), 400);
        assertEq(core.position(1), -400);
        assertEq(core.cash(2), -(300 * 600 + 100 * 610));
        assertEq(core.cash(1), 300 * 600 + 100 * 610, "zero-sum cash");
        assertEq(core.takerWrites(), 1, "taker written once for two fills");
        assertEq(core.reserved(1, false), 200);
    }

    function test_MarketsStageGatesTheBook() public {
        _place(alice, Book.OrderType.POST_ONLY, false, 600, 300);
        core.setStage(MarketsModule.Stage.Halted);
        vm.prank(bob);
        vm.expectRevert(MarketsModule.MarketHalted.selector);
        core.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 600, 1, 8));

        core.setStage(MarketsModule.Stage.ReduceOnly);
        vm.prank(bob);
        vm.expectRevert(MarketsModule.ReduceOnlyStage.selector);
        core.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 600, 1, 8));
    }

    function test_PricingSeesDepthFilteredTouch() public {
        _place(alice, Book.OrderType.POST_ONLY, true, 480, 249); // too thin
        _place(alice, Book.OrderType.POST_ONLY, false, 520, 250);
        (uint16 bid, uint16 ask) = core.filteredTouch();
        assertEq(bid, 0);
        assertEq(ask, 520);
    }

    function test_LiquidationPullsRestingOrders() public {
        uint32 a = _place(alice, Book.OrderType.POST_ONLY, true, 480, 10);
        uint32 b = _place(alice, Book.OrderType.POST_ONLY, false, 520, 10);
        uint32[] memory ids = new uint32[](3);
        (ids[0], ids[1], ids[2]) = (a, b, a); // a repeated: second pull is a no-op
        vm.expectEmit(address(core));
        emit Book.OrderCancelled(a, 10, Book.CancelReason.RISK);
        assertEq(core.pullOrders(ids), 2);
        assertEq(core.reserved(1, true), 0);
        assertEq(core.reserved(1, false), 0);
    }
}
