// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {IBookRiskHooks} from "../src/interfaces/IBookRiskHooks.sol";
import {TraderIds} from "./BookHarness.sol";
import {Side, AdmissionMode, RejectCode} from "../provisional/MathTypes.sol";

// Three independent modules, each touching only its own part of Book, composed the way the
// EventPerp core will be (spec §11.2: one contract composing Book, Clearing, Pricing, Markets...).
// The logic inside is deliberately minimal; the point is that the seams compose.

/// Markets (R4): owns opening the book and its fill bound.
abstract contract MarketsModule is Book {
    function createMarket(uint8 maxFills_) external {
        _initBook(maxFills_);
    }
}

/// Clearing (R2): owns accounts, their trader ids and the stage gate, behind the risk hooks.
/// Each matched pair posts both legs at the maker's price inside its own fill (risk spec §7.5).
abstract contract ClearingModule is TraderIds {
    enum Stage {
        Open,
        ReduceOnly,
        Halted
    }

    Stage public stage;
    mapping(uint32 => int256) public position;
    mapping(uint32 => int256) public cash; // -sum(lots x tick), USDC atoms
    mapping(uint32 => mapping(bool => uint256)) public reserved;
    uint256 public postings;

    function setStage(Stage s) external {
        stage = s;
    }

    function _signed(bool isBuy, uint256 x) private pure returns (int256) {
        return isBuy ? int256(x) : -int256(x);
    }

    function _riskBeginAction() internal pure override returns (RiskSnapshot memory s) {}

    function _riskTouchAccount(uint32, RiskSnapshot memory) internal pure override {}

    function _riskPrepareTaker(OrderRequest memory req, RiskSnapshot memory, AdmissionMode)
        internal
        view
        override
        returns (TakerPermit memory p, RejectCode reason)
    {
        (p.trader, p.side, p.limitTick, p.reduceOnly) = (req.trader, req.side, req.limitTick, req.reduceOnly);
        if (stage == Stage.Halted) return (p, RejectCode.HALTED);
        if (stage == Stage.ReduceOnly && !req.reduceOnly) return (p, RejectCode.BAD_STAGE);
        p.remainingLots = req.requestedLots;
    }

    function _riskTryMatchedFill(
        RiskSnapshot memory,
        TakerPermit memory permit,
        OrderView memory maker,
        uint64 lots
    ) internal override returns (StepResult memory r) {
        bool makerBuys = maker.side == Side.BUY;
        position[maker.owner] += _signed(makerBuys, lots);
        position[permit.trader] -= _signed(makerBuys, lots);
        cash[maker.owner] -= _signed(makerBuys, uint256(lots) * maker.tick);
        cash[permit.trader] += _signed(makerBuys, uint256(lots) * maker.tick);
        reserved[maker.owner][makerBuys] -= lots;
        permit.remainingLots -= lots;
        ++postings;
        r.filledLots = lots;
    }

    function _riskAdmitRest(RiskSnapshot memory, uint32, Side, uint16, uint64, uint32, bool)
        internal
        pure
        override
        returns (EpochTag memory, uint64, uint256)
    {}

    function _riskConvertPermitToRest(RiskSnapshot memory, TakerPermit memory permit, uint64 lots, uint32)
        internal
        override
        returns (EpochTag memory, uint64, uint256)
    {
        permit.remainingLots -= lots;
        reserved[permit.trader][permit.side == Side.BUY] += lots;
        return (EpochTag(0, 0), 0, 0);
    }

    function _riskOnUnrest(
        RiskSnapshot memory,
        uint32 owner,
        EpochTag memory,
        Side side,
        uint16,
        uint64 lots,
        uint256
    ) internal override {
        reserved[owner][side == Side.BUY] -= lots;
    }

    function _riskCancelAll(uint32) internal pure override returns (EpochTag memory) {}

    function _riskFinishTaker(RiskSnapshot memory, TakerPermit memory) internal pure override {}
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

contract ComposedCore is MarketsModule, ClearingModule, PricingModule {}

contract BookCompositionTest is Test {
    ComposedCore core;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests
    address alice = makeAddr("alice"); // trader 1
    address bob = makeAddr("bob"); // trader 2

    function setUp() public {
        core = new ComposedCore();
        core.createMarket(MAX_FILLS);
    }

    function _place(address who, IBookRiskHooks.OrderKind kind, bool isBuy, uint16 tick, uint64 size)
        internal
        returns (uint32)
    {
        vm.prank(who);
        return core.placeOrder(Book.Place(kind, isBuy, false, tick, size, 8, 0));
    }

    function test_EachFillPostsBothLegsAtTheMakerPrice() public {
        _place(alice, IBookRiskHooks.OrderKind.POST_ONLY, false, 600, 300);
        _place(alice, IBookRiskHooks.OrderKind.POST_ONLY, false, 610, 300);
        _place(bob, IBookRiskHooks.OrderKind.IOC, true, 610, 400);

        assertEq(core.position(2), 400);
        assertEq(core.position(1), -400);
        assertEq(core.cash(2), -(300 * 600 + 100 * 610));
        assertEq(core.cash(1), 300 * 600 + 100 * 610, "zero-sum cash");
        assertEq(core.postings(), 2, "one posting per matched pair");
        assertEq(core.reserved(1, false), 200);
    }

    function test_ClearingStageGatesTheBook() public {
        _place(alice, IBookRiskHooks.OrderKind.POST_ONLY, false, 600, 300);
        core.setStage(ClearingModule.Stage.Halted);
        vm.expectEmit(address(core));
        emit Book.OrderRejected(2, RejectCode.HALTED);
        assertEq(_place(bob, IBookRiskHooks.OrderKind.IOC, true, 600, 1), 0);

        core.setStage(ClearingModule.Stage.ReduceOnly);
        vm.expectEmit(address(core));
        emit Book.OrderRejected(2, RejectCode.BAD_STAGE);
        assertEq(_place(bob, IBookRiskHooks.OrderKind.IOC, true, 600, 1), 0);
        assertEq(core.position(2), 0);
    }

    function test_PricingSeesDepthFilteredTouch() public {
        _place(alice, IBookRiskHooks.OrderKind.POST_ONLY, true, 480, 249); // too thin
        _place(alice, IBookRiskHooks.OrderKind.POST_ONLY, false, 520, 250);
        (uint16 bid, uint16 ask) = core.filteredTouch();
        assertEq(bid, 0);
        assertEq(ask, 520);
    }
}
