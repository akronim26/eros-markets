// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {SigLib} from "../../src/libraries/SigLib.sol";
import {PanelResult} from "../../src/types/OracleTypes.sol";

/// @notice Task O33.4 (plan §8.3). The panel runner's signatures (`vectors/panel-sig.json`, written by
///         services/panel-runner/test/signer.test.ts) are accepted by the oracle's own code: the digest from
///         `SigLib.hashPanelResult` under the oracle's domain equals the runner's, and `isValidAttestorSig` accepts
///         the signature for the attestor, and rejects it for anyone else and in its high-s and v-shifted forms.
contract PanelSigVectorsTest is Test {
    using stdJson for string;

    string internal constant PATH = "vectors/panel-sig.json";
    uint256 internal constant N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    function _result(string memory j, string memory c) internal pure returns (PanelResult memory r) {
        r.marketId = j.readBytes32(string.concat(c, ".marketId"));
        r.phase = uint8(j.readUint(string.concat(c, ".phase")));
        r.attempt = uint8(j.readUint(string.concat(c, ".attempt")));
        uint256[] memory labels = j.readUintArray(string.concat(c, ".labels"));
        uint256[] memory bps = j.readUintArray(string.concat(c, ".calibratedBps"));
        for (uint256 i; i < 3; ++i) {
            r.labels[i] = uint8(labels[i]);
            r.calibratedBps[i] = uint16(bps[i]);
        }
        r.evidenceHash = j.readBytes32(string.concat(c, ".evidenceHash"));
        r.evidenceURIHash = j.readBytes32(string.concat(c, ".evidenceURIHash"));
        r.gateHash = j.readBytes32(string.concat(c, ".gateHash"));
        r.flags = uint8(j.readUint(string.concat(c, ".flags")));
        r.trustSetId = uint32(j.readUint(string.concat(c, ".trustSetId")));
        r.deadline = uint64(vm.parseUint(j.readString(string.concat(c, ".deadline"))));
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    function test_runnerSignaturesAccepted() public view {
        string memory j = vm.readFile(PATH);
        uint256 chainId = j.readUint(".chainId");
        address oracle = j.readAddress(".oracle");
        address attestor = j.readAddress(".attestor");
        bytes32 separator = SigLib.domainSeparator(chainId, oracle);
        uint256 n;
        while (vm.keyExistsJson(j, string.concat(".cases[", vm.toString(n), "]"))) {
            string memory c = string.concat(".cases[", vm.toString(n), "]");
            bytes32 d = SigLib.digest(separator, SigLib.hashPanelResult(_result(j, c)));
            assertEq(d, j.readBytes32(string.concat(c, ".digest")), "digest differs from the runner's");
            bytes memory sig = j.readBytes(string.concat(c, ".signature"));
            assertTrue(SigLib.isValidAttestorSig(attestor, d, sig), "attestor signature refused");
            assertFalse(SigLib.isValidAttestorSig(address(0xBEEF), d, sig), "accepted for another attestor");
            (bytes32 r, bytes32 s, uint8 v) = _split(sig);
            // the malleable twin (n - s, other v) recovers the same key but is refused for its high s
            assertFalse(
                SigLib.isValidAttestorSig(
                    attestor, d, abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27))
                )
            );
            assertFalse(SigLib.isValidAttestorSig(attestor, d, abi.encodePacked(r, s, v - 27)), "v 0/1 accepted");
            ++n;
        }
        assertEq(n, 4, "expected 4 cases");
    }
}
