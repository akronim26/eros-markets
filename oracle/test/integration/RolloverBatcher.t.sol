pragma solidity ^0.8.30;

import {RolloverBatcher} from "../../src/integration/RolloverBatcher.sol";
import {LeveragedFactoryTest} from "./LeveragedFactory.t.sol";
import {Outcome} from "../../src/types/OracleTypes.sol";

contract RevertingRolloverTarget {
    uint64 public id = 1;
    uint8 public work;
    uint256 public cursor;
    uint256 public sweepCount = 64;
    uint8 public failPage;
    bool public failFinish;
    bool public stall;

    error InjectedFailure();

    function epoch() external view returns (uint64, uint64, uint64, uint64, uint64, int256, bool) {
        return (id, 0, 1, 0, 0, 0, true);
    }

    function configure(uint8 page, bool finish, bool noProgress) external {
        failPage = page;
        failFinish = finish;
        stall = noProgress;
    }

    function beginRollover() external {
        work = 1;
    }

    function rollPage(uint8 maximum) external returns (bool) {
        require(maximum == 32);
        if (failPage == cursor / 32 + 1) revert InjectedFailure();
        if (!stall) cursor += 32;
        return cursor == sweepCount;
    }

    function finishRollover() external {
        if (failFinish) revert InjectedFailure();
        work = 0;
        ++id;
    }
}

/// @notice Controlled factory/registry/vault integration and Monad gas checks for the
/// permissionless helper. Inherited leverage cases remain independently runnable.
contract RolloverBatcherTest is LeveragedFactoryTest {
    RolloverBatcher internal batcher;

    function setUp() public override {
        super.setUp();
        batcher = new RolloverBatcher();
    }

    function _batch(uint8 maximum) internal returns (uint8 pages, bool completed) {
        (uint64 id,,,,,,) = engine.epoch();
        return batcher.rollover(address(engine), id, uint8(engine.work()), engine.cursor(), maximum);
    }

    function _cold(uint256 participants) internal {
        _deploy(1, 0);
        for (uint256 i; i < participants; ++i) {
            _allocate(address(uint160(100_000 + i)), 100e6, false);
        }
        vm.prank(gov);
        engine.activateMarket();
    }

    function _due() internal {
        (,, uint64 end,,,,) = engine.epoch();
        vm.warp(end);
        vm.roll(block.number + 1);
    }

    function testBatchFourOwnersOpensNormalPricingWithoutLosingFreshCarry() public {
        _start(true);
        assertEq(engine.participantCount(), 4);
        (uint64 id,, uint64 end,,,,) = engine.epoch();
        _walk(end - 10, 6e17);
        assertEq(uint8(engine.pricingMode()), 0);
        _due();
        _observe(6e17);
        assertTrue(engine.basisTwap900(uint64(block.timestamp)).available);
        uint256 beforeGas = gasleft();
        (uint8 pages, bool complete) = _batch(32);
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("batch four owners gas", used);
        assertLt(used, 25_000_000);
        assertEq(pages, 1);
        assertTrue(complete);
        (uint64 next,,,,,,) = engine.epoch();
        assertEq(next, id + 1);
        assertEq(uint8(engine.work()), 0);
        assertEq(uint8(engine.pricingMode()), 1);
        (uint256 longCap, uint256 shortCap) = engine.leverageCaps();
        assertEq(longCap, 5);
        assertEq(shortCap, 5);
        assertTrue(engine.riskContext().markOk);
        assertEq(token.balanceOf(address(batcher)), 0);
        assertEq(address(batcher).balance, 0);
    }

    function testBatch1024ParticipantsBoundedRolloverAndFullOracleClaims() public {
        _cold(1024);
        _due();
        uint256 low = 1;
        uint256 high = 32;
        uint8 fittingPages;
        uint256 fittingGas;
        uint256 firstExcludedGas;
        // These reverted calls are diagnostic estimates, never broadcast. Each
        // accepted batch below must independently fit the padded transaction cap.
        while (low <= high) {
            uint8 candidate = uint8((low + high) / 2);
            uint256 snapshot = vm.snapshotState();
            uint256 beforeGas = gasleft();
            _batch(candidate);
            uint256 used = beforeGas - gasleft();
            assertTrue(vm.revertToState(snapshot));
            if ((used * 120 + 99) / 100 + 10_000 <= 30_000_000) {
                fittingPages = candidate;
                fittingGas = used;
                low = uint256(candidate) + 1;
            } else {
                firstExcludedGas = used;
                high = uint256(candidate) - 1;
            }
        }
        emit log_named_uint("1024 participants largest first batch pages within padded cap", fittingPages);
        emit log_named_uint("1024 participants accepted first batch gas", fittingGas);
        emit log_named_uint("1024 participants next excluded batch gas", firstExcludedGas);
        assertGt(fittingPages, 0);
        uint256 batches;
        uint256 totalGas;
        uint256 maxGas;
        bool complete;
        while (!complete) {
            uint256 beforeGas = gasleft();
            uint256 remainingPages = (engine.participantCount() - engine.cursor() + 31) / 32;
            // READY retains the previous epoch's cursor; this first cold epoch is zero.
            uint8 requestedPages = uint8(remainingPages < fittingPages ? remainingPages : fittingPages);
            (uint8 pages, bool finished) = _batch(requestedPages);
            uint256 used = beforeGas - gasleft();
            totalGas += used;
            if (used > maxGas) maxGas = used;
            assertLt(used * 120 / 100 + 10_000, 30_000_000, "20 percent margin fits Monad transaction cap");
            assertEq(pages, requestedPages);
            ++batches;
            complete = finished;
            if (!complete) {
                assertEq(uint8(engine.work()), 1);
                vm.roll(block.number + 1);
            }
            assertLe(batches, 32);
        }
        emit log_named_uint("1024 participants bounded helper calls", batches);
        emit log_named_uint("1024 participants maximum batch gas", maxGas);
        emit log_named_uint("1024 participants sum batch gas", totalGas);
        assertEq(batches, (32 + uint256(fittingPages) - 1) / fittingPages);
        assertEq(uint8(engine.work()), 0);
        assertEq(engine.participantCount(), 1024);
        bytes32 marketId = engine.listing().marketId;
        _enterReview(engine, true);
        _propose(marketId, Outcome.NO);
        _finalize(marketId, true);
        _prepare(engine);
        assertEq(engine.getSettlementStatus().totalDeficitQ, 0);
        for (uint256 i; i < 1024; ++i) {
            address owner = address(uint160(100_000 + i));
            vm.prank(owner);
            assertEq(engine.claimTrader(owner), 100e6);
            assertEq(token.balanceOf(owner), 100e6);
        }
        assertEq(token.balanceOf(address(vault)), vault.recognizedAtoms());
        assertEq(vault.recognizedAtoms(), 0);
        assertEq(token.balanceOf(address(batcher)), 0);
    }

    function testBatchEmptyActiveEpochFinishesWithoutSpuriousPage() public {
        _cold(0);
        _due();
        (uint8 pages, bool complete) = _batch(1);
        assertEq(pages, 0);
        assertTrue(complete);
        assertEq(uint8(engine.work()), 0);
    }

    function testBatchStaleWindowCompletesAccountingButRetainsSafeBootstrap() public {
        _start(true);
        (,, uint64 end,,,,) = engine.epoch();
        _walk(end - 40, 6e17);
        _due();
        _observe(6e17);
        assertFalse(engine.basisTwap900(uint64(block.timestamp)).available);
        (, bool complete) = _batch(32);
        assertTrue(complete);
        assertEq(uint8(engine.work()), 0);
        assertEq(uint8(engine.pricingMode()), 0);
        (uint256 longCap, uint256 shortCap) = engine.leverageCaps();
        assertEq(longCap, 1);
        assertEq(shortCap, 1);
    }

    function testBatchStaleEpochWorkOrCursorCannotTouchEngine() public {
        _cold(33);
        _due();
        (uint64 id,,,,,,) = engine.epoch();
        vm.expectRevert(RolloverBatcher.StaleSnapshot.selector);
        batcher.rollover(address(engine), id + 1, 0, 0, 1);
        vm.expectRevert(RolloverBatcher.StaleSnapshot.selector);
        batcher.rollover(address(engine), id, 1, 0, 1);
        vm.expectRevert(RolloverBatcher.StaleSnapshot.selector);
        batcher.rollover(address(engine), id, 0, 1, 1);
        (uint8 pages, bool complete) = _batch(1);
        assertEq(pages, 1);
        assertFalse(complete);
        assertEq(engine.cursor(), 32);
        vm.expectRevert(RolloverBatcher.StaleSnapshot.selector);
        batcher.rollover(address(engine), id, 1, 0, 1);
        (pages, complete) = _batch(1);
        assertEq(pages, 1);
        assertTrue(complete);
    }

    function testBatchInvalidBoundsEmptyTargetAndNativeValueAreRejected() public {
        RevertingRolloverTarget target = new RevertingRolloverTarget();
        vm.expectRevert(RolloverBatcher.InvalidTarget.selector);
        batcher.rollover(address(0x1234), 1, 0, 0, 1);
        vm.expectRevert(RolloverBatcher.InvalidTarget.selector);
        batcher.rollover(address(batcher), 1, 0, 0, 1);
        for (uint256 i; i < 2; ++i) {
            vm.expectRevert(RolloverBatcher.InvalidBounds.selector);
            batcher.rollover(address(target), 1, 0, 0, i == 0 ? 0 : 33);
        }
        vm.expectRevert(RolloverBatcher.InvalidBounds.selector);
        batcher.rollover(address(target), 1, 2, 0, 1);
        vm.deal(address(this), 1);
        (bool ok,) = address(batcher).call{value: 1}(
            abi.encodeCall(batcher.rollover, (address(target), uint64(1), uint8(0), uint256(0), uint8(1)))
        );
        assertFalse(ok);
        assertEq(address(batcher).balance, 0);
        assertEq(target.work(), 0);
    }

    function testBatchEngineEconomicRevertLeavesEpochUntouched() public {
        _cold(4);
        (uint64 id,,,,,,) = engine.epoch();
        vm.expectRevert();
        batcher.rollover(address(engine), id, 0, 0, 1);
        (uint64 afterId,,,,,,) = engine.epoch();
        assertEq(afterId, id);
        assertEq(uint8(engine.work()), 0);
        assertEq(engine.cursor(), 0);
    }

    function testBatchLaterPageOrFinishRevertRollsBackEveryEarlierStep() public {
        RevertingRolloverTarget target = new RevertingRolloverTarget();
        target.configure(2, false, false);
        vm.expectRevert(RevertingRolloverTarget.InjectedFailure.selector);
        batcher.rollover(address(target), 1, 0, 0, 2);
        assertEq(target.work(), 0);
        assertEq(target.cursor(), 0);
        target.configure(0, true, false);
        vm.expectRevert(RevertingRolloverTarget.InjectedFailure.selector);
        batcher.rollover(address(target), 1, 0, 0, 2);
        assertEq(target.work(), 0);
        assertEq(target.cursor(), 0);
        assertEq(target.id(), 1);
        target.configure(0, false, true);
        vm.expectRevert(RolloverBatcher.InvalidProgress.selector);
        batcher.rollover(address(target), 1, 0, 0, 2);
        assertEq(target.work(), 0);
        assertEq(target.cursor(), 0);
    }
}
