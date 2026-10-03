// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {
    Outcome,
    Path,
    Phase,
    PanelLabel,
    PanelResult,
    Resolution,
    ReviewedProposal,
    RState,
    Sig,
    TrustSetInput
} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {SigLib} from "../../src/libraries/SigLib.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockERC1271Wallet} from "../mocks/MockERC1271Wallet.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O16.3: the adversarial suite of `submitReviewedProposal`. Every payload and signature-set
///         rejection runs in each state a committee may propose from (Review and Open on the pinned set,
///         EarlyReview on the active set) with its exact C.3 error; ERC-1271 members; and the committee
///         after a rejected early proposal, which waits for T before the market can open.
/// @dev Every state is reached through the real flow (panel result, L2 deadline, early check), not forced.
///      Each case changes one thing of a valid proposal, so only the check under test can fail, and each
///      state ends with the valid proposal accepted. Digests come from the oracle's `hashReviewedProposal`
///      view (O16.1). The committee is the fixture's three EOA members with threshold 2.
contract OracleCommitteeSigsTest is OracleFixture {
    uint8 internal constant Y = uint8(PanelLabel.YES);
    uint256 internal constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    /// The three states a committee proposal is accepted from.
    enum Entry {
        REVIEW, // L2 gate closed: pinned set, early = false
        OPEN, // after the L2 deadline: pinned set, early = false
        EARLY // EarlyReview before T: active set, early = true, halts the engine
    }

    // ------------------------------------------------------------------ payload checks

    /// marketId (7), deadline (`SignatureExpired`), attempt (2), rejectedMask (6), `early` (1), trust set
    /// (4), evidence URI (5) and the outcome (`OutcomeNotAllowed`), in every state.
    function test_payloadRejections() public {
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            Entry e = Entry(i);
            bytes32 id = _context(e);
            ReviewedProposal memory q;
            {
                // test_payload_marketId
                q = _reviewed(id, uint8(Outcome.NO));
                q.marketId = keccak256("another market");
                _expect(id, q, _two(q), _bad(7));
            }
            {
                // test_payload_expired
                q = _reviewed(id, uint8(Outcome.NO));
                q.deadline = uint64(block.timestamp - 1);
                _expect(id, q, _two(q), abi.encodeWithSelector(IResolutionOracle.SignatureExpired.selector));
            }
            {
                // test_payload_attempt
                q = _reviewed(id, uint8(Outcome.NO));
                q.attempt = 1;
                _expect(id, q, _two(q), _bad(2));
                q.attempt = type(uint8).max;
                _expect(id, q, _two(q), _bad(2));
            }
            {
                // test_payload_rejectedMask
                q = _reviewed(id, uint8(Outcome.NO));
                q.rejectedMask = 2; // claims YES was rejected
                _expect(id, q, _two(q), _bad(6));
                q.rejectedMask = 0x80; // a bit no outcome uses
                _expect(id, q, _two(q), _bad(6));
            }
            {
                // test_payload_earlyFlag
                q = _reviewed(id, uint8(Outcome.NO));
                q.early = !q.early;
                _expect(id, q, _two(q), _bad(1));
            }
            {
                // test_payload_trustSet
                q = _reviewed(id, uint8(Outcome.NO));
                q.trustSetId = 0;
                _expect(id, q, _two(q), _bad(4));
                q.trustSetId = 2; // does not exist
                _expect(id, q, _two(q), _bad(4));
            }
            {
                // test_payload_evidenceURI
                q = _reviewed(id, uint8(Outcome.NO));
                Sig[] memory s = _two(q);
                vm.expectRevert(_bad(5));
                ro.submitReviewedProposal(id, q, "ipfs://another-snapshot", s);
            }
            {
                // test_payload_outcome (NONE, one past INVALID, the top of uint8)
                uint8[3] memory outcomes = [uint8(Outcome.NONE), 4, type(uint8).max];
                for (uint256 k; k < 3; ++k) {
                    q = _reviewed(id, outcomes[k]);
                    _expect(id, q, _two(q), abi.encodeWithSelector(IResolutionOracle.OutcomeNotAllowed.selector));
                }
            }
            {
                // test_payload_validAccepted (signed to expire this second)
                q = _reviewed(id, uint8(Outcome.NO));
                q.deadline = uint64(block.timestamp);
                ro.submitReviewedProposal(id, q, URI, _two(q));
                assertEq(uint8(_state(id)), uint8(RState.Proposed));
                assertEq(uint8(_res(id).path), uint8(Path.REVIEWED));
            }
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------ signature sets

    /// Below threshold, duplicate, unsorted or zero signers, non-members, revoked members, and every
    /// invalid signature (changed payload, another member's signature, another domain, raw or `eth_sign`
    /// digest, a bad signature listed after valid ones), in every state.
    function test_signatureRejections() public {
        (address outsider, uint256 outsiderKey) = makeAddrAndKey("not a member");
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            Entry e = Entry(i);
            bytes32 id = _context(e);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.NO));
            bytes32 d = ro.hashReviewedProposal(p);
            bytes memory badSig = abi.encodeWithSelector(IResolutionOracle.BadSignature.selector);
            {
                // test_sig_belowThreshold
                bytes memory err = abi.encodeWithSelector(IResolutionOracle.NotEnoughSignatures.selector);
                _expect(id, p, new Sig[](0), err);
                Sig[] memory one = new Sig[](1);
                one[0] = Sig(members[0], _sign(memberKeys[0], d));
                _expect(id, p, one, err);
            }
            {
                // test_sig_duplicateSigner
                Sig[] memory s = new Sig[](2);
                s[0] = Sig(members[0], _sign(memberKeys[0], d));
                s[1] = s[0];
                _expect(id, p, s, abi.encodeWithSelector(IResolutionOracle.SignersNotSorted.selector));
            }
            {
                // test_sig_unsorted
                Sig[] memory s = _two(p);
                (s[0], s[1]) = (s[1], s[0]);
                _expect(id, p, s, abi.encodeWithSelector(IResolutionOracle.SignersNotSorted.selector));
            }
            {
                // test_sig_zeroSigner
                Sig[] memory s = _two(p);
                s[0] = Sig(address(0), s[0].signature);
                _expect(id, p, s, abi.encodeWithSelector(IResolutionOracle.SignersNotSorted.selector));
            }
            {
                // test_sig_nonMember
                Sig[] memory s =
                    _sortedPair(Sig(members[0], _sign(memberKeys[0], d)), Sig(outsider, _sign(outsiderKey, d)));
                _expect(id, p, s, abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, outsider));
            }
            {
                // test_sig_revokedMember
                uint32 setId = p.trustSetId;
                vm.prank(guardian);
                ro.revokeCommitteeMember(setId, members[1]);
                _expect(
                    id, p, _two(p), abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, members[1])
                );
                _expect(
                    id, p, _sigs3(p), abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, members[1])
                );
            }
            vm.revertToState(snap);
            id = _context(e);
            p = _reviewed(id, uint8(Outcome.NO));
            d = ro.hashReviewedProposal(p);
            {
                // test_sig_payloadChangedAfterSigning
                Sig[] memory s = _two(p);
                ReviewedProposal memory q = _reviewed(id, uint8(Outcome.INVALID));
                _expect(id, q, s, badSig);
                q = _reviewed(id, uint8(Outcome.NO));
                q.noteHash = keccak256("another note");
                _expect(id, q, s, badSig);
                q = _reviewed(id, uint8(Outcome.NO));
                q.evidenceHash = keccak256("another snapshot");
                _expect(id, q, s, badSig);
                q = _reviewed(id, uint8(Outcome.NO));
                q.deadline += 1;
                _expect(id, q, s, badSig);
            }
            {
                // test_sig_anotherMembersSignature
                Sig[] memory s = _two(p);
                s[1].signature = _sign(memberKeys[2], d); // members[1] presents members[2]'s signature
                _expect(id, p, s, badSig);
            }
            {
                // test_sig_otherDomain
                bytes32 structHash = SigLib.hashReviewedProposal(p);
                bytes32 otherChain = SigLib.digest(SigLib.domainSeparator(143, address(ro)), structHash);
                bytes32 otherOracle = SigLib.digest(SigLib.domainSeparator(block.chainid, address(0xBEEF)), structHash);
                _expect(id, p, _twoOver(otherChain), badSig);
                _expect(id, p, _twoOver(otherOracle), badSig);
            }
            {
                // test_sig_notTheTypedDataDigest
                bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", d));
                _expect(id, p, _twoOver(SigLib.hashReviewedProposal(p)), badSig);
                _expect(id, p, _twoOver(ethSigned), badSig);
            }
            {
                // test_sig_badSignatureAfterValidOnes (every listed signature is checked, none skipped)
                Sig[] memory s = _sigs3(p);
                s[2].signature = _sign(memberKeys[2], keccak256("something else"));
                _expect(id, p, s, badSig);
                s[2].signature = hex"00";
                _expect(id, p, s, badSig);
            }
            {
                // test_sig_validAccepted (all three members)
                ro.submitReviewedProposal(id, p, URI, _sigs3(p));
                assertEq(uint8(_state(id)), uint8(RState.Proposed));
            }
            vm.revertToState(snap);
        }
    }

    /// Accepted EOA signature forms. SignatureCheckerLib does not require low s and accepts EIP-2098
    /// 64-byte signatures; this is safe because no signature is used as an identifier: a replay is refused
    /// by the state, attempt, mask and deadline. Pinned here so a change is deliberate.
    function test_acceptedSignatureForms() public {
        uint256 snap = vm.snapshotState();
        {
            // test_form_highSTwin
            bytes32 id = _context(Entry.REVIEW);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.NO));
            bytes32 d = ro.hashReviewedProposal(p);
            Sig[] memory s = _two(p);
            (uint8 v, bytes32 r, bytes32 sv) = vm.sign(memberKeys[1], d);
            s[1].signature = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(sv)), v == 27 ? uint8(28) : uint8(27));
            ro.submitReviewedProposal(id, p, URI, s);
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
            // The low-s originals of the same signatures cannot replay the proposal.
            _expect(id, p, _two(p), abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_form_eip2098Compact
            bytes32 id = _context(Entry.REVIEW);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.NO));
            bytes32 d = ro.hashReviewedProposal(p);
            Sig[] memory s = _two(p);
            (bytes32 r, bytes32 vs) = vm.signCompact(memberKeys[0], d);
            s[0].signature = abi.encodePacked(r, vs);
            ro.submitReviewedProposal(id, p, URI, s);
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
    }

    // ------------------------------------------------------------------ trust sets

    /// Review keeps the pinned set's committee after a rotation; EarlyReview uses the active set's.
    function test_trustSets() public {
        (address m4, uint256 k4) = makeAddrAndKey("member of set 2 only");
        uint256 snap = vm.snapshotState();
        {
            // test_rotation_reviewKeepsThePinnedCommittee
            bytes32 id = _context(Entry.REVIEW); // pinned to set 1
            _activateSet2(m4);
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.NO));
            assertEq(p.trustSetId, 1);
            bytes32 d = ro.hashReviewedProposal(p);
            Sig[] memory s = _sortedPair(Sig(members[0], _sign(memberKeys[0], d)), Sig(m4, _sign(k4, d)));
            _expect(id, p, s, abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, m4));
            vm.prank(guardian);
            ro.revokeCommitteeMember(2, members[1]); // set 2's revocation does not touch set 1
            ro.submitReviewedProposal(id, p, URI, _two(p));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_rotation_earlyUsesTheActiveCommittee
            bytes32 id = _context(Entry.EARLY);
            _activateSet2(m4);
            ReviewedProposal memory old = _reviewed(id, uint8(Outcome.NO));
            old.trustSetId = 1;
            _expect(id, old, _two(old), _bad(4));
            ReviewedProposal memory p = _reviewed(id, uint8(Outcome.NO));
            assertEq(p.trustSetId, 2);
            bytes32 d = ro.hashReviewedProposal(p);
            Sig[] memory s = _sortedPair(Sig(members[0], _sign(memberKeys[0], d)), Sig(m4, _sign(k4, d)));
            ro.submitReviewedProposal(id, p, URI, s);
            Resolution memory r = _res(id);
            assertEq(r.trustSetId, 2, "the early halt pins the active set");
            assertEq(uint8(r.state), uint8(RState.Proposed));
        }
    }

    // ------------------------------------------------------------------ ERC-1271 members

    /// A contract member (ERC-1271) signs through its wallet: accepted with its owner's signature, refused
    /// (`BadSignature`) when the wallet refuses, returns a wrong magic value, reverts or returns nothing,
    /// and `NotCommitteeMember` when revoked or when its owner signs as itself.
    function test_erc1271Member() public {
        (address walletOwner, uint256 ownerKey) = makeAddrAndKey("wallet owner");
        MockERC1271Wallet wallet = new MockERC1271Wallet(walletOwner);
        _activateSet2(address(wallet)); // committee: the three fixture members and the wallet, threshold 2
        bytes32 id = _context(Entry.REVIEW); // halted after the rotation: pinned to set 2
        ReviewedProposal memory p = _reviewed(id, uint8(Outcome.NO));
        assertEq(p.trustSetId, 2);
        bytes32 d = ro.hashReviewedProposal(p);
        Sig[] memory s = _sortedPair(Sig(members[0], _sign(memberKeys[0], d)), Sig(address(wallet), _sign(ownerKey, d)));
        bytes memory badSig = abi.encodeWithSelector(IResolutionOracle.BadSignature.selector);
        uint256 snap = vm.snapshotState();
        {
            // test_1271_ownerSignatureOverAnotherDigest
            Sig[] memory t = _sortedPair(
                Sig(members[0], _sign(memberKeys[0], d)),
                Sig(address(wallet), _sign(ownerKey, keccak256("another digest")))
            );
            _expect(id, p, t, badSig);
        }
        {
            // test_1271_walletModes
            wallet.setMode(MockERC1271Wallet.Mode.WRONG_MAGIC);
            _expect(id, p, s, badSig);
            wallet.setMode(MockERC1271Wallet.Mode.REVERT);
            _expect(id, p, s, badSig);
            wallet.setMode(MockERC1271Wallet.Mode.EMPTY);
            _expect(id, p, s, badSig);
            wallet.setMode(MockERC1271Wallet.Mode.OWNER);
        }
        {
            // test_1271_ownerIsNotTheMember
            Sig[] memory t = _sortedPair(Sig(members[0], _sign(memberKeys[0], d)), Sig(walletOwner, _sign(ownerKey, d)));
            _expect(id, p, t, abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, walletOwner));
        }
        {
            // test_1271_revoked
            vm.prank(guardian);
            ro.revokeCommitteeMember(2, address(wallet));
            _expect(id, p, s, abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, address(wallet)));
        }
        vm.revertToState(snap);
        {
            // test_1271_accepted
            ro.submitReviewedProposal(id, p, URI, s);
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
            assertEq(uint8(_res(id).proposed), uint8(Outcome.NO));
        }
    }

    // ------------------------------------------------------------------ after a rejected early proposal

    /// An early YES is asserted and rejected before T: the market is in Review with attempt 1 and YES in
    /// the mask. A proposal signed for the old attempt, the old mask or `early = true`, or for the
    /// rejected YES, is refused; `openAfterDeadline` returns false until T (ORC-15); the committee may
    /// still propose NO before T, and the market opens at T.
    function test_afterRejectedEarlyProposal() public {
        bytes32 id = _context(Entry.EARLY);
        vm.warp(NOW + 180);
        ReviewedProposal memory early = _reviewed(id, uint8(Outcome.YES));
        assertTrue(early.early);
        ro.submitReviewedProposal(id, early, URI, _two(early));
        assertTrue(ro.assertProposal(id));
        mvenue.setResult(_res(id).assertionId, false);
        ro.finalizeMarket(id);
        Resolution memory r = _res(id);
        assertEq(uint8(r.state), uint8(RState.Review));
        assertEq(r.attempts, 1);
        assertEq(r.rejectedMask, 2, "YES rejected");
        uint64 retryOpensAt = r.retryOpensAt;
        assertLt(retryOpensAt, T, "the retry window ends before T");

        ReviewedProposal memory q;
        {
            // test_rejected_staleAttempt
            q = _reviewed(id, uint8(Outcome.NO));
            q.attempt = 0;
            _expect(id, q, _two(q), _bad(2));
        }
        {
            // test_rejected_staleMask
            q = _reviewed(id, uint8(Outcome.NO));
            q.rejectedMask = 0;
            _expect(id, q, _two(q), _bad(6));
        }
        {
            // test_rejected_earlyFlagNoLongerSet (the market is halted and in Review)
            q = _reviewed(id, uint8(Outcome.NO));
            assertFalse(q.early);
            q.early = true;
            _expect(id, q, _two(q), _bad(1));
        }
        {
            // test_rejected_outcomeRefused (ORC-6)
            q = _reviewed(id, uint8(Outcome.YES));
            _expect(id, q, _two(q), abi.encodeWithSelector(IResolutionOracle.OutcomeNotAllowed.selector));
        }
        {
            // test_rejected_oldSignaturesCannotReplay
            _expect(id, early, _two(early), _bad(2));
        }
        {
            // test_rejected_opensOnlyAtT
            vm.warp(retryOpensAt);
            assertFalse(ro.openAfterDeadline(id), "retry window over, but before T");
            vm.warp(T - 1);
            assertFalse(ro.openAfterDeadline(id), "one second before T");
            assertEq(uint8(_state(id)), uint8(RState.Review));
        }
        uint256 snap = vm.snapshotState();
        {
            // test_rejected_committeeMayProposeBeforeT
            q = _reviewed(id, uint8(Outcome.NO));
            ro.submitReviewedProposal(id, q, URI, _two(q));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
            assertEq(_res(id).attempts, 1, "attempts count assertions, not proposals");
        }
        vm.revertToState(snap);
        {
            // test_rejected_opensAtT
            vm.warp(T);
            assertTrue(ro.openAfterDeadline(id));
            assertEq(uint8(_state(id)), uint8(RState.Open));
        }
    }

    // ------------------------------------------------------------------ helpers

    /// A market in the entry state, through the real flow: Review (a no-feed market whose panel result
    /// fails the gate: no category validated), Open (its L2 deadline passed), or EarlyReview (a feed
    /// market's early check with a confident unanimous panel, before T).
    function _context(Entry e) internal returns (bytes32 id) {
        if (e == Entry.EARLY) {
            MockResolutionEngine eng;
            (id, eng) = _listFeed();
            vm.startPrank(monitor);
            eng.setMonitorRestricted(true);
            ro.requestEarlyCheck(id);
            vm.stopPrank();
            assertEq(uint8(_panel(id, Phase.EARLY)), uint8(RState.EarlyReview));
        } else {
            (id,) = _listNoFeed();
            if (e == Entry.OPEN) {
                _toOpen(id);
                assertEq(uint8(_state(id)), uint8(RState.Open));
            } else {
                _halt(id);
                assertEq(uint8(_panel(id, Phase.POST_T)), uint8(RState.Review));
            }
        }
    }

    /// Submits three confident YES labels for the market, signed by the trust set's attestor.
    function _panel(bytes32 id, Phase phase) internal returns (RState) {
        Resolution memory r = _res(id);
        PanelResult memory p;
        p.marketId = id;
        p.phase = uint8(phase);
        p.attempt = r.attempts;
        p.labels = [Y, Y, Y];
        p.calibratedBps = [uint16(9_500), uint16(9_500), uint16(9_500)];
        p.evidenceHash = keccak256("snapshot");
        p.evidenceURIHash = keccak256(bytes(URI));
        p.gateHash = reg.getMarketCore(id).gateHash;
        p.trustSetId = r.trustSetId != 0 ? r.trustSetId : ro.activeTrustSetId();
        p.deadline = uint64(block.timestamp + 1 hours);
        return ro.submitPanelResult(id, p, URI, _sign(attestorKey, ro.hashPanelResult(p)));
    }

    function _expect(bytes32 id, ReviewedProposal memory p, Sig[] memory s, bytes memory err) internal {
        vm.expectRevert(err);
        ro.submitReviewedProposal(id, p, URI, s);
    }

    /// Members 0 and 1 (ascending) sign `p` through the oracle's view.
    function _two(ReviewedProposal memory p) internal view returns (Sig[] memory s) {
        bytes32 d = ro.hashReviewedProposal(p);
        s = new Sig[](2);
        s[0] = Sig(members[0], _sign(memberKeys[0], d));
        s[1] = Sig(members[1], _sign(memberKeys[1], d));
    }

    /// All three members sign `p`.
    function _sigs3(ReviewedProposal memory p) internal view returns (Sig[] memory s) {
        bytes32 d = ro.hashReviewedProposal(p);
        s = new Sig[](3);
        for (uint256 i; i < 3; ++i) {
            s[i] = Sig(members[i], _sign(memberKeys[i], d));
        }
    }

    /// Members 0 and 1 sign an arbitrary digest.
    function _twoOver(bytes32 d) internal view returns (Sig[] memory s) {
        s = new Sig[](2);
        s[0] = Sig(members[0], _sign(memberKeys[0], d));
        s[1] = Sig(members[1], _sign(memberKeys[1], d));
    }

    function _sortedPair(Sig memory a, Sig memory b) internal pure returns (Sig[] memory s) {
        s = new Sig[](2);
        (s[0], s[1]) = a.signer < b.signer ? (a, b) : (b, a);
    }

    function _bad(uint8 code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, code);
    }

    /// Creates set 2 (the fixture set whose committee also has `extra`, threshold 2) and activates it.
    function _activateSet2(address extra) internal {
        TrustSetInput memory t = _trustSet();
        address[] memory c = new address[](4);
        for (uint256 i; i < 3; ++i) {
            c[i] = members[i];
        }
        c[3] = extra;
        for (uint256 i = 3; i > 0 && c[i] < c[i - 1]; --i) {
            (c[i], c[i - 1]) = (c[i - 1], c[i]);
        }
        t.committee = c;
        vm.startPrank(gov);
        ro.createTrustSet(t);
        ro.activateTrustSet(2);
        vm.stopPrank();
    }
}
