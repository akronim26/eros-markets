// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FeedSpec} from "../../src/types/OracleTypes.sol";
import {FeedSpecLib} from "../../src/libraries/FeedSpecLib.sol";

/// @notice Task O10.2. Runs every case of `vectors/feedspec.json` (expected codes assigned by hand from
///         the rules; the TypeScript evaluator asserts the same file in O20.2) and every specHash vector
///         (computed with viem).
contract FeedSpecLibTest is Test {
    using stdJson for string;

    string internal json;

    function setUp() public {
        json = vm.readFile("vectors/feedspec.json");
    }

    function test_vectors_validationCodes() public view {
        uint256 n;
        for (uint256 i; vm.keyExistsJson(json, _case(i, "")); ++i) {
            (uint8 got, uint256 want, string memory name) = this.runCase(i);
            assertEq(got, want, name);
            ++n;
        }
        assertEq(n, 71, "every case ran");
    }

    /// One case per external call, so each case gets a fresh memory frame (each JSON read copies the file).
    function runCase(uint256 i) external view returns (uint8 got, uint256 want, string memory name) {
        FeedSpecLib.TimingBounds memory b = FeedSpecLib.TimingBounds({
            bufferMinSecs: uint32(json.readUint(".bounds.bufferMinSecs")),
            bufferMaxSecs: uint32(json.readUint(".bounds.bufferMaxSecs")),
            l1TimeoutMinSecs: uint32(json.readUint(".bounds.l1TimeoutMinSecs")),
            l1TimeoutMaxSecs: uint32(json.readUint(".bounds.l1TimeoutMaxSecs"))
        });
        FeedSpec memory s = _spec(_case(i, ".spec"));
        bool authRefKnown = s.authRef == bytes32(0) || json.readBool(_case(i, ".authRefKnown"));
        got = FeedSpecLib.validate(s, json.readString(_case(i, ".l1Host")), authRefKnown, b);
        want = json.readUint(_case(i, ".expectCode"));
        name = json.readString(_case(i, ".name"));
    }

    function test_vectors_specHash() public view {
        uint256 n;
        for (uint256 i; vm.keyExistsJson(json, _hashCase(i, "")); ++i) {
            FeedSpec memory s = _spec(_hashCase(i, ".spec"));
            assertEq(
                FeedSpecLib.specHash(s),
                json.readBytes32(_hashCase(i, ".specHash")),
                json.readString(_hashCase(i, ".name"))
            );
            ++n;
        }
        assertGe(n, 3);
    }

    function test_specHash_matchesC7() public view {
        assertEq(
            FeedSpecLib.specHash(_spec(".specHash[0].spec")),
            0x50661463875a7d2a9c9ca378a3d4d1ee141fef1d82091ecd7ab36829ea7f80cd
        );
    }

    function test_isZero() public view {
        FeedSpec memory z;
        assertTrue(FeedSpecLib.isZero(z));
        FeedSpec memory s = _spec(".cases[0].spec");
        assertFalse(FeedSpecLib.isZero(s));
        z.bufferSecs = 1;
        assertFalse(FeedSpecLib.isZero(z), "any non-zero field");
    }

    // ------------------------------------------------------------------ helpers

    function _case(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".cases[", vm.toString(i), "]", field);
    }

    function _hashCase(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".specHash[", vm.toString(i), "]", field);
    }

    function _spec(string memory k) internal view returns (FeedSpec memory s) {
        s.urlTemplate = json.readString(string.concat(k, ".urlTemplate"));
        s.urlParam = json.readString(string.concat(k, ".urlParam"));
        s.authRef = json.readBytes32(string.concat(k, ".authRef"));
        s.finalPath = json.readString(string.concat(k, ".finalPath"));
        s.finalValue = json.readString(string.concat(k, ".finalValue"));
        s.valuePath = json.readString(string.concat(k, ".valuePath"));
        s.valueType = uint8(json.readUint(string.concat(k, ".valueType")));
        s.decimals = uint8(json.readUint(string.concat(k, ".decimals")));
        s.op = uint8(json.readUint(string.concat(k, ".op")));
        s.target = json.readString(string.concat(k, ".target"));
        s.bufferSecs = uint32(json.readUint(string.concat(k, ".bufferSecs")));
        s.l1TimeoutSecs = uint32(json.readUint(string.concat(k, ".l1TimeoutSecs")));
    }
}
