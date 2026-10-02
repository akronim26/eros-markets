// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";

/// @notice Book with no-op Clearing hooks, so benchmarks measure the book alone.
contract LeanBook is Book {
    bool public failAll;

    function createMarket(uint8 maxFills_) external {
        _initBook(maxFills_);
    }

    function setFailAll(bool fail) external {
        failAll = fail;
    }

    function freeHead() external view returns (uint32) {
        return _book.freeHead;
    }

    function _takerStart(Ctx memory, uint64 size) internal pure override returns (uint64) {
        return size;
    }

    function _makerFill(Ctx memory, uint32, bool, uint16, uint64 size, uint8)
        internal
        view
        override
        returns (uint64)
    {
        return failAll ? 0 : size;
    }

    function _takerFill(Ctx memory, bool, uint16, uint64) internal pure override {}

    function _takerDone(Ctx memory) internal pure override {}

    function _admit(uint32, Place calldata) internal pure override {}

    function _onRest(uint32, uint16, uint64, uint8) internal pure override {}

    function _onUnrest(uint32, uint64, uint8) internal pure override {}
}

/// @notice Gas for the operations in spec §9.9, written to snapshots/BookGas.json.
/// @dev Excludes the 21k base cost and Clearing's account writes (LeanBook's hooks do nothing),
///      and Foundry 1.8.3's `monad` network does not model MIP-8 page pricing, so these numbers
///      are regression guards, not Monad costs; measure on testnet for real figures. Storage is
///      cooled before each measured call.
contract BookGasTest is Test {
    LeanBook book;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests
    address mm = makeAddr("mm");
    address mm2 = makeAddr("mm2");
    address taker = makeAddr("taker");

    /// Like a live market: traders registered, every benchmarked level used once (so its slot
    /// is non-zero) and some dead order slots waiting on the free list.
    function setUp() public {
        book = new LeanBook();
        book.createMarket(MAX_FILLS);
        uint32[] memory ids = new uint32[](4);
        ids[0] = _post(mm, true, 499, 1);
        ids[1] = _post(mm, true, 500, 1);
        ids[2] = _post(mm, false, 501, 1);
        ids[3] = _post(mm, false, 502, 1);
        vm.prank(mm);
        book.batch(ids, new Book.Place[](0));
        vm.prank(mm2);
        book.batch(new uint32[](0), new Book.Place[](0));
        vm.prank(taker);
        book.batch(new uint32[](0), new Book.Place[](0));
    }

    function _post(address who, bool isBuy, uint16 tick, uint64 size) internal returns (uint32) {
        vm.prank(who);
        return book.placeOrder(Book.Place(Book.OrderType.POST_ONLY, isBuy, false, tick, size, 0));
    }

    function test_Gas_PlaceRestingRecycledSlot() public {
        vm.cool(address(book));
        _post(mm, false, 502, 100);
        vm.snapshotGasLastFrame("BookGas", "placeResting_recycledSlot");
    }

    function test_Gas_PlaceRestingFreshSlot() public {
        while (book.freeHead() != 0) {
            _post(mm2, true, 400, 1); // drain the free list away from the measured level
        }
        vm.cool(address(book));
        _post(mm, false, 502, 100);
        vm.snapshotGasLastFrame("BookGas", "placeResting_freshSlot");
    }

    function test_Gas_CancelReplaceBatch() public {
        uint32 bid = _post(mm, true, 499, 100);
        uint32 ask = _post(mm, false, 501, 100);
        uint32[] memory cancels = new uint32[](2);
        (cancels[0], cancels[1]) = (bid, ask);
        Book.Place[] memory ps = new Book.Place[](2);
        ps[0] = Book.Place(Book.OrderType.POST_ONLY, true, false, 500, 100, 0);
        ps[1] = Book.Place(Book.OrderType.POST_ONLY, false, false, 502, 100, 0);
        vm.cool(address(book));
        vm.prank(mm);
        book.batch(cancels, ps);
        vm.snapshotGasLastFrame("BookGas", "cancelReplace_twoSidedBatch");
    }

    function test_Gas_TakerOneFill() public {
        _post(mm, false, 501, 100);
        vm.cool(address(book));
        vm.prank(taker);
        book.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 501, 100, 8));
        vm.snapshotGasLastFrame("BookGas", "taker_oneFill");
    }

    function test_Gas_TakerFourFillsSameMaker() public {
        for (uint256 i; i < 4; ++i) {
            _post(mm, false, 501, 25);
        }
        vm.cool(address(book));
        vm.prank(taker);
        book.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 501, 100, 8));
        vm.snapshotGasLastFrame("BookGas", "taker_fourFills_sameMaker");
    }

    function test_Gas_TakerFourFillsTwoMakersTwoLevels() public {
        _post(mm, false, 501, 25);
        _post(mm2, false, 501, 25);
        _post(mm, false, 502, 25);
        _post(mm2, false, 502, 25);
        vm.cool(address(book));
        vm.prank(taker);
        book.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 502, 100, 8));
        vm.snapshotGasLastFrame("BookGas", "taker_fourFills_twoMakers_twoLevels");
    }

    function test_Gas_CancelOne() public {
        uint32 id = _post(mm, false, 502, 100);
        vm.cool(address(book));
        vm.prank(mm);
        book.cancel(id);
        vm.snapshotGasLastFrame("BookGas", "cancel_one");
    }

    /// Worst case the protocol allows: 64 examined orders, all failing the maker check.
    function test_Gas_TakerMaxFillsAllFailing() public {
        for (uint256 i; i < 64; ++i) {
            _post(mm, false, 501, 1);
        }
        book.setFailAll(true);
        vm.cool(address(book));
        vm.prank(taker);
        book.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 501, 64, 64));
        vm.snapshotGasLastFrame("BookGas", "taker_64steps_allFailing");
    }
}
