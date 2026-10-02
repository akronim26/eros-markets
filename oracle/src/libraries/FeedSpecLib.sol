// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FeedSpec, ValueType, Op} from "../types/OracleTypes.sol";
import {HostLib} from "./HostLib.sol";

/// @title FeedSpecLib
/// @notice Validation of a Layer 1 FeedSpec at listing (plan §6.3 rule 3, §7.3; task O10.2) and its
///         `specHash`. The TypeScript evaluator applies the same rules; `vectors/feedspec.json` pins both.
/// @dev `validate` returns the first failing `IMarketRegistry.BadFeed` code in code order, or 0:
///      1 https, 2 host, 3 {id}, 4 urlParam, 5 L1 host != allowList[0], 6 path, 7 finalValue,
///      8 op/type, 9 decimals, 10 target, 11 buffer/timeout, 12 authRef. Code 13 (a non-zero spec on a
///      market without a feed) is the registry's check with `isZero`.
library FeedSpecLib {
    uint8 internal constant OK = 0;
    uint8 internal constant L1_HOST = 5;
    uint8 internal constant PATH = 6;
    uint8 internal constant FINAL_VALUE = 7;
    uint8 internal constant OP_TYPE = 8;
    uint8 internal constant DECIMALS = 9;
    uint8 internal constant TARGET = 10;
    uint8 internal constant TIMING = 11;
    uint8 internal constant AUTH_REF = 12;

    uint256 internal constant MAX_PATH = 256;
    uint256 internal constant MAX_INDEX_DIGITS = 6;
    uint8 internal constant MAX_DECIMALS = 18;

    /// @notice Globals bounds for `bufferSecs` and `l1TimeoutSecs` (from the pinned globals version).
    struct TimingBounds {
        uint32 bufferMinSecs;
        uint32 bufferMaxSecs;
        uint32 l1TimeoutMinSecs;
        uint32 l1TimeoutMaxSecs;
    }

    /// @param l1Host      `allowList[0]`: the substituted URL's host must equal it.
    /// @param authRefKnown `spec.authRef == 0 || registry.authRefKnown(spec.authRef)`.
    function validate(FeedSpec memory spec, string memory l1Host, bool authRefKnown, TimingBounds memory b)
        internal
        pure
        returns (uint8)
    {
        uint8 code = HostLib.checkTemplate(spec.urlTemplate);
        if (code != OK) return code;
        if (!HostLib.isValidUrlParam(spec.urlParam)) return HostLib.BAD_URL_PARAM;
        (, string memory host) = HostLib.hostOf(HostLib.substitute(spec.urlTemplate, spec.urlParam));
        if (keccak256(bytes(host)) != keccak256(bytes(l1Host))) return L1_HOST;
        if (!isValidPath(spec.finalPath) || !isValidPath(spec.valuePath)) return PATH;
        if (bytes(spec.finalValue).length == 0) return FINAL_VALUE;
        if (!isValidOpForType(spec.valueType, spec.op)) return OP_TYPE;
        if (!isValidDecimals(spec.valueType, spec.decimals)) return DECIMALS;
        if (!isValidTarget(spec.target, spec.valueType, spec.decimals)) return TARGET;
        if (!isValidTiming(spec.bufferSecs, spec.l1TimeoutSecs, b)) return TIMING;
        if (!authRefKnown) return AUTH_REF;
        return OK;
    }

    /// @notice `specHash = keccak256(abi.encode(spec))` (ABI-identical to the CRE workflow tuple).
    function specHash(FeedSpec memory spec) internal pure returns (bytes32) {
        return keccak256(abi.encode(spec));
    }

    /// @notice True for the all-zero FeedSpec required on markets without a feed (BadFeed code 13).
    function isZero(FeedSpec memory spec) internal pure returns (bool) {
        return bytes(spec.urlTemplate).length == 0 && bytes(spec.urlParam).length == 0 && spec.authRef == 0
            && bytes(spec.finalPath).length == 0 && bytes(spec.finalValue).length == 0
            && bytes(spec.valuePath).length == 0 && spec.valueType == 0 && spec.decimals == 0 && spec.op == 0
            && bytes(spec.target).length == 0 && spec.bufferSecs == 0 && spec.l1TimeoutSecs == 0;
    }

    /// @notice `seg(.seg)*`, `seg = [A-Za-z0-9_$-]+` followed by zero or more `[n]`,
    ///         `n = 0|[1-9][0-9]{0,5}`; 1 to 256 bytes.
    function isValidPath(string memory path) internal pure returns (bool) {
        bytes memory p = bytes(path);
        if (p.length == 0 || p.length > MAX_PATH) return false;
        uint256 i;
        while (true) {
            uint256 nameStart = i;
            while (i < p.length && _isNameChar(p[i])) ++i;
            if (i == nameStart) return false;
            while (i < p.length && p[i] == "[") {
                ++i;
                uint256 digitsStart = i;
                while (i < p.length && _isDigit(p[i])) ++i;
                uint256 digits = i - digitsStart;
                if (digits == 0 || digits > MAX_INDEX_DIGITS) return false;
                if (digits > 1 && p[digitsStart] == "0") return false;
                if (i == p.length || p[i] != "]") return false;
                ++i;
            }
            if (i == p.length) return true;
            if (p[i] != ".") return false;
            ++i;
        }
        return false; // unreachable
    }

    /// @notice STRING allows EQ/NEQ only; INT and DECIMAL allow all six operators.
    function isValidOpForType(uint8 valueType, uint8 op) internal pure returns (bool) {
        if (valueType > uint8(ValueType.DECIMAL) || op > uint8(Op.LTE)) return false;
        if (valueType == uint8(ValueType.STRING)) return op <= uint8(Op.NEQ);
        return true;
    }

    /// @notice `decimals` may be non-zero only for DECIMAL, and at most 18.
    function isValidDecimals(uint8 valueType, uint8 decimals) internal pure returns (bool) {
        if (valueType == uint8(ValueType.DECIMAL)) return decimals <= MAX_DECIMALS;
        return decimals == 0;
    }

    /// @notice INT `-?(0|[1-9][0-9]*)`; DECIMAL `-?(0|[1-9][0-9]*)(\.[0-9]+)?` with at most `decimals`
    ///         fractional digits and no exponent; STRING non-empty. Never rounds.
    function isValidTarget(string memory target, uint8 valueType, uint8 decimals) internal pure returns (bool) {
        bytes memory t = bytes(target);
        if (valueType == uint8(ValueType.STRING)) return t.length > 0;
        uint256 i;
        if (i < t.length && t[i] == "-") ++i;
        uint256 intStart = i;
        while (i < t.length && _isDigit(t[i])) ++i;
        uint256 intDigits = i - intStart;
        if (intDigits == 0 || (intDigits > 1 && t[intStart] == "0")) return false;
        if (i == t.length) return true;
        if (valueType != uint8(ValueType.DECIMAL) || t[i] != ".") return false;
        ++i;
        uint256 fracStart = i;
        while (i < t.length && _isDigit(t[i])) ++i;
        uint256 fracDigits = i - fracStart;
        return i == t.length && fracDigits > 0 && fracDigits <= decimals;
    }

    /// @notice `bufferSecs < l1TimeoutSecs`, each inside its globals bounds.
    function isValidTiming(uint32 bufferSecs, uint32 l1TimeoutSecs, TimingBounds memory b)
        internal
        pure
        returns (bool)
    {
        return bufferSecs < l1TimeoutSecs && bufferSecs >= b.bufferMinSecs && bufferSecs <= b.bufferMaxSecs
            && l1TimeoutSecs >= b.l1TimeoutMinSecs && l1TimeoutSecs <= b.l1TimeoutMaxSecs;
    }

    function _isNameChar(bytes1 c) private pure returns (bool) {
        return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || _isDigit(c) || c == "_" || c == "$" || c == "-";
    }

    function _isDigit(bytes1 c) private pure returns (bool) {
        return c >= "0" && c <= "9";
    }
}
