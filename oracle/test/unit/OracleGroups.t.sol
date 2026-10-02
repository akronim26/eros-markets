// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    FinalReason,
    GroupInfo,
    GroupState,
    MarketInput,
    Outcome,
    Path,
    Resolution,
    RState,
    ReviewedProposal,
    Sig
} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {OracleFixture} from "./OracleFixture.sol";

/// @notice Task O14.6: exclusive groups (plan §5.4, D6, ORC-7; §11.1 "Groups"). One YES lock per exclusive
///         group, taken when a YES assertion goes live, released on its rejection or the market's void, kept
///         on Final YES; a YES in a group with a Final YES goes to Review without using an attempt.
/// @dev Members are listed through the real registry (groups enabled in this task). Retry window 300 s.
contract OracleGroupsTest is OracleFixture {
    bytes32 internal constant G = keccak256("group-1");

    function _member(string memory name, bool feed, bool exclusive, uint64 tau) internal returns (bytes32 id) {
        MarketInput memory m = feed ? _market() : _noFeed();
        m.marketId = keccak256(bytes(name));
        m.groupId = G;
        m.groupExclusive = exclusive;
        m.tau = tau;
        m.voidSecs = 7_200 + uint32(tau - T); // keeps the engine's capture-grace gate for a later T
        id = m.marketId;
        _list(m);
    }

    function _member(string memory name) internal returns (bytes32) {
        return _member(name, false, true, T);
    }

    /// Halts at T (or now, if later) and places the market in Review.
    function _haltReview(bytes32 id) internal {
        if (block.timestamp < T) vm.warp(T);
        ro.haltScheduled(id);
        _forceState(id, RState.Review);
    }

    function _proposeAssert(bytes32 id, Outcome o) internal returns (bytes32 aid) {
        _propose(id, uint8(o));
        require(ro.assertProposal(id), "not asserted");
        aid = _res(id).assertionId;
    }

    function _group() internal view returns (GroupState memory) {
        return ro.groupState(G);
    }

    // ------------------------------------------------------------------ listing

    function test_groupedListingAccepted() public {
        _member("a");
        GroupInfo memory gi = reg.groupInfo(G);
        assertTrue(gi.exists && gi.exclusive);
        assertEq(reg.getMarketCore(keccak256("a")).groupId, G);
    }

    // ------------------------------------------------------------------ the YES lock

    function test_lockTakenAtAssertion() public {
        bytes32 a = _member("a");
        _haltReview(a);
        _propose(a, uint8(Outcome.YES));
        assertEq(_group().yesLockHolder, 0, "a recorded proposal takes no lock");
        vm.expectEmit(address(ro));
        emit IResolutionOracle.GroupLock(G, a, true);
        assertTrue(ro.assertProposal(a));
        assertEq(_group().yesLockHolder, a);
    }

    function test_secondYesWaitsForTheLock() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b");
        _haltReview(a);
        _haltReview(b);
        _proposeAssert(a, Outcome.YES);
        _propose(b, uint8(Outcome.YES)); // the committee may record it
        assertFalse(ro.assertProposal(b), "waits while a holds the lock");
        Resolution memory r = _res(b);
        assertEq(uint8(r.state), uint8(RState.Proposed));
        assertEq(r.attempts, 0);
        assertEq(r.assertionId, 0);
        assertEq(_group().yesLockHolder, a);
    }

    function test_noIsNotLocked() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b");
        _haltReview(a);
        _haltReview(b);
        _proposeAssert(a, Outcome.YES);
        _proposeAssert(b, Outcome.NO);
        assertEq(_group().yesLockHolder, a, "a NO assertion neither needs nor takes the lock");
    }

    function test_otherMembersRejectionKeepsTheLock() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b");
        _haltReview(a);
        _haltReview(b);
        _proposeAssert(a, Outcome.YES);
        mvenue.setResult(_proposeAssert(b, Outcome.NO), false);
        ro.finalizeMarket(b);
        assertEq(uint8(_state(b)), uint8(RState.Review));
        assertEq(_group().yesLockHolder, a, "only the holder releases");
    }

    function test_lockReleasedOnRejection() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b");
        _haltReview(a);
        _haltReview(b);
        bytes32 aid = _proposeAssert(a, Outcome.YES);
        _propose(b, uint8(Outcome.YES));
        mvenue.setResult(aid, false);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.GroupLock(G, a, false);
        ro.finalizeMarket(a);
        assertEq(_group().yesLockHolder, 0);
        assertTrue(ro.assertProposal(b), "free again");
        assertEq(_group().yesLockHolder, b);
    }

    function test_lockReleasedOnVoid() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b", false, true, T + 7_200); // halts when a voids
        _haltReview(a);
        bytes32 aid = _proposeAssert(a, Outcome.YES);
        mvenue.markDisputed(aid, address(0xD1)); // never answered
        vm.warp(T + 7_200);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.GroupLock(G, a, false);
        assertTrue(ro.voidMarket(a));
        assertEq(_group().yesLockHolder, 0);
        assertEq(_group().finalYes, 0, "a voided market is no Final YES");
        ro.haltScheduled(b);
        _forceState(b, RState.Review);
        _proposeAssert(b, Outcome.YES);
        assertEq(_group().yesLockHolder, b);
    }

    function test_lockReleasedWhenYesAndNoRejected() public {
        bytes32 a = _member("a");
        _haltReview(a);
        mvenue.setResult(_proposeAssert(a, Outcome.NO), false);
        ro.finalizeMarket(a);
        mvenue.setResult(_proposeAssert(a, Outcome.YES), false);
        ro.finalizeMarket(a);
        assertEq(uint8(_res(a).finalReason), uint8(FinalReason.REJECTED_YES_AND_NO));
        GroupState memory g = _group();
        assertEq(g.yesLockHolder, 0);
        assertEq(g.finalYes, 0);
    }

    function test_finalYesKeepsTheLock() public {
        bytes32 a = _member("a");
        _haltReview(a);
        mvenue.setResult(_proposeAssert(a, Outcome.YES), true);
        ro.finalizeMarket(a);
        GroupState memory g = _group();
        assertEq(g.finalYes, a);
        assertEq(g.yesLockHolder, a);
    }

    function test_finalNoSetsNoFinalYes() public {
        bytes32 a = _member("a");
        _haltReview(a);
        mvenue.setResult(_proposeAssert(a, Outcome.NO), true);
        ro.finalizeMarket(a);
        assertEq(_group().finalYes, 0);
    }

    // ------------------------------------------------------------------ conflicts after a Final YES

    function test_conflictGoesToReview() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b");
        _haltReview(a);
        _haltReview(b);
        bytes32 aid = _proposeAssert(a, Outcome.YES);
        _propose(b, uint8(Outcome.YES)); // recorded before a's Final
        mvenue.setResult(aid, true);
        ro.finalizeMarket(a);
        vm.warp(T + 50);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.StateChanged(b, RState.Proposed, RState.Review);
        vm.expectEmit(address(ro));
        emit IResolutionOracle.GroupConflict(G, b);
        assertFalse(ro.assertProposal(b));
        Resolution memory r = _res(b);
        assertEq(uint8(r.state), uint8(RState.Review));
        assertEq(uint8(r.proposed), uint8(Outcome.NONE));
        assertEq(r.retryOpensAt, T + 350, "now + retry window");
        assertEq(r.attempts, 0, "no attempt used");
        assertEq(r.rejectedMask, 0, "YES is not rejected by the venue");
        assertEq(_group().yesLockHolder, a);
    }

    function test_conflictOnAFeedMarketWithoutL2Start() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b-feed", true, true, T);
        _haltReview(a);
        ro.haltScheduled(b); // L1Pending, l2StartedAt == 0
        mvenue.setResult(_proposeAssert(a, Outcome.YES), true);
        ro.finalizeMarket(a);
        Resolution memory r = _res(b);
        assertEq(r.l2StartedAt, 0);
        r.state = RState.Proposed; // as onReport (O15) leaves an L1 YES
        r.proposed = Outcome.YES;
        r.path = Path.L1;
        r.evidenceHash = keccak256("report");
        r.valueHash = keccak256("3");
        ro.setResolution(b, r);
        vm.warp(T + 100);
        assertFalse(ro.assertProposal(b));
        r = _res(b);
        assertEq(uint8(r.state), uint8(RState.Review));
        assertEq(r.retryOpensAt, T + 400);
        assertFalse(ro.openAfterDeadline(b), "l2StartedAt + deadline would already be due; retryOpensAt holds it");
        vm.warp(T + 400);
        assertTrue(ro.openAfterDeadline(b));
    }

    function test_committeeYesRevertsAfterFinalYes() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b");
        _haltReview(a);
        _haltReview(b);
        mvenue.setResult(_proposeAssert(a, Outcome.YES), true);
        ro.finalizeMarket(a);
        ReviewedProposal memory p = _reviewed(b, uint8(Outcome.YES));
        Sig[] memory s = _sigs(p, 0, 1);
        vm.expectRevert(IResolutionOracle.GroupYesTaken.selector);
        ro.submitReviewedProposal(b, p, URI, s);
        _proposeAssert(b, Outcome.NO); // NO is still open to b
    }

    // ------------------------------------------------------------------ permissionless

    function _fundProposer() internal returns (address p) {
        p = makeAddr("proposer");
        token.mint(p, BOND);
        vm.prank(p);
        token.approve(address(mvenue), BOND);
    }

    function _permissionless(bytes32 id, Outcome o) internal returns (bytes32) {
        address p = _fundProposer();
        vm.prank(p);
        return ro.proposePermissionless(id, o, URI, keccak256("snapshot"));
    }

    function _open(bytes32 id) internal {
        if (block.timestamp < T) vm.warp(T);
        ro.haltScheduled(id);
        _forceState(id, RState.Open);
    }

    function test_permissionlessYesTakesTheLock() public {
        bytes32 a = _member("a");
        _open(a);
        address p = _fundProposer();
        vm.expectEmit(address(ro));
        emit IResolutionOracle.GroupLock(G, a, true);
        vm.prank(p);
        ro.proposePermissionless(a, Outcome.YES, URI, keccak256("snapshot"));
        assertEq(_group().yesLockHolder, a);
    }

    function test_permissionlessYesBlockedByTheLock() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b");
        _haltReview(a);
        _open(b);
        _proposeAssert(a, Outcome.YES);
        address p = makeAddr("proposer");
        vm.prank(p);
        vm.expectRevert(IResolutionOracle.GroupYesTaken.selector);
        ro.proposePermissionless(b, Outcome.YES, URI, keccak256("snapshot"));
        _permissionless(b, Outcome.NO);
        assertEq(_group().yesLockHolder, a);
    }

    function test_permissionlessYesBlockedByFinalYes() public {
        bytes32 a = _member("a");
        bytes32 b = _member("b");
        _haltReview(a);
        _open(b);
        mvenue.setResult(_proposeAssert(a, Outcome.YES), true);
        ro.finalizeMarket(a);
        vm.prank(makeAddr("proposer"));
        vm.expectRevert(IResolutionOracle.GroupYesTaken.selector);
        ro.proposePermissionless(b, Outcome.YES, URI, keccak256("snapshot"));
    }

    // ------------------------------------------------------------------ non-exclusive groups

    function test_nonExclusiveGroupHasNoLock() public {
        bytes32 a = _member("a", false, false, T);
        bytes32 b = _member("b", false, false, T);
        _haltReview(a);
        _haltReview(b);
        bytes32 aa = _proposeAssert(a, Outcome.YES);
        _proposeAssert(b, Outcome.YES); // both YES live at once
        GroupState memory g = _group();
        assertEq(g.yesLockHolder, 0);
        mvenue.setResult(aa, true);
        ro.finalizeMarket(a);
        assertEq(_group().finalYes, 0);
    }
}
