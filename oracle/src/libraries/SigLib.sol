// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";
import {PanelResult, ReviewedProposal, Sig} from "../types/OracleTypes.sol";
import {IResolutionOracle} from "../interfaces/IResolutionOracle.sol";

/// @title SigLib
/// @notice EIP-712 hashing and signature checks for panel results and committee proposals
///         (plan §6.4, D7, Appendix C.7; task O10.5).
/// @dev Fixed arrays are encoded as `keccak256(abi.encode(array))` (each element padded to 32 bytes),
///      exactly as viem and `eth_signTypedData_v4` do. The oracle's own domain (Solady `EIP712`, name
///      "ErosResolutionOracle", version "1") yields the same separator as `domainSeparator` here.
///      Failures revert with the `IResolutionOracle` errors.
library SigLib {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("ErosResolutionOracle");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    /// 0x69db7560f727032b47f7c3e6e9c198309778224bf26d820414042f3952f7d905
    bytes32 internal constant PANEL_TYPEHASH = keccak256(
        "PanelResult(bytes32 marketId,uint8 phase,uint8 attempt,uint8[3] labels,uint16[3] calibratedBps,bytes32 evidenceHash,bytes32 evidenceURIHash,bytes32 gateHash,uint8 flags,uint32 trustSetId,uint64 deadline)"
    );

    /// 0x859e8252aa8c9e5c1f41c429345599a5fbb3c1c5664602fff262b2ff0e856f57
    bytes32 internal constant REVIEWED_TYPEHASH = keccak256(
        "ReviewedProposal(bytes32 marketId,uint8 outcome,bytes32 evidenceHash,bytes32 evidenceURIHash,bytes32 noteHash,uint8 attempt,uint8 rejectedMask,bool early,uint32 trustSetId,uint64 deadline)"
    );

    /// secp256k1 n / 2: a signature with a larger `s` is the malleable twin of a low-s signature.
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    // ------------------------------------------------------------------ hashing

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, verifyingContract));
    }

    function hashPanelResult(PanelResult memory r) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PANEL_TYPEHASH,
                r.marketId,
                r.phase,
                r.attempt,
                keccak256(abi.encode(r.labels)),
                keccak256(abi.encode(r.calibratedBps)),
                r.evidenceHash,
                r.evidenceURIHash,
                r.gateHash,
                r.flags,
                r.trustSetId,
                r.deadline
            )
        );
    }

    function hashReviewedProposal(ReviewedProposal memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REVIEWED_TYPEHASH,
                p.marketId,
                p.outcome,
                p.evidenceHash,
                p.evidenceURIHash,
                p.noteHash,
                p.attempt,
                p.rejectedMask,
                p.early,
                p.trustSetId,
                p.deadline
            )
        );
    }

    /// @notice EIP-712 digest: `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)`.
    function digest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }

    // ------------------------------------------------------------------ panel (single attestor)

    /// @notice True when `sig` is a 65-byte (r, s, v) signature by `attestor` over `hash`, with
    ///         `v ∈ {27, 28}` and low `s`. The attestor is an EOA (KMS key), so no ERC-1271.
    function isValidAttestorSig(address attestor, bytes32 hash, bytes memory sig) internal pure returns (bool) {
        if (attestor == address(0) || sig.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v != 27 && v != 28) return false;
        if (uint256(s) > HALF_N) return false;
        return ecrecover(hash, v, r, s) == attestor;
    }

    // ------------------------------------------------------------------ committee (m-of-k)

    /// @notice Verifies a committee approval: at least `threshold` (≥ 1) signatures, signers strictly
    ///         ascending (so unique), each a committee member that is not revoked, each signature valid
    ///         for `hash` (EOA or ERC-1271). Every listed signature must be valid; none is skipped.
    /// @param committee strictly ascending member list of the trust set.
    /// @param revoked   `revoked[i]` is true when `committee[i]` has been revoked by the guardian.
    function verifyCommittee(
        bytes32 hash,
        Sig[] memory sigs,
        address[] memory committee,
        bool[] memory revoked,
        uint8 threshold
    ) internal view {
        if (threshold == 0 || sigs.length < threshold) {
            revert IResolutionOracle.NotEnoughSignatures();
        }
        address prev;
        for (uint256 i; i < sigs.length; ++i) {
            address signer = sigs[i].signer;
            if (signer <= prev) revert IResolutionOracle.SignersNotSorted();
            prev = signer;
            if (!_isActiveMember(signer, committee, revoked)) revert IResolutionOracle.NotCommitteeMember(signer);
            if (!SignatureCheckerLib.isValidSignatureNow(signer, hash, sigs[i].signature)) {
                revert IResolutionOracle.BadSignature();
            }
        }
    }

    function _isActiveMember(address signer, address[] memory committee, bool[] memory revoked)
        private
        pure
        returns (bool)
    {
        for (uint256 i; i < committee.length; ++i) {
            if (committee[i] == signer) return !revoked[i];
        }
        return false;
    }
}
