// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Globals, Outcome, Path, Resolution, RState, ReviewedProposal, Sig} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O14.3: committee proposals (Review, Open, EarlyReview with the early halt) and permissionless
///         proposals (plan §5.4, §6.4, D7, D17, ORC-6), each guard with an accepting and a rejecting test.
/// @dev Clocks from the fixture: T = listing + 1,800 s, L2 deadline 600 s, reviewed liveness 300 s,
///      voidDeadline T + 7,200 s, early TTL 600 s; the bond is 11,120,000 atoms (§12.5).
contract OracleProposalsTest is OracleFixture {
    address internal proposer = makeAddr("proposer");

    function _expectBadPayload(bytes32 id, ReviewedProposal memory p, uint8 code) internal {
        Sig[] memory s = _sigs(p, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, code));
        ro.submitReviewedProposal(id, p, URI, s);
    }

    function _approveBond(address who) internal {
        token.mint(who, BOND);
        vm.prank(who);
        token.approve(address(mvenue), BOND);
    }

    // ------------------------------------------------------------------ committee: Review and Open

    /// Committee proposals accepted from Review and from Open.
    function test_committee_accepted() public {
        uint256 snap = vm.snapshotState();
        {
            // test_committee_fromReview
            (bytes32 id, MockResolutionEngine e) = _listNoFeed();
            _toReview(id);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.NO));
            Sig[] memory s = _sigs(p, 0, 2);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.ProposalRecorded(id, Outcome.NO, Path.REVIEWED, keccak256("snapshot"), URI, 0);
            vm.prank(keeper); // anyone relays
            ro.submitReviewedProposal(id, p, URI, s);
            Resolution memory r = _res(id);
            assertEq(uint8(r.state), uint8(RState.Proposed));
            assertEq(uint8(r.proposed), uint8(Outcome.NO));
            assertEq(uint8(r.path), uint8(Path.REVIEWED));
            assertEq(r.evidenceHash, keccak256("snapshot"));
            assertEq(r.assertionId, 0, "asserted later by assertProposal");
            assertEq(ro.evidenceURIOf(id), URI);
            assertEq(uint8(e.getSettlementStatus().finalOutcome), 0, "the engine is not settled");
        }
        vm.revertToState(snap);
        {
            // test_committee_fromOpen
            (bytes32 id,) = _listNoFeed();
            _toOpen(id);
            _propose(id, uint8(Outcome.INVALID));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
            assertEq(uint8(_res(id).proposed), uint8(Outcome.INVALID));
        }
    }

    function test_committee_wrongState() public {
        (bytes32 id,) = _listFeed();
        RState[5] memory bad = [RState.None, RState.L1Pending, RState.L2Pending, RState.Proposed, RState.Final];
        for (uint256 i; i < bad.length; ++i) {
            _forceState(id, bad[i]);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
            Sig[] memory s = _sigs(p, 0, 1);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.WrongState.selector, bad[i]));
            ro.submitReviewedProposal(id, p, URI, s);
        }
    }

    /// Committee payload guards, each accepted and rejected: fields, evidence URI length, deadline, outcome rules.
    function test_committee_payload() public {
        uint256 snap = vm.snapshotState();
        {
            // test_committee_payloadChecks
            (bytes32 id,) = _listNoFeed();
            _toReview(id);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
            p.marketId = keccak256("other market");
            _expectBadPayload(id, p, 7);
            p = _reviewed(id, uint8(Outcome.YES));
            p.attempt = 1;
            _expectBadPayload(id, p, 2);
            p = _reviewed(id, uint8(Outcome.YES));
            p.rejectedMask = 8;
            _expectBadPayload(id, p, 6);
            p = _reviewed(id, uint8(Outcome.YES));
            p.early = true;
            _expectBadPayload(id, p, 1);
            p = _reviewed(id, uint8(Outcome.YES));
            p.trustSetId = 2;
            _expectBadPayload(id, p, 4);
            p = _reviewed(id, uint8(Outcome.YES));
            p.evidenceURIHash = keccak256("another uri");
            _expectBadPayload(id, p, 5);
        }
        vm.revertToState(snap);
        {
            // test_committee_evidenceUriLength
            (bytes32 id,) = _listNoFeed();
            _toReview(id);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
            p.evidenceURIHash = keccak256("");
            Sig[] memory s = _sigs(p, 0, 1);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, uint8(5)));
            ro.submitReviewedProposal(id, p, "", s);
            string memory long = string(new bytes(257));
            p.evidenceURIHash = keccak256(bytes(long));
            s = _sigs(p, 0, 1);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, uint8(5)));
            ro.submitReviewedProposal(id, p, long, s);
            string memory max = string(new bytes(256));
            p.evidenceURIHash = keccak256(bytes(max));
            s = _sigs(p, 0, 1);
            ro.submitReviewedProposal(id, p, max, s); // exactly 256 bytes
        }
        vm.revertToState(snap);
        {
            // test_committee_deadline
            (bytes32 id,) = _listNoFeed();
            _toReview(id);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
            p.deadline = uint64(block.timestamp - 1);
            Sig[] memory s = _sigs(p, 0, 1);
            vm.expectRevert(IResolutionOracle.SignatureExpired.selector);
            ro.submitReviewedProposal(id, p, URI, s);
            p.deadline = uint64(block.timestamp); // at the deadline is still valid
            s = _sigs(p, 0, 1);
            ro.submitReviewedProposal(id, p, URI, s);
        }
        vm.revertToState(snap);
        {
            // test_committee_outcomeRules
            (bytes32 id,) = _listNoFeed();
            _toReview(id);
            uint8[2] memory invalidOutcomes = [0, 4];
            for (uint256 i; i < 2; ++i) {
                ReviewedProposal memory p = _reviewed(id, invalidOutcomes[i]);
                Sig[] memory s = _sigs(p, 0, 1);
                vm.expectRevert(IResolutionOracle.OutcomeNotAllowed.selector);
                ro.submitReviewedProposal(id, p, URI, s);
            }
            Resolution memory r = _res(id);
            r.rejectedMask = 2; // YES was rejected earlier (ORC-6)
            r.attempts = 1;
            ro.setResolution(id, r);
            ReviewedProposal memory yes = _reviewed(id, uint8(Outcome.YES));
            Sig[] memory sy = _sigs(yes, 0, 1);
            vm.expectRevert(IResolutionOracle.OutcomeNotAllowed.selector);
            ro.submitReviewedProposal(id, yes, URI, sy);
            _propose(id, uint8(Outcome.NO)); // the remaining outcome is allowed
        }
    }

    function test_committee_signatures() public {
        (bytes32 id,) = _listNoFeed();
        _toReview(id);
        ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
        Sig[] memory one = new Sig[](1);
        one[0] = _sigs(p, 0, 1)[0];
        vm.expectRevert(IResolutionOracle.NotEnoughSignatures.selector);
        ro.submitReviewedProposal(id, p, URI, one);
        Sig[] memory s = _sigs(p, 0, 1);
        (s[0], s[1]) = (s[1], s[0]);
        vm.expectRevert(IResolutionOracle.SignersNotSorted.selector);
        ro.submitReviewedProposal(id, p, URI, s);
        vm.prank(guardian);
        ro.revokeCommitteeMember(1, members[1]); // revocation applies to the pinned set at once
        s = _sigs(p, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, members[1]));
        ro.submitReviewedProposal(id, p, URI, s);
        ro.submitReviewedProposal(id, p, URI, _sigs(p, 0, 2));
    }

    function test_committee_usesThePinnedSet() public {
        (bytes32 id,) = _listNoFeed();
        _toReview(id);
        vm.startPrank(gov);
        ro.createTrustSet(_trustSet());
        ro.activateTrustSet(2);
        vm.stopPrank();
        ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
        assertEq(p.trustSetId, 1);
        p.trustSetId = 2; // the active set is not the market's
        _expectBadPayload(id, p, 4);
        _propose(id, uint8(Outcome.YES)); // the pinned set 1 still decides
    }

    // ------------------------------------------------------------------ committee: EarlyReview (early halt)

    function _toEarlyReview(bytes32 id) internal {
        Resolution memory r;
        r.state = RState.EarlyReview;
        r.earlyStartedAt = uint64(block.timestamp);
        ro.setResolution(id, r);
    }

    /// Early committee proposals: halt the engine at block time, only before T and within the TTL, `early` flag set.
    function test_committee_early() public {
        uint256 snap = vm.snapshotState();
        {
            // test_committee_earlyHaltsTheEngineNow
            (bytes32 id, MockResolutionEngine e) = _listFeed();
            vm.warp(NOW + 100);
            _toEarlyReview(id);
            vm.warp(NOW + 200);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
            assertTrue(p.early);
            assertEq(p.trustSetId, 1, "the active set before the halt");
            vm.expectEmit(address(ro));
            emit IResolutionOracle.HaltRecorded(id, NOW + 200, OI, T + 7_200, 1, true);
            ro.submitReviewedProposal(id, p, URI, _sigs(p, 0, 1));
            Resolution memory r = _res(id);
            assertEq(r.haltedAt, NOW + 200, "the early halt is this block");
            assertEq(e.getHaltSnapshot().economicHaltAt, NOW + 200);
            assertEq(r.voidDeadline, T + 7_200, "max(haltedAt, T) + voidSecs");
            assertEq(r.trustSetId, 1);
            assertEq(uint8(r.state), uint8(RState.Proposed));
            assertEq(uint8(r.path), uint8(Path.REVIEWED), "early outcomes are always reviewed (ORC-15)");
        }
        vm.revertToState(snap);
        {
            // test_committee_earlyOnlyBeforeTAndWithinTtl
            (bytes32 id,) = _listFeed();
            vm.warp(NOW + 100);
            _toEarlyReview(id);
            vm.warp(NOW + 100 + 600); // the TTL (600 s) has run out
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
            Sig[] memory s = _sigs(p, 0, 1);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.EarlyReview));
            ro.submitReviewedProposal(id, p, URI, s);

            (bytes32 nf,) = _listNoFeed();
            vm.warp(T - 10);
            _toEarlyReview(nf);
            vm.warp(T); // within the TTL but at T
            p = _reviewed(nf, uint8(Outcome.YES));
            s = _sigs(p, 0, 1);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.EarlyReview));
            ro.submitReviewedProposal(nf, p, URI, s);
        }
        vm.revertToState(snap);
        {
            // test_committee_earlyFlagMustBeSet
            (bytes32 id,) = _listFeed();
            _toEarlyReview(id);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.YES));
            p.early = false;
            _expectBadPayload(id, p, 1);
        }
    }

    // ------------------------------------------------------------------ permissionless

    /// Permissionless proposals: recorded and asserted by the caller, the claim text, R_p from the pinned globals.
    function test_permissionless_records() public {
        uint256 snap = vm.snapshotState();
        {
            // test_permissionless_recordsAndAsserts
            (bytes32 id,) = _listNoFeed();
            _toOpen(id);
            _approveBond(proposer);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.ProposalRecorded(id, Outcome.YES, Path.PERMISSIONLESS, keccak256("snapshot"), URI, 0);
            vm.prank(proposer);
            bytes32 aid = ro.proposePermissionless(id, Outcome.YES, URI, keccak256("snapshot"));
            Resolution memory r = _res(id);
            assertEq(uint8(r.state), uint8(RState.Proposed));
            assertEq(uint8(r.path), uint8(Path.PERMISSIONLESS));
            assertEq(r.proposer, proposer);
            assertEq(r.attempts, 1);
            assertEq(r.assertionId, aid);
            assertEq(r.assertionVenue, address(mvenue));
            assertEq(r.bond, BOND);
            IAssertionVenue.AssertionStatus memory st = mvenue.statusOf(aid);
            assertEq(st.asserter, proposer, "the caller is the asserter");
            assertEq(st.bond, BOND);
            assertEq(st.expiresAt, T + 600 + 300, "reviewed liveness");
            assertEq(token.balanceOf(proposer), 0, "own bond, pulled from the caller");
            assertEq(treasury.totalOutstanding(), 0, "the treasury is not involved");
        }
        vm.revertToState(snap);
        {
            // test_permissionless_claimText
            (bytes32 id,) = _listNoFeed();
            _toOpen(id);
            _approveBond(proposer);
            vm.prank(proposer);
            bytes32 aid = ro.proposePermissionless(id, Outcome.NO, URI, keccak256("snapshot"));
            string memory claim = string(mvenue.claimOf(aid));
            assertTrue(_contains(claim, "Asserted outcome: NO\n"));
            assertTrue(_contains(claim, string.concat("Evidence: ", URI, ", keccak256 ")));
            assertTrue(_contains(claim, string.concat("Question: ", _market().question)));
            assertTrue(_contains(claim, "Scheduled time T: 2027-01-15T08:30:00Z (1800001800)"));
        }
        vm.revertToState(snap);
        {
            // test_permissionless_rewardFromThePinnedGlobals
            Globals memory g = _globals();
            g.proposerRewardAtoms = 7e6;
            vm.prank(gov);
            reg.setGlobals(g); // version 2, current at the halt
            (bytes32 id,) = _listNoFeed();
            _toOpen(id);
            g.proposerRewardAtoms = 9e6;
            vm.prank(gov);
            reg.setGlobals(g); // version 3, after the halt
            _approveBond(proposer);
            vm.prank(proposer);
            ro.proposePermissionless(id, Outcome.YES, URI, keccak256("snapshot"));
            assertEq(_res(id).rewardAtoms, 7e6, "R_p of the version pinned at the halt");
        }
    }

    /// Permissionless guards: Open only, outcome and attempts, evidence, expiry, the caller's bond approval.
    function test_permissionless_guards() public {
        uint256 snap = vm.snapshotState();
        {
            // test_permissionless_onlyInOpen
            (bytes32 id,) = _listNoFeed();
            _toReview(id);
            _approveBond(proposer);
            vm.prank(proposer);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Review));
            ro.proposePermissionless(id, Outcome.YES, URI, keccak256("snapshot"));
        }
        vm.revertToState(snap);
        {
            // test_permissionless_outcomeAndAttempts
            (bytes32 id,) = _listNoFeed();
            _toOpen(id);
            Resolution memory r = _res(id);
            r.rejectedMask = 2;
            r.attempts = 1;
            ro.setResolution(id, r);
            _approveBond(proposer);
            vm.startPrank(proposer);
            vm.expectRevert(IResolutionOracle.OutcomeNotAllowed.selector);
            ro.proposePermissionless(id, Outcome.YES, URI, keccak256("snapshot"));
            vm.expectRevert(IResolutionOracle.OutcomeNotAllowed.selector);
            ro.proposePermissionless(id, Outcome.NONE, URI, keccak256("snapshot"));
            vm.stopPrank();
            r.attempts = 3;
            ro.setResolution(id, r);
            vm.prank(proposer);
            vm.expectRevert(IResolutionOracle.MaxAttempts.selector);
            ro.proposePermissionless(id, Outcome.NO, URI, keccak256("snapshot"));
        }
        vm.revertToState(snap);
        {
            // test_permissionless_evidenceRules
            (bytes32 id,) = _listNoFeed();
            _toOpen(id);
            _approveBond(proposer);
            vm.startPrank(proposer);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, uint8(5)));
            ro.proposePermissionless(id, Outcome.YES, URI, 0);
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, uint8(5)));
            ro.proposePermissionless(id, Outcome.YES, "", keccak256("snapshot"));
            vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, uint8(5)));
            ro.proposePermissionless(id, Outcome.YES, string(new bytes(257)), keccak256("snapshot"));
            ro.proposePermissionless(id, Outcome.YES, string(new bytes(256)), keccak256("snapshot"));
            vm.stopPrank();
        }
        vm.revertToState(snap);
        {
            // test_permissionless_expiryGuard
            (bytes32 id,) = _listNoFeed();
            _toOpen(id);
            _approveBond(proposer);
            vm.warp(T + 7_200 - 300 + 1); // the 300 s liveness would end after voidDeadline
            vm.prank(proposer);
            vm.expectRevert(IResolutionOracle.ExpiryAfterVoidDeadline.selector);
            ro.proposePermissionless(id, Outcome.YES, URI, keccak256("snapshot"));
            vm.warp(T + 7_200 - 300); // ends exactly at voidDeadline
            vm.prank(proposer);
            ro.proposePermissionless(id, Outcome.YES, URI, keccak256("snapshot"));
        }
        vm.revertToState(snap);
        {
            // test_permissionless_needsTheBondApproval
            (bytes32 id,) = _listNoFeed();
            _toOpen(id);
            vm.prank(proposer); // no approval, no funds
            vm.expectRevert();
            ro.proposePermissionless(id, Outcome.YES, URI, keccak256("snapshot"));
            assertEq(uint8(_state(id)), uint8(RState.Open), "nothing recorded");
        }
    }

    // ------------------------------------------------------------------ helpers

    function _contains(string memory s, string memory needle) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(needle);
        if (b.length > a.length) return false;
        for (uint256 i; i + b.length <= a.length; ++i) {
            bool eq = true;
            for (uint256 j; j < b.length; ++j) {
                if (a[i + j] != b[j]) {
                    eq = false;
                    break;
                }
            }
            if (eq) return true;
        }
        return false;
    }
}
