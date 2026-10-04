// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FeedSpec} from "../../src/types/OracleTypes.sol";
import {FeedSpecLib} from "../../src/libraries/FeedSpecLib.sol";

/// @notice Task O10.2. Runs every case of `vectors/feedspec.json` (expected codes assigned by hand from
///         the rules) and every specHash vector of `vectors/spechash.json` (computed with viem). The
///         TypeScript evaluator asserts both files in O20.2.
contract FeedSpecLibTest is Test {
    using stdJson for string;

    string internal json;
    string internal hashJson;

    function setUp() public {
        json = vm.readFile("vectors/feedspec.json");
        hashJson = vm.readFile("vectors/spechash.json");
    }

    function test_vectors_validationCodes() public view {
        uint256 n;
        for (uint256 i; vm.keyExistsJson(json, _case(i, "")); ++i) {
            (uint8 got, uint256 want, string memory name) = this.runCase(i);
            assertEq(got, want, name);
            ++n;
        }
        assertEq(n, 72, "every case ran");
    }

    /// One case per external call, so each case gets a fresh memory frame (each JSON read copies the file).
    function runCase(uint256 i) external view returns (uint8 got, uint256 want, string memory name) {
        FeedSpecLib.TimingBounds memory b = FeedSpecLib.TimingBounds({
            bufferMinSecs: uint32(json.readUint(".bounds.bufferMinSecs")),
            bufferMaxSecs: uint32(json.readUint(".bounds.bufferMaxSecs")),
            l1TimeoutMinSecs: uint32(json.readUint(".bounds.l1TimeoutMinSecs")),
            l1TimeoutMaxSecs: uint32(json.readUint(".bounds.l1TimeoutMaxSecs"))
        });
        FeedSpec memory s = _spec(json, _case(i, ".spec"));
        bool authRefKnown = s.authRef == bytes32(0) || json.readBool(_case(i, ".authRefKnown"));
        got = FeedSpecLib.validate(s, json.readString(_case(i, ".l1Host")), authRefKnown, b);
        want = json.readUint(_case(i, ".expectCode"));
        name = json.readString(_case(i, ".name"));
    }

    function test_vectors_specHash() public view {
        uint256 n;
        for (uint256 i; vm.keyExistsJson(hashJson, _hashCase(i, "")); ++i) {
            FeedSpec memory s = _spec(hashJson, _hashCase(i, ".spec"));
            assertEq(
                FeedSpecLib.specHash(s),
                hashJson.readBytes32(_hashCase(i, ".specHash")),
                hashJson.readString(_hashCase(i, ".name"))
            );
            ++n;
        }
        assertEq(n, 5, "every specHash vector ran");
    }

    function test_isZero() public view {
        FeedSpec memory z;
        assertTrue(FeedSpecLib.isZero(z));
        FeedSpec memory s = _spec(json, ".cases[0].spec");
        assertFalse(FeedSpecLib.isZero(s));
        z.bufferSecs = 1;
        assertFalse(FeedSpecLib.isZero(z), "any non-zero field");
    }

    // ------------------------------------------------------------------ helpers

    function _case(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".cases[", vm.toString(i), "]", field);
    }

    function _hashCase(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".vectors[", vm.toString(i), "]", field);
    }

    function _spec(string memory j, string memory k) internal pure returns (FeedSpec memory s) {
        s.urlTemplate = j.readString(string.concat(k, ".urlTemplate"));
        s.urlParam = j.readString(string.concat(k, ".urlParam"));
        s.authRef = j.readBytes32(string.concat(k, ".authRef"));
        s.finalPath = j.readString(string.concat(k, ".finalPath"));
        s.finalValue = j.readString(string.concat(k, ".finalValue"));
        s.valuePath = j.readString(string.concat(k, ".valuePath"));
        s.valueType = uint8(j.readUint(string.concat(k, ".valueType")));
        s.decimals = uint8(j.readUint(string.concat(k, ".decimals")));
        s.op = uint8(j.readUint(string.concat(k, ".op")));
        s.target = j.readString(string.concat(k, ".target"));
        s.bufferSecs = uint32(j.readUint(string.concat(k, ".bufferSecs")));
        s.l1TimeoutSecs = uint32(j.readUint(string.concat(k, ".l1TimeoutSecs")));
    }
}
