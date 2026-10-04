// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Outcome, Phase, PanelLabel, PanelResult, RState, TrustSetInput} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {SigLib} from "../../src/libraries/SigLib.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O16.2: the adversarial suite of the panel entry points. Every payload and signature
///         rejection runs on each entry point (`submitPanelResult` in EarlyCheck and in L2Pending,
///         `submitPanelProposal` in L2Pending) with its exact C.3 error and code; the auto gate's
///         rejections revert `submitPanelProposal` and route `submitPanelResult` to Review.
/// @dev Each case changes one field of a valid result and re-signs it, so only the check under test can
///      fail; signature cases keep the payload and break the signature. Every entry point ends with the
///      valid result accepted, so a rejection is never explained by an unusable fixture. Digests come
///      from the oracle's own view (`hashPanelResult`, O16.1). Boundaries (θ_hi, the exact review limit,
///      `now == deadline`, validation at the halt block) are in `OraclePanel.t.sol` (O14.5).
contract OraclePanelSigsTest is OracleFixture {
    bytes32 internal constant SPORTS = keccak256("sports");
    uint8 internal constant Y = uint8(PanelLabel.YES);
    uint8 internal constant N = uint8(PanelLabel.NO);
    uint256 internal constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    /// The three panel entry points with their phase and trust set.
    enum Entry {
        EARLY_RESULT, // submitPanelResult in EarlyCheck: phase EARLY, active set
        L2_RESULT, // submitPanelResult in L2Pending: phase POST_T, pinned set
        L2_PROPOSAL // submitPanelProposal in L2Pending: phase POST_T, pinned set
    }

    // ------------------------------------------------------------------ payload checks

    /// marketId (7), deadline (`SignatureExpired`), attempt (2), trust set (4), evidence URI hash and
    /// length (5), phase (1) and gateHash (3), on every entry point.
    function test_payloadRejections() public {
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            Entry e = Entry(i);
            bytes32 id = _context(e);
            PanelResult memory q;
            {
                // test_payload_marketId
                q = _valid(e, id);
                q.marketId = keccak256("another market");
                _expect(e, id, q, URI, _psig(q), _bad(7));
            }
            {
                // test_payload_expired
                q = _valid(e, id);
                q.deadline = uint64(block.timestamp - 1);
                _expect(e, id, q, URI, _psig(q), abi.encodeWithSelector(IResolutionOracle.SignatureExpired.selector));
            }
            {
                // test_payload_attempt
                q = _valid(e, id);
                q.attempt = 1;
                _expect(e, id, q, URI, _psig(q), _bad(2));
                q.attempt = type(uint8).max;
                _expect(e, id, q, URI, _psig(q), _bad(2));
            }
            {
                // test_payload_trustSet
                q = _valid(e, id);
                q.trustSetId = 0;
                _expect(e, id, q, URI, _psig(q), _bad(4));
                q.trustSetId = 2; // does not exist
                _expect(e, id, q, URI, _psig(q), _bad(4));
            }
            {
                // test_payload_evidenceURIHash
                q = _valid(e, id);
                _expect(e, id, q, "ipfs://another-snapshot", _psig(q), _bad(5));
            }
            {
                // test_payload_evidenceURIEmpty
                q = _valid(e, id);
                q.evidenceURIHash = keccak256("");
                _expect(e, id, q, "", _psig(q), _bad(5));
            }
            {
                // test_payload_evidenceURITooLong
                string memory uri = _uri(257);
                q = _valid(e, id);
                q.evidenceURIHash = keccak256(bytes(uri));
                _expect(e, id, q, uri, _psig(q), _bad(5));
            }
            {
                // test_payload_phase
                q = _valid(e, id);
                q.phase = uint8(e == Entry.EARLY_RESULT ? Phase.POST_T : Phase.EARLY);
                _expect(e, id, q, URI, _psig(q), _bad(1));
                q.phase = uint8(Phase.NONE);
                _expect(e, id, q, URI, _psig(q), _bad(1));
                q.phase = 3; // not a Phase
                _expect(e, id, q, URI, _psig(q), _bad(1));
            }
            {
                // test_payload_gateHash
                q = _valid(e, id);
                q.gateHash = keccak256("another panel configuration");
                _expect(e, id, q, URI, _psig(q), _bad(3));
            }
            {
                // test_payload_validAccepted (256-byte URI, the maximum; signed to expire this second)
                string memory uri = _uri(256);
                q = _valid(e, id);
                q.evidenceURIHash = keccak256(bytes(uri));
                q.deadline = uint64(block.timestamp);
                _send(e, id, q, uri, _psig(q));
                assertEq(uint8(_state(id)), uint8(_accepted(e)), "valid result accepted");
            }
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------ signatures

    /// `BadSignature` on every entry point for: another key, a payload changed after signing, a signature
    /// for another chain or another oracle, a raw struct hash or an `eth_sign` message, the malleable
    /// high-s twin, `v` in {0, 1}, and a signature that is not 65 bytes.
    function test_signatureRejections() public {
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            Entry e = Entry(i);
            bytes32 id = _context(e);
            PanelResult memory p = _valid(e, id);
            bytes32 d = ro.hashPanelResult(p);
            bytes memory bad = abi.encodeWithSelector(IResolutionOracle.BadSignature.selector);
            {
                // test_sig_wrongSigner
                (, uint256 other) = makeAddrAndKey("not the attestor");
                _expect(e, id, p, URI, _sign(other, d), bad);
                _expect(e, id, p, URI, _sign(memberKeys[0], d), bad); // a committee member is not the attestor
            }
            {
                // test_sig_payloadChangedAfterSigning
                bytes memory sig = _psig(p);
                PanelResult memory q = _valid(e, id);
                q.labels[1] = N;
                _expect(e, id, q, URI, sig, bad);
                q = _valid(e, id);
                q.calibratedBps[2] = 10_000;
                _expect(e, id, q, URI, sig, bad);
                q = _valid(e, id);
                q.evidenceHash = keccak256("another snapshot");
                _expect(e, id, q, URI, sig, bad);
                q = _valid(e, id);
                q.flags = 1;
                _expect(e, id, q, URI, sig, bad);
                q = _valid(e, id);
                q.deadline += 1;
                _expect(e, id, q, URI, sig, bad);
            }
            {
                // test_sig_otherDomain
                bytes32 structHash = SigLib.hashPanelResult(p);
                bytes32 otherChain = SigLib.digest(SigLib.domainSeparator(143, address(ro)), structHash);
                bytes32 otherOracle = SigLib.digest(SigLib.domainSeparator(block.chainid, address(0xBEEF)), structHash);
                _expect(e, id, p, URI, _sign(attestorKey, otherChain), bad);
                _expect(e, id, p, URI, _sign(attestorKey, otherOracle), bad);
            }
            {
                // test_sig_notTheTypedDataDigest
                bytes32 structHash = SigLib.hashPanelResult(p);
                bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", d));
                _expect(e, id, p, URI, _sign(attestorKey, structHash), bad);
                _expect(e, id, p, URI, _sign(attestorKey, ethSigned), bad);
            }
            {
                // test_sig_malleableTwin
                (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, d);
                bytes32 twinS = bytes32(SECP256K1_N - uint256(s));
                uint8 twinV = v == 27 ? 28 : 27;
                assertEq(ecrecover(d, twinV, r, twinS), attestor, "the twin recovers the attestor");
                _expect(e, id, p, URI, abi.encodePacked(r, twinS, twinV), bad);
            }
            {
                // test_sig_vNotNormalized
                (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, d);
                _expect(e, id, p, URI, abi.encodePacked(r, s, v - 27), bad);
            }
            {
                // test_sig_length
                bytes memory sig = _psig(p);
                _expect(e, id, p, URI, "", bad);
                _expect(e, id, p, URI, _slice(sig, 64), bad);
                _expect(e, id, p, URI, bytes.concat(sig, hex"00"), bad);
            }
            {
                // test_sig_validAccepted
                _send(e, id, p, URI, _psig(p));
                assertEq(uint8(_state(id)), uint8(_accepted(e)));
            }
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------ trust sets and revocation

    /// After a rotation, L2Pending keeps the pinned set and EarlyCheck uses the active one: naming the
    /// other set is `BadPayload(4)`, and a signature by the other set's attestor is `BadSignature`.
    /// A revoked attestor is refused at once on every entry point; revoking another set's attestor
    /// changes nothing.
    function test_trustSets() public {
        (address attestor2, uint256 key2) = makeAddrAndKey("attestor of set 2");
        uint256 snap = vm.snapshotState();
        for (uint256 i = 1; i < 3; ++i) {
            // test_rotation_l2KeepsThePinnedSet (result, then proposal)
            Entry e = Entry(i);
            bytes32 id = _context(e); // pinned to set 1
            _activateSet2(attestor2);
            PanelResult memory p = _valid(e, id);
            assertEq(p.trustSetId, 1);
            PanelResult memory q = _valid(e, id);
            q.trustSetId = 2;
            _expect(e, id, q, URI, _sign(key2, ro.hashPanelResult(q)), _bad(4));
            _expect(e, id, p, URI, _sign(key2, ro.hashPanelResult(p)), _badSig());
            _send(e, id, p, URI, _psig(p));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
            vm.revertToState(snap);
        }
        {
            // test_rotation_earlyUsesTheActiveSet
            bytes32 id = _context(Entry.EARLY_RESULT);
            _activateSet2(attestor2);
            PanelResult memory old = _valid(Entry.EARLY_RESULT, id);
            old.trustSetId = 1;
            _expect(Entry.EARLY_RESULT, id, old, URI, _psig(old), _bad(4));
            PanelResult memory p = _valid(Entry.EARLY_RESULT, id);
            assertEq(p.trustSetId, 2);
            _expect(Entry.EARLY_RESULT, id, p, URI, _psig(p), _badSig()); // set 1's attestor
            _send(Entry.EARLY_RESULT, id, p, URI, _sign(key2, ro.hashPanelResult(p)));
            assertEq(uint8(_state(id)), uint8(RState.EarlyReview));
        }
        vm.revertToState(snap);
        for (uint256 i; i < 3; ++i) {
            // test_revokedAttestor (every entry point)
            Entry e = Entry(i);
            bytes32 id = _context(e);
            PanelResult memory p = _valid(e, id);
            bytes memory sig = _psig(p);
            vm.prank(guardian);
            ro.revokeAttestor(1);
            _expect(e, id, p, URI, sig, _badSig());
            vm.revertToState(snap);
        }
        {
            // test_revokingAnotherSetChangesNothing
            bytes32 id = _context(Entry.L2_PROPOSAL); // pinned to set 1
            _activateSet2(attestor2);
            vm.prank(guardian);
            ro.revokeAttestor(2);
            PanelResult memory p = _valid(Entry.L2_PROPOSAL, id);
            _send(Entry.L2_PROPOSAL, id, p, URI, _psig(p));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
    }

    // ------------------------------------------------------------------ auto gate

    /// Each gate rejection reverts `submitPanelProposal` with its `GateClosed` code, and the same signed
    /// result sent to `submitPanelResult` is accepted but routed to Review with no proposal.
    function test_gateRejections() public {
        uint256 snap = vm.snapshotState();
        {
            // test_gate_split
            bytes32 id = _context(Entry.L2_PROPOSAL);
            PanelResult memory p = _valid(Entry.L2_PROPOSAL, id);
            p.labels = [Y, Y, N];
            _gateCase(id, p, 1);
        }
        vm.revertToState(snap);
        {
            // test_gate_confidenceBelowThreshold
            bytes32 id = _context(Entry.L2_PROPOSAL);
            PanelResult memory p = _valid(Entry.L2_PROPOSAL, id);
            p.calibratedBps[1] = 5_000;
            _gateCase(id, p, 2);
        }
        vm.revertToState(snap);
        {
            // test_gate_categoryNotValidated
            (bytes32 id,) = _listNoFeed();
            _halt(id);
            _gateCase(id, _valid(Entry.L2_PROPOSAL, id), 3); // no category recorded
        }
        vm.revertToState(snap);
        {
            // test_gate_categoryRecordedButNotValidated (the market's gateHash, validated = false)
            (bytes32 id,) = _listNoFeed();
            vm.prank(gov);
            reg.setCategory(SPORTS, _gate(), 200, 150, false);
            _halt(id);
            _gateCase(id, _valid(Entry.L2_PROPOSAL, id), 3);
        }
        vm.revertToState(snap);
        {
            // test_gate_oiAboveReviewLimit
            (bytes32 id, MockResolutionEngine e) = _listNoFeed();
            _validate();
            e.setOiLots(1_668_001); // 1,668,001,000 atoms > 1,668,000,000
            _halt(id);
            _gateCase(id, _valid(Entry.L2_PROPOSAL, id), 4);
        }
        vm.revertToState(snap);
        {
            // test_gate_flags
            bytes32 id = _context(Entry.L2_PROPOSAL);
            PanelResult memory p = _valid(Entry.L2_PROPOSAL, id);
            p.flags = 1; // injection suspected
            _gateCase(id, p, 5);
        }
        vm.revertToState(snap);
        {
            // test_gate_noEvidence
            bytes32 id = _context(Entry.L2_PROPOSAL);
            PanelResult memory p = _valid(Entry.L2_PROPOSAL, id);
            p.evidenceHash = 0;
            _gateCase(id, p, 6);
        }
    }

    // ------------------------------------------------------------------ state

    /// Outside their states both entry points revert `WrongState`, including a replay of an accepted
    /// result; an unknown market reverts `UnknownMarket`.
    function test_wrongState() public {
        uint256 snap = vm.snapshotState();
        {
            // test_state_none
            (bytes32 id,) = _listNoFeed();
            PanelResult memory p = _valid(Entry.L2_RESULT, id);
            _expectBoth(id, p, abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.None));
        }
        vm.revertToState(snap);
        {
            // test_state_earlyCheckRefusesTheProposal
            bytes32 id = _context(Entry.EARLY_RESULT);
            PanelResult memory p = _valid(Entry.EARLY_RESULT, id);
            _expect(
                Entry.L2_PROPOSAL,
                id,
                p,
                URI,
                _psig(p),
                abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.EarlyCheck)
            );
        }
        vm.revertToState(snap);
        {
            // test_state_l1Pending
            (bytes32 id,) = _listFeed();
            _halt(id);
            PanelResult memory p = _valid(Entry.L2_RESULT, id);
            _expectBoth(id, p, abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.L1Pending));
        }
        vm.revertToState(snap);
        {
            // test_state_replayAfterProposal
            bytes32 id = _context(Entry.L2_PROPOSAL);
            PanelResult memory p = _valid(Entry.L2_PROPOSAL, id);
            bytes memory sig = _psig(p);
            ro.submitPanelProposal(id, p, URI, sig);
            bytes memory err = abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Proposed);
            _expect(Entry.L2_PROPOSAL, id, p, URI, sig, err);
            _expect(Entry.L2_RESULT, id, p, URI, sig, err);
        }
        vm.revertToState(snap);
        {
            // test_state_replayAfterReview
            bytes32 id = _context(Entry.L2_RESULT);
            PanelResult memory p = _valid(Entry.L2_RESULT, id);
            p.labels = [Y, N, N];
            bytes memory sig = _psig(p);
            assertEq(uint8(ro.submitPanelResult(id, p, URI, sig)), uint8(RState.Review));
            _expectBoth(id, p, abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Review));
        }
        vm.revertToState(snap);
        {
            // test_state_unknownMarket
            bytes32 id = keccak256("never listed");
            PanelResult memory p = _valid(Entry.L2_RESULT, id);
            p.trustSetId = 1;
            _expectBoth(id, p, abi.encodeWithSelector(IResolutionOracle.UnknownMarket.selector));
        }
    }

    // ------------------------------------------------------------------ helpers

    /// A market in the entry point's state: a feed market in EarlyCheck before T, or a no-feed market
    /// halted at T into L2Pending with its category validated before the halt (the gate passes).
    function _context(Entry e) internal returns (bytes32 id) {
        if (e == Entry.EARLY_RESULT) {
            MockResolutionEngine eng;
            (id, eng) = _listFeed();
            vm.startPrank(monitor);
            eng.setMonitorRestricted(true);
            ro.requestEarlyCheck(id);
            vm.stopPrank();
        } else {
            (id,) = _listNoFeed();
            _validate();
            _halt(id);
        }
    }

    /// A result every check of `e` accepts: three confident YES labels for the market's gate.
    function _valid(Entry e, bytes32 id) internal view returns (PanelResult memory p) {
        p.marketId = id;
        p.phase = uint8(e == Entry.EARLY_RESULT ? Phase.EARLY : Phase.POST_T);
        p.attempt = _res(id).attempts;
        p.labels = [Y, Y, Y];
        p.calibratedBps = [uint16(9_100), uint16(9_500), uint16(9_900)];
        p.evidenceHash = keccak256("snapshot");
        p.evidenceURIHash = keccak256(bytes(URI));
        p.gateHash = _gate();
        uint32 pinned = _res(id).trustSetId;
        p.trustSetId = e == Entry.EARLY_RESULT || pinned == 0 ? ro.activeTrustSetId() : pinned;
        p.deadline = uint64(block.timestamp + 1 hours);
    }

    /// The state a valid result of `e` reaches.
    function _accepted(Entry e) internal pure returns (RState) {
        return e == Entry.EARLY_RESULT ? RState.EarlyReview : RState.Proposed;
    }

    function _send(Entry e, bytes32 id, PanelResult memory p, string memory uri, bytes memory sig) internal {
        if (e == Entry.L2_PROPOSAL) ro.submitPanelProposal(id, p, uri, sig);
        else ro.submitPanelResult(id, p, uri, sig);
    }

    function _expect(Entry e, bytes32 id, PanelResult memory p, string memory uri, bytes memory sig, bytes memory err)
        internal
    {
        vm.expectRevert(err);
        _send(e, id, p, uri, sig);
    }

    /// The same signed result refused by both entry points.
    function _expectBoth(bytes32 id, PanelResult memory p, bytes memory err) internal {
        bytes memory sig = _psig(p);
        _expect(Entry.L2_RESULT, id, p, URI, sig, err);
        _expect(Entry.L2_PROPOSAL, id, p, URI, sig, err);
    }

    /// `submitPanelProposal` reverts `GateClosed(code)`; `submitPanelResult` routes to Review.
    function _gateCase(bytes32 id, PanelResult memory p, uint8 code) internal {
        bytes memory sig = _psig(p);
        _expect(Entry.L2_PROPOSAL, id, p, URI, sig, abi.encodeWithSelector(IResolutionOracle.GateClosed.selector, code));
        assertEq(uint8(_state(id)), uint8(RState.L2Pending), "nothing recorded");
        assertEq(uint8(ro.submitPanelResult(id, p, URI, sig)), uint8(RState.Review));
        assertEq(uint8(_res(id).proposed), uint8(Outcome.NONE));
    }

    function _psig(PanelResult memory p) internal view returns (bytes memory) {
        return _sign(attestorKey, ro.hashPanelResult(p));
    }

    function _bad(uint8 code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IResolutionOracle.BadPayload.selector, code);
    }

    function _badSig() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IResolutionOracle.BadSignature.selector);
    }

    /// keccak256(abi.encode(modelIdHashes, promptHash, calibratorHash, highConfBps)) of the fixture market.
    function _gate() internal pure returns (bytes32) {
        bytes32[3] memory models = [keccak256("a:m1@1"), keccak256("b:m2@1"), keccak256("c:m3@1")];
        return keccak256(abi.encode(models, keccak256("prompt"), keccak256("calibrator"), uint16(9_100)));
    }

    /// Validates the fixture category for the market's gate (U95 200 bps, N 150: within the globals).
    function _validate() internal {
        vm.prank(gov);
        reg.setCategory(SPORTS, _gate(), 200, 150, true);
    }

    /// Creates set 2 (the fixture set with another attestor) and makes it the active set.
    function _activateSet2(address attestor2) internal {
        TrustSetInput memory t = _trustSet();
        t.runnerAttestor = attestor2;
        vm.startPrank(gov);
        ro.createTrustSet(t);
        ro.activateTrustSet(2);
        vm.stopPrank();
    }

    /// An `ipfs://` URI of exactly `n` bytes.
    function _uri(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        bytes memory prefix = "ipfs://";
        for (uint256 i; i < n; ++i) {
            b[i] = i < prefix.length ? prefix[i] : bytes1("a");
        }
        return string(b);
    }

    function _slice(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
    }
}
