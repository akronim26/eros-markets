// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FinalizeStatus, MarketInput, Outcome, RState} from "../../src/types/OracleTypes.sol";
import {KeeperRouter} from "../../src/KeeperRouter.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O19.2: KeeperRouter (plan §6.11, C.6). Each inner call is wrapped, so an engine revert on
///         one market does not block the others, and a `TooEarly` or `NoFeed` request never undoes the
///         halt. The router holds no funds and no approvals and is called by an arbitrary keeper.
contract KeeperRouterTest is OracleFixture {
    KeeperRouter internal router;
    address internal bot = makeAddr("keeper bot");

    function setUp() public override {
        super.setUp();
        router = new KeeperRouter(address(ro));
    }

    function test_constructor() public {
        assertEq(address(router.oracle()), address(ro));
        vm.expectRevert(KeeperRouter.ZeroAddress.selector);
        new KeeperRouter(address(0));
    }

    /// Every finalize outcome passes through, in order; a market whose engine reverts on `settle` and an
    /// unknown id report `reverted` without blocking the markets after them.
    function test_finalizeMany() public {
        (bytes32 bad, MockResolutionEngine eb) = _listedNoFeed("engine-reverts");
        (bytes32 fin,) = _listedNoFeed("final");
        (bytes32 rej,) = _listedNoFeed("rejected");
        (bytes32 dis,) = _listedNoFeed("disputed");
        (bytes32 waiting,) = _listedNoFeed("not-ready");
        _assert(bad);
        _assert(fin);
        _assert(rej);
        _assert(dis);
        _assert(waiting);
        eb.setRevertOnSettle(true);
        mvenue.setResult(_res(bad).assertionId, true);
        mvenue.setResult(_res(fin).assertionId, true);
        mvenue.setResult(_res(rej).assertionId, false);
        mvenue.markDisputed(_res(dis).assertionId, makeAddr("disputer"));
        bytes32[] memory ids = new bytes32[](6);
        (ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]) = (bad, fin, rej, dis, waiting, keccak256("unknown"));

        vm.prank(bot);
        (FinalizeStatus[] memory s, bool[] memory reverted) = router.finalizeMany(ids);

        assertTrue(reverted[0], "the engine's revert is caught");
        assertEq(uint8(s[0]), uint8(FinalizeStatus.NOT_READY));
        assertEq(uint8(_state(bad)), uint8(RState.Proposed), "rolled back, not Final");
        assertEq(uint8(s[1]), uint8(FinalizeStatus.FINAL));
        assertEq(uint8(_state(fin)), uint8(RState.Final), "finalized after the reverting market");
        assertEq(uint8(s[2]), uint8(FinalizeStatus.REJECTED));
        assertEq(uint8(_state(rej)), uint8(RState.Review));
        assertEq(uint8(s[3]), uint8(FinalizeStatus.DISPUTED));
        assertEq(uint8(_state(dis)), uint8(RState.Disputed));
        assertEq(uint8(s[4]), uint8(FinalizeStatus.NOT_READY));
        assertTrue(reverted[5], "UnknownMarket is caught");
        for (uint256 i = 1; i < 5; ++i) {
            assertFalse(reverted[i]);
        }
        _assertHoldsNothing();

        eb.setRevertOnSettle(false); // the engine recovers: the same batch call now finalizes it
        (s, reverted) = router.finalizeMany(ids);
        assertFalse(reverted[0]);
        assertEq(uint8(s[0]), uint8(FinalizeStatus.FINAL));
        assertEq(uint8(_state(bad)), uint8(RState.Final));
        assertEq(uint8(s[1]), uint8(FinalizeStatus.NOT_READY), "a Final market is a no-op");
    }

    /// Assertable markets are asserted; a market with nothing to assert, one whose assertion reverts
    /// (the treasury refuses the bond) and an unknown id report false without blocking the others.
    function test_assertMany() public {
        (bytes32 ready,) = _listedNoFeed("ready");
        (bytes32 short,) = _listedNoFeed("treasury-short");
        (bytes32 review,) = _listedNoFeed("review");
        (bytes32 ready2,) = _listedNoFeed("ready-2");
        _toProposed(ready);
        _toProposed(short);
        _toReview(review); // nothing proposed
        _toProposed(ready2);

        bytes32[] memory ids = new bytes32[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (review, keccak256("unknown"), ready, ready2);
        vm.prank(bot);
        bool[] memory asserted = router.assertMany(ids);
        assertFalse(asserted[0], "nothing to assert");
        assertFalse(asserted[1], "UnknownMarket is caught");
        assertTrue(asserted[2]);
        assertTrue(asserted[3]);
        assertTrue(_res(ready).assertionId != 0 && _res(ready2).assertionId != 0);

        // The treasury refuses the bond (per-market cap below it): the assertion reverts inside the
        // router and the batch still returns.
        vm.prank(gov);
        treasury.setLimits(BOND - 1, 20);
        bytes32[] memory one = new bytes32[](2);
        (one[0], one[1]) = (short, keccak256("unknown"));
        asserted = router.assertMany(one);
        assertFalse(asserted[0], "the treasury's revert is caught");
        assertEq(_res(short).assertionId, bytes32(0));
        _assertHoldsNothing();
    }

    /// The halt survives a refused request: TooEarly before T + bufferSecs, NoFeed without a feed.
    function test_haltAndRequest() public {
        (bytes32 feed,) = _listed("feed-market");
        (bytes32 noFeed,) = _listedNoFeed("no-feed-market");
        {
            // before T: nothing to halt, and the request is too early
            vm.prank(bot);
            (bool halted, bool requested) = router.haltAndRequest(feed);
            assertFalse(halted);
            assertFalse(requested);
            assertEq(uint8(_state(feed)), uint8(RState.None));
        }
        vm.warp(T);
        {
            // at T: halted, the request (TooEarly before T + bufferSecs) does not undo it
            (bool halted, bool requested) = router.haltAndRequest(feed);
            assertTrue(halted);
            assertFalse(requested);
            assertEq(uint8(_state(feed)), uint8(RState.L1Pending), "the halt stands");
        }
        {
            // a market without a feed: halted, NoFeed caught
            (bool halted, bool requested) = router.haltAndRequest(noFeed);
            assertTrue(halted);
            assertFalse(requested);
            assertEq(uint8(_state(noFeed)), uint8(RState.L2Pending));
        }
        vm.warp(T + 60);
        {
            // after T + bufferSecs: already halted, the request goes out
            (bool halted, bool requested) = router.haltAndRequest(feed);
            assertFalse(halted, "already halted");
            assertTrue(requested);
            assertEq(_res(feed).requestCount, 1);
        }
        {
            // an unknown id: both calls revert inside, nothing escapes
            (bool halted, bool requested) = router.haltAndRequest(keccak256("unknown"));
            assertFalse(halted);
            assertFalse(requested);
        }
        _assertHoldsNothing();
    }

    // ------------------------------------------------------------------ helpers

    function _listed(string memory name) internal returns (bytes32 id, MockResolutionEngine e) {
        MarketInput memory m = _market();
        m.marketId = keccak256(bytes(name));
        id = m.marketId;
        e = _list(m);
    }

    function _listedNoFeed(string memory name) internal returns (bytes32 id, MockResolutionEngine e) {
        MarketInput memory m = _noFeed();
        m.marketId = keccak256(bytes(name));
        id = m.marketId;
        e = _list(m);
    }

    /// A listed no-feed market halted at T, in Review, with a committee NO proposal recorded (not asserted).
    function _toProposed(bytes32 id) internal {
        _toReview(id);
        _propose(id, uint8(Outcome.NO));
    }

    /// As `_toProposed`, then asserted on the venue.
    function _assert(bytes32 id) internal {
        _toProposed(id);
        require(ro.assertProposal(id), "not asserted");
    }

    /// The router holds no tokens and gave no approval.
    function _assertHoldsNothing() internal view {
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.allowance(address(router), address(mvenue)), 0);
        assertEq(token.allowance(address(router), address(treasury)), 0);
        assertEq(address(router).balance, 0);
    }
}
