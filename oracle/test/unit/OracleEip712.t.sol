// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {Outcome, Phase, PanelLabel, PanelResult, ReviewedProposal, RState, Sig} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {SigLib} from "../../src/libraries/SigLib.sol";
import {OracleFixture} from "./OracleFixture.sol";

/// @notice Task O16.1: the oracle's EIP-712 views (`domainSeparator`, `hashPanelResult`,
///         `hashReviewedProposal`) against the Appendix C.7 vectors, the signed examples shared with
///         oracle-sdk (`vectors/eip712.json`), and signatures made over the views accepted by the real
///         panel and committee paths.
/// @dev The vector oracle is deployed at `0x…AA` on chainId 10143 with `deployCodeTo`, so the constructor
///      runs at that address and Solady's cached domain is the C.7 one. Expected separators are built
///      here from the domain strings of the vector file, not with SigLib.
contract OracleEip712Test is OracleFixture {
    using stdJson for string;

    uint256 internal constant CHAIN = 10143;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    string internal j;
    address internal at; // C.7 verifyingContract (0x…AA)

    function setUp() public override {
        super.setUp();
        j = vm.readFile("vectors/eip712.json");
        at = j.readAddress(".domain.verifyingContract");
        assertEq(at, address(0xAA));
        assertEq(j.readUint(".domain.chainId"), CHAIN);
        assertEq(block.chainid, CHAIN);
    }

    // ------------------------------------------------------------------ domain

    /// The domain is C.7's at `0x…AA` on 10143, exposed by `domainSeparator` and ERC-5267
    /// `eip712Domain`, and bound to the chain and the contract address.
    function test_domain() public {
        ResolutionOracle o = _deployAt(at);
        uint256 snap = vm.snapshotState();
        {
            // test_domain_vector
            assertEq(o.domainSeparator(), j.readBytes32(".domainSeparator"));
            assertEq(o.domainSeparator(), _separator(CHAIN, at));
            assertEq(o.domainSeparator(), 0xe36c2d0f1842919a82f01ee615592335f0ed31fad3f74c4423edcd85ed3de817);
        }
        vm.revertToState(snap);
        {
            // test_domain_erc5267
            (
                bytes1 fields,
                string memory name,
                string memory version,
                uint256 chainId,
                address verifyingContract,
                bytes32 salt,
                uint256[] memory extensions
            ) = o.eip712Domain();
            assertEq(fields, hex"0f", "name, version, chainId, verifyingContract");
            assertEq(name, j.readString(".domain.name"));
            assertEq(version, j.readString(".domain.version"));
            assertEq(chainId, CHAIN);
            assertEq(verifyingContract, at);
            assertEq(salt, bytes32(0));
            assertEq(extensions.length, 0);
        }
        vm.revertToState(snap);
        {
            // test_domain_boundToChain
            // A fork on another chain gets another separator, so a 10143 signature cannot replay there.
            vm.chainId(143);
            assertEq(o.domainSeparator(), _separator(143, at));
            assertTrue(o.domainSeparator() != j.readBytes32(".domainSeparator"));
            assertTrue(o.hashPanelResult(_p1()) != j.readBytes32(".P1.digest"));
            assertTrue(o.hashReviewedProposal(_r1()) != j.readBytes32(".R1.digest"));
        }
        vm.revertToState(snap);
        {
            // test_domain_boundToContract
            ResolutionOracle other = _deployAt(address(0xBB));
            assertEq(other.domainSeparator(), _separator(CHAIN, address(0xBB)));
            assertTrue(other.domainSeparator() != o.domainSeparator());
            assertTrue(other.hashPanelResult(_p1()) != o.hashPanelResult(_p1()));
            assertTrue(other.hashReviewedProposal(_r1()) != o.hashReviewedProposal(_r1()));
        }
    }

    // ------------------------------------------------------------------ digests

    /// C.7 digests P1 and R1 through the oracle's own views.
    function test_digests() public {
        ResolutionOracle o = _deployAt(at);
        {
            // test_digest_P1
            assertEq(o.hashPanelResult(_p1()), j.readBytes32(".P1.digest"));
            assertEq(o.hashPanelResult(_p1()), 0xc31506d1641a8f03330d1ba677ab016d51c96b1af48ae24d475b84413535b5bc);
        }
        {
            // test_digest_R1
            assertEq(o.hashReviewedProposal(_r1()), j.readBytes32(".R1.digest"));
            assertEq(o.hashReviewedProposal(_r1()), 0xc3e6776ea7d4164e5eae882701e26b5174ff4b13de6d6701ff360b4243a4301b);
        }
    }

    // ------------------------------------------------------------------ signed examples (oracle-sdk)

    /// The signed examples of the vector file: each key gives its signer, `vm.sign` over the view's
    /// digest reproduces the committed signature byte for byte (cast and viem gave the same bytes), each
    /// signature is canonical (v 27/28, low s), and the oracle's checks accept them.
    function test_signedExamples() public {
        ResolutionOracle o = _deployAt(at);
        {
            // test_signed_P1
            bytes32 d = o.hashPanelResult(_p1());
            uint256 key = uint256(j.readBytes32(".signed.P1.privateKey"));
            address signer = j.readAddress(".signed.P1.signer");
            bytes memory sig = j.readBytes(".signed.P1.signature");
            assertEq(vm.addr(key), signer);
            assertEq(_sign(key, d), sig);
            _assertCanonical(sig);
            assertTrue(SigLib.isValidAttestorSig(signer, d, sig));
        }
        {
            // test_signed_R1
            bytes32 d = o.hashReviewedProposal(_r1());
            bytes32[] memory keys = j.readBytes32Array(".signed.R1.privateKeys");
            address[] memory signers = j.readAddressArray(".signed.R1.signers");
            bytes[] memory sigs = j.readBytesArray(".signed.R1.signatures");
            assertEq(keys.length, 2);
            assertEq(signers.length, 2);
            assertEq(sigs.length, 2);
            assertLt(uint160(signers[0]), uint160(signers[1]), "ascending");
            Sig[] memory s = new Sig[](2);
            for (uint256 i; i < 2; ++i) {
                assertEq(vm.addr(uint256(keys[i])), signers[i]);
                assertEq(_sign(uint256(keys[i]), d), sigs[i]);
                _assertCanonical(sigs[i]);
                s[i] = Sig(signers[i], sigs[i]);
            }
            // The two signers as a 2-of-2 committee: SigLib's m-of-k check (reverts on any failure).
            SigLib.verifyCommittee(d, s, signers, new bool[](2), 2);
        }
    }

    // ------------------------------------------------------------------ views == what the oracle verifies

    /// A signature made over the view's digest is accepted by `submitPanelResult` and
    /// `submitReviewedProposal` of the fixture oracle, so the views are what signers must sign.
    function test_viewsAreWhatTheOracleVerifies() public {
        uint256 snap = vm.snapshotState();
        {
            // test_view_panelAccepted
            (bytes32 m,) = _listNoFeed();
            _halt(m); // L2Pending
            PanelResult memory p;
            p.marketId = m;
            p.phase = uint8(Phase.POST_T);
            p.labels = [uint8(PanelLabel.YES), uint8(PanelLabel.YES), uint8(PanelLabel.YES)];
            p.calibratedBps = [uint16(9_500), uint16(9_500), uint16(9_500)];
            p.evidenceHash = keccak256("snapshot");
            p.evidenceURIHash = keccak256(bytes(URI));
            p.gateHash = reg.getMarketCore(m).gateHash;
            p.trustSetId = ro.activeTrustSetId();
            p.deadline = uint64(block.timestamp + 1 hours);
            bytes memory sig = _sign(attestorKey, ro.hashPanelResult(p));
            // No category validated at launch: the result is accepted and routed to Review.
            vm.expectEmit(address(ro));
            emit IResolutionOracle.PanelResultAccepted(
                m, Phase.POST_T, p.labels, p.calibratedBps, p.evidenceHash, URI, RState.Review
            );
            assertEq(uint8(ro.submitPanelResult(m, p, URI, sig)), uint8(RState.Review));
        }
        vm.revertToState(snap);
        {
            // test_view_committeeAccepted
            (bytes32 m,) = _listNoFeed();
            _toReview(m);
            ReviewedProposal memory p = _reviewed(m, uint8(Outcome.NO));
            bytes32 d = ro.hashReviewedProposal(p);
            Sig[] memory sigs = new Sig[](2);
            sigs[0] = Sig(members[0], _sign(memberKeys[0], d));
            sigs[1] = Sig(members[2], _sign(memberKeys[2], d));
            ro.submitReviewedProposal(m, p, URI, sigs);
            assertEq(uint8(_res(m).proposed), uint8(Outcome.NO));
            assertEq(uint8(_state(m)), uint8(RState.Proposed));
        }
    }

    // ------------------------------------------------------------------ helpers

    function _deployAt(address where) internal returns (ResolutionOracle) {
        deployCodeTo(
            "ResolutionOracle.sol:ResolutionOracle",
            abi.encode(address(0x1), address(0x2), address(0x3), SELECTOR, gov, guardian),
            where
        );
        return ResolutionOracle(where);
    }

    /// The EIP-712 separator from the vector file's domain strings.
    function _separator(uint256 chainId, address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(j.readString(".domain.name"))),
                keccak256(bytes(j.readString(".domain.version"))),
                chainId,
                verifyingContract
            )
        );
    }

    /// Vector P1 (C.7), its preimages hashed as `k("…")`.
    function _p1() internal view returns (PanelResult memory r) {
        r.marketId = _k(".P1.preimages.marketId");
        r.phase = uint8(j.readUint(".P1.phase"));
        r.attempt = uint8(j.readUint(".P1.attempt"));
        uint256[] memory l = j.readUintArray(".P1.labels");
        uint256[] memory c = j.readUintArray(".P1.calibratedBps");
        r.labels = [uint8(l[0]), uint8(l[1]), uint8(l[2])];
        r.calibratedBps = [uint16(c[0]), uint16(c[1]), uint16(c[2])];
        r.evidenceHash = _k(".P1.preimages.evidenceHash");
        r.evidenceURIHash = _k(".P1.preimages.evidenceURIHash");
        r.gateHash = _k(".P1.preimages.gateHash");
        r.flags = uint8(j.readUint(".P1.flags"));
        r.trustSetId = uint32(j.readUint(".P1.trustSetId"));
        r.deadline = uint64(j.readUint(".P1.deadline"));
    }

    /// Vector R1 (C.7).
    function _r1() internal view returns (ReviewedProposal memory p) {
        p.marketId = _k(".R1.preimages.marketId");
        p.outcome = uint8(j.readUint(".R1.outcome"));
        p.evidenceHash = _k(".R1.preimages.evidenceHash");
        p.evidenceURIHash = _k(".R1.preimages.evidenceURIHash");
        p.noteHash = _k(".R1.preimages.noteHash");
        p.attempt = uint8(j.readUint(".R1.attempt"));
        p.rejectedMask = uint8(j.readUint(".R1.rejectedMask"));
        p.early = j.readBool(".R1.early");
        p.trustSetId = uint32(j.readUint(".R1.trustSetId"));
        p.deadline = uint64(j.readUint(".R1.deadline"));
    }

    function _k(string memory key) internal view returns (bytes32) {
        return keccak256(bytes(j.readString(key)));
    }

    /// 65 bytes, v ∈ {27, 28}, s ≤ n/2.
    function _assertCanonical(bytes memory sig) internal pure {
        assertEq(sig.length, 65);
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        assertTrue(v == 27 || v == 28, "v");
        assertLe(uint256(s), HALF_N, "low s");
    }
}
