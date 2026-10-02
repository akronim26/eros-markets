// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {PanelResult, ReviewedProposal, Sig} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {SigLib} from "../../src/libraries/SigLib.sol";

/// @dev Minimal ERC-1271 wallet: approves exactly the hashes it was told to.
contract Wallet1271 {
    mapping(bytes32 => bool) public approved;

    function approve(bytes32 h) external {
        approved[h] = true;
    }

    function isValidSignature(bytes32 h, bytes calldata) external view returns (bytes4) {
        return approved[h] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @notice Task O10.5: SigLib digests against the C.7 vectors, panel signature rules and every
///         m-of-k failure mode.
contract SigLibTest is Test {
    using stdJson for string;

    bytes32 internal constant HASH = keccak256("digest");
    uint256 internal constant N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    // ------------------------------------------------------------------ C.7 digests

    function test_digestP1() public view {
        string memory j = vm.readFile("vectors/eip712.json");
        PanelResult memory r;
        r.marketId = keccak256("market-1");
        r.phase = 2;
        r.attempt = 0;
        r.labels = [uint8(1), 1, 1];
        r.calibratedBps = [uint16(9500), 9400, 9300];
        r.evidenceHash = keccak256("snapshot");
        r.evidenceURIHash = keccak256("ipfs://bafy");
        r.gateHash = keccak256("gate");
        r.flags = 0;
        r.trustSetId = 1;
        r.deadline = 1800000000;
        bytes32 d = SigLib.digest(_domain(j), SigLib.hashPanelResult(r));
        assertEq(d, j.readBytes32(".P1.digest"));
        assertEq(d, 0xc31506d1641a8f03330d1ba677ab016d51c96b1af48ae24d475b84413535b5bc);
    }

    function test_digestR1() public view {
        string memory j = vm.readFile("vectors/eip712.json");
        ReviewedProposal memory p;
        p.marketId = keccak256("market-1");
        p.outcome = 3;
        p.evidenceHash = keccak256("snapshot");
        p.evidenceURIHash = keccak256("ipfs://bafy");
        p.noteHash = keccak256("note");
        p.attempt = 1;
        p.rejectedMask = 2;
        p.early = false;
        p.trustSetId = 1;
        p.deadline = 1800000000;
        bytes32 d = SigLib.digest(_domain(j), SigLib.hashReviewedProposal(p));
        assertEq(d, j.readBytes32(".R1.digest"));
        assertEq(d, 0xc3e6776ea7d4164e5eae882701e26b5174ff4b13de6d6701ff360b4243a4301b);
    }

    function test_everyFieldChangesTheHash() public pure {
        PanelResult memory r;
        bytes32 h0 = SigLib.hashPanelResult(r);
        r.labels[2] = 1;
        assertTrue(SigLib.hashPanelResult(r) != h0, "array element");
        ReviewedProposal memory p;
        bytes32 g0 = SigLib.hashReviewedProposal(p);
        p.early = true;
        assertTrue(SigLib.hashReviewedProposal(p) != g0, "bool");
    }

    // ------------------------------------------------------------------ panel attestor

    function test_panel_validSignature() public {
        (address a, uint256 k) = makeAddrAndKey("attestor");
        assertTrue(SigLib.isValidAttestorSig(a, HASH, _sign(k, HASH)));
    }

    function test_panel_wrongSigner() public {
        (, uint256 k) = makeAddrAndKey("attestor");
        assertFalse(SigLib.isValidAttestorSig(makeAddr("other"), HASH, _sign(k, HASH)));
    }

    function test_panel_wrongHash() public {
        (address a, uint256 k) = makeAddrAndKey("attestor");
        assertFalse(SigLib.isValidAttestorSig(a, keccak256("other"), _sign(k, HASH)));
    }

    function test_panel_highSRejected() public {
        (address a, uint256 k) = makeAddrAndKey("attestor");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, HASH);
        // The malleable twin (r, n - s, flipped v) recovers the same address and must be refused.
        bytes memory twin = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        assertEq(ecrecover(HASH, v == 27 ? 28 : 27, r, bytes32(N - uint256(s))), a, "twin really recovers");
        assertFalse(SigLib.isValidAttestorSig(a, HASH, twin));
    }

    function test_panel_vNotNormalizedRejected() public {
        (address a, uint256 k) = makeAddrAndKey("attestor");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, HASH);
        assertFalse(SigLib.isValidAttestorSig(a, HASH, abi.encodePacked(r, s, v - 27)), "v in {0,1}");
    }

    function test_panel_wrongLengthRejected() public {
        (address a, uint256 k) = makeAddrAndKey("attestor");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, HASH);
        assertFalse(SigLib.isValidAttestorSig(a, HASH, abi.encodePacked(r, s)), "64 bytes");
        assertFalse(SigLib.isValidAttestorSig(a, HASH, abi.encodePacked(r, s, v, uint8(0))), "66 bytes");
    }

    function test_panel_zeroAttestorNeverValid() public pure {
        // A garbage signature makes ecrecover return 0; a zero attestor must not match it.
        bytes memory junk = abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27));
        assertFalse(SigLib.isValidAttestorSig(address(0), HASH, junk));
    }

    // ------------------------------------------------------------------ committee m-of-k

    function test_committee_twoOfThreeAccepted() public {
        (address[] memory c, uint256[] memory k) = _committee();
        Sig[] memory sigs = new Sig[](2);
        sigs[0] = Sig(c[0], _sign(k[0], HASH));
        sigs[1] = Sig(c[2], _sign(k[2], HASH));
        this.verify(HASH, sigs, c, new bool[](3), 2);
    }

    function test_committee_belowThreshold() public {
        (address[] memory c, uint256[] memory k) = _committee();
        Sig[] memory sigs = new Sig[](1);
        sigs[0] = Sig(c[0], _sign(k[0], HASH));
        vm.expectRevert(IResolutionOracle.NotEnoughSignatures.selector);
        this.verify(HASH, sigs, c, new bool[](3), 2);
    }

    function test_committee_zeroThresholdRejected() public {
        (address[] memory c,) = _committee();
        vm.expectRevert(IResolutionOracle.NotEnoughSignatures.selector);
        this.verify(HASH, new Sig[](0), c, new bool[](3), 0);
    }

    function test_committee_unsorted() public {
        (address[] memory c, uint256[] memory k) = _committee();
        Sig[] memory sigs = new Sig[](2);
        sigs[0] = Sig(c[1], _sign(k[1], HASH));
        sigs[1] = Sig(c[0], _sign(k[0], HASH));
        vm.expectRevert(IResolutionOracle.SignersNotSorted.selector);
        this.verify(HASH, sigs, c, new bool[](3), 2);
    }

    function test_committee_duplicateSigner() public {
        (address[] memory c, uint256[] memory k) = _committee();
        Sig[] memory sigs = new Sig[](2);
        sigs[0] = Sig(c[0], _sign(k[0], HASH));
        sigs[1] = Sig(c[0], _sign(k[0], HASH));
        vm.expectRevert(IResolutionOracle.SignersNotSorted.selector);
        this.verify(HASH, sigs, c, new bool[](3), 2);
    }

    function test_committee_zeroSignerRejected() public {
        (address[] memory c,) = _committee();
        Sig[] memory sigs = new Sig[](1);
        sigs[0] = Sig(address(0), "");
        vm.expectRevert(IResolutionOracle.SignersNotSorted.selector);
        this.verify(HASH, sigs, c, new bool[](3), 1);
    }

    function test_committee_nonMember() public {
        (address[] memory c, uint256[] memory k) = _committee();
        (address outsider, uint256 ko) = makeAddrAndKey("outsider");
        Sig[] memory sigs = _sorted2(c[0], _sign(k[0], HASH), outsider, _sign(ko, HASH));
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, outsider));
        this.verify(HASH, sigs, c, new bool[](3), 2);
    }

    function test_committee_revokedMember() public {
        (address[] memory c, uint256[] memory k) = _committee();
        bool[] memory revoked = new bool[](3);
        revoked[2] = true;
        Sig[] memory sigs = new Sig[](2);
        sigs[0] = Sig(c[0], _sign(k[0], HASH));
        sigs[1] = Sig(c[2], _sign(k[2], HASH));
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, c[2]));
        this.verify(HASH, sigs, c, revoked, 2);
    }

    function test_committee_badSignature() public {
        (address[] memory c, uint256[] memory k) = _committee();
        Sig[] memory sigs = new Sig[](2);
        sigs[0] = Sig(c[0], _sign(k[0], HASH));
        sigs[1] = Sig(c[1], _sign(k[1], keccak256("other digest")));
        vm.expectRevert(IResolutionOracle.BadSignature.selector);
        this.verify(HASH, sigs, c, new bool[](3), 2);
    }

    function test_committee_signatureFromAnotherMember() public {
        (address[] memory c, uint256[] memory k) = _committee();
        Sig[] memory sigs = new Sig[](2);
        sigs[0] = Sig(c[0], _sign(k[0], HASH));
        sigs[1] = Sig(c[1], _sign(k[2], HASH)); // c[1] presents c[2]'s signature
        vm.expectRevert(IResolutionOracle.BadSignature.selector);
        this.verify(HASH, sigs, c, new bool[](3), 2);
    }

    function test_committee_erc1271MemberAccepted() public {
        (address eoa, uint256 ke) = makeAddrAndKey("member-eoa");
        Wallet1271 safe = new Wallet1271();
        safe.approve(HASH);
        address[] memory c = _sortedPair(eoa, address(safe));
        Sig[] memory sigs = _sorted2(eoa, _sign(ke, HASH), address(safe), "");
        this.verify(HASH, sigs, c, new bool[](2), 2);
    }

    function test_committee_erc1271MemberRefuses() public {
        (address eoa, uint256 ke) = makeAddrAndKey("member-eoa");
        Wallet1271 safe = new Wallet1271(); // approved nothing
        address[] memory c = _sortedPair(eoa, address(safe));
        Sig[] memory sigs = _sorted2(eoa, _sign(ke, HASH), address(safe), "");
        vm.expectRevert(IResolutionOracle.BadSignature.selector);
        this.verify(HASH, sigs, c, new bool[](2), 2);
    }

    // ------------------------------------------------------------------ helpers

    function verify(bytes32 h, Sig[] memory sigs, address[] memory c, bool[] memory revoked, uint8 threshold)
        external
        view
    {
        SigLib.verifyCommittee(h, sigs, c, revoked, threshold);
    }

    function _domain(string memory j) internal pure returns (bytes32) {
        return SigLib.domainSeparator(j.readUint(".domain.chainId"), j.readAddress(".domain.verifyingContract"));
    }

    function _sign(uint256 k, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, h);
        return abi.encodePacked(r, s, v);
    }

    /// Three EOA members sorted by address, with their keys in the same order.
    function _committee() internal returns (address[] memory c, uint256[] memory k) {
        c = new address[](3);
        k = new uint256[](3);
        (c[0], k[0]) = makeAddrAndKey("m1");
        (c[1], k[1]) = makeAddrAndKey("m2");
        (c[2], k[2]) = makeAddrAndKey("m3");
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (c[j] < c[i]) {
                    (c[i], c[j]) = (c[j], c[i]);
                    (k[i], k[j]) = (k[j], k[i]);
                }
            }
        }
    }

    function _sortedPair(address a, address b) internal pure returns (address[] memory c) {
        c = new address[](2);
        (c[0], c[1]) = a < b ? (a, b) : (b, a);
    }

    function _sorted2(address a, bytes memory sa, address b, bytes memory sb) internal pure returns (Sig[] memory s) {
        s = new Sig[](2);
        if (a < b) {
            (s[0], s[1]) = (Sig(a, sa), Sig(b, sb));
        } else {
            (s[0], s[1]) = (Sig(b, sb), Sig(a, sa));
        }
    }
}
