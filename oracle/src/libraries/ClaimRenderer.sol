// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";
import {DynamicBufferLib} from "solady/utils/DynamicBufferLib.sol";
import {Outcome} from "../types/OracleTypes.sol";

/// @title ClaimRenderer
/// @notice Renders the standalone UMA claim from a market's template (plan §6.3 rule 6, §6.4; task O10.3).
/// @dev Tokens: MARKET_ID (0x + 64 hex), CHAIN_ID (decimal), ORACLE (checksummed), QUESTION, RULES,
///      TAU_UTC (YYYY-MM-DDTHH:MM:SSZ), TAU_UNIX (decimal), OUTCOME (YES/NO/INVALID), EVIDENCE (the
///      evidence URI, or the L1 text from `l1Evidence`), EVIDENCE_HASH (0x + 64 hex). Each token is the
///      name wrapped in double braces. A valid template contains each token except TAU_UNIX exactly
///      once, TAU_UNIX at most once, and every double opening brace starts one of these ten tokens.
///      `render` is one pass over the template that checks it as it renders and reverts if it is invalid.
///      The scan jumps from one double opening brace to the next (`LibString.indexOf`) and matches a token
///      by comparing one memory word with its bytes (every token is under 32 bytes), not by building
///      candidate strings (O18.1: the claim is rendered in every assertion).
///      `worstCaseLength` assumes a chain id below 2^64 (20 digits) and tau before the year 10000; the
///      registry's listing horizon keeps tau far below that.
library ClaimRenderer {
    using DynamicBufferLib for DynamicBufferLib.DynamicBuffer;

    error InvalidTemplate();
    error NoOutcome();

    uint256 internal constant TOKEN_COUNT = 10;
    uint256 internal constant TAU_UNIX = 6; // index in `_name`, the only optional token

    // Fixed output sizes used by the worst-case bound (plan §6.3 rule 6).
    uint256 internal constant LEN_MARKET_ID = 66;
    uint256 internal constant LEN_CHAIN_ID = 20;
    uint256 internal constant LEN_ORACLE = 42;
    uint256 internal constant LEN_TAU_UTC = 20;
    uint256 internal constant LEN_TAU_UNIX = 20;
    uint256 internal constant LEN_OUTCOME = 7;
    uint256 internal constant LEN_EVIDENCE_HASH = 66;
    uint256 internal constant FIXED_TOKEN_OUTPUT =
        LEN_MARKET_ID + LEN_CHAIN_ID + LEN_ORACLE + LEN_TAU_UTC + LEN_TAU_UNIX + LEN_OUTCOME + LEN_EVIDENCE_HASH;
    uint256 internal constant MIN_EVIDENCE = 256; // MAX_EVIDENCE_URI_BYTES
    uint256 internal constant L1_EVIDENCE_FIXED = 26 + 66 + 9; // "Layer 1 CRE report, value " + hash + ", source "

    struct Fields {
        bytes32 marketId;
        uint256 chainId;
        address oracle;
        string question;
        string rules;
        uint64 tau;
        Outcome outcome;
        string evidence;
        bytes32 evidenceHash;
    }

    /// @notice True when the template satisfies the token rules.
    function isValidTemplate(string memory template) internal pure returns (bool) {
        (bool ok, uint256[TOKEN_COUNT] memory counts,) = _scan(bytes(template));
        return ok && _countsValid(counts);
    }

    /// @notice Upper bound on the rendered claim length (plan §6.3 rule 6). `l1UrlLen` is the length of
    ///         the substituted Layer 1 URL (0 without a feed).
    function worstCaseLength(string memory template, uint256 questionLen, uint256 rulesLen, uint256 l1UrlLen)
        internal
        pure
        returns (uint256)
    {
        uint256 l1Text = L1_EVIDENCE_FIXED + l1UrlLen;
        return bytes(template).length - _tokenBytes(template) + questionLen + rulesLen + FIXED_TOKEN_OUTPUT
            + (l1Text > MIN_EVIDENCE ? l1Text : MIN_EVIDENCE);
    }

    /// @notice The `{{EVIDENCE}}` text for a Layer 1 proposal.
    function l1Evidence(bytes32 valueHash, string memory url) internal pure returns (string memory) {
        return
            string.concat("Layer 1 CRE report, value ", LibString.toHexString(uint256(valueHash), 32), ", source ", url);
    }

    /// @notice One-pass render. Reverts `InvalidTemplate` on a template that breaks the token rules (checked
    ///         first, as before: an invalid template wins over a missing outcome), then `NoOutcome`.
    function render(string memory template, Fields memory f) internal pure returns (bytes memory) {
        bytes memory t = bytes(template);
        DynamicBufferLib.DynamicBuffer memory out;
        uint256[TOKEN_COUNT] memory counts;
        uint256 i; // also the start of the pending literal
        while (true) {
            uint256 at = LibString.indexOf(template, "{{", i);
            if (at == LibString.NOT_FOUND) break;
            (uint256 k, uint256 len) = _tokenAt(t, at);
            if (len == 0) revert InvalidTemplate();
            ++counts[k];
            out.p(_slice(t, i, at));
            out.p(bytes(_value(k, f)));
            i = at + len;
        }
        if (!_countsValid(counts)) revert InvalidTemplate();
        if (f.outcome == Outcome.NONE) revert NoOutcome();
        out.p(_slice(t, i, t.length));
        return out.data;
    }

    // ------------------------------------------------------------------ internals

    /// @dev Total bytes of the template's tokens (braces included); reverts on an invalid template.
    function _tokenBytes(string memory template) private pure returns (uint256 tokenBytes) {
        bool ok;
        (ok,, tokenBytes) = _scan(bytes(template));
        if (!ok) revert InvalidTemplate();
    }

    /// @dev Counts tokens and their bytes; `ok` is false if any double opening brace is not a token.
    function _scan(bytes memory t)
        private
        pure
        returns (bool ok, uint256[TOKEN_COUNT] memory counts, uint256 tokenBytes)
    {
        uint256 i;
        while (true) {
            uint256 at = LibString.indexOf(string(t), "{{", i);
            if (at == LibString.NOT_FOUND) break;
            (uint256 k, uint256 len) = _tokenAt(t, at);
            if (len == 0) return (false, counts, 0);
            ++counts[k];
            tokenBytes += len;
            i = at + len;
        }
        return (true, counts, tokenBytes);
    }

    /// @dev Each required token exactly once, TAU_UNIX at most once.
    function _countsValid(uint256[TOKEN_COUNT] memory counts) private pure returns (bool) {
        for (uint256 k; k < TOKEN_COUNT; ++k) {
            if (k == TAU_UNIX ? counts[k] > 1 : counts[k] != 1) return false;
        }
        return true;
    }

    /// @dev Matches a full token (braces included) at `i`. `len == 0` when none matches. The word read at
    ///      `i` may run past the end of `t`; only its first `len` bytes are compared, and only when
    ///      `i + len <= t.length`.
    function _tokenAt(bytes memory t, uint256 i) private pure returns (uint256 k, uint256 len) {
        bytes32 w;
        assembly ("memory-safe") {
            w := mload(add(add(t, 0x20), i))
        }
        uint256 n = t.length;
        for (k = 0; k < TOKEN_COUNT; ++k) {
            (bytes32 tok, uint256 l) = _token(k);
            if (i + l > n) continue;
            if (w & ~bytes32(type(uint256).max >> (l * 8)) == tok) return (k, l);
        }
        return (0, 0);
    }

    /// @dev Token `k` (braces included), left-aligned and zero-padded, and its length.
    function _token(uint256 k) private pure returns (bytes32, uint256) {
        if (k == 0) return ("{{MARKET_ID}}", 13);
        if (k == 1) return ("{{CHAIN_ID}}", 12);
        if (k == 2) return ("{{ORACLE}}", 10);
        if (k == 3) return ("{{QUESTION}}", 12);
        if (k == 4) return ("{{RULES}}", 9);
        if (k == 5) return ("{{TAU_UTC}}", 11);
        if (k == 6) return ("{{TAU_UNIX}}", 12);
        if (k == 7) return ("{{OUTCOME}}", 11);
        if (k == 8) return ("{{EVIDENCE}}", 12);
        return ("{{EVIDENCE_HASH}}", 17);
    }

    function _value(uint256 k, Fields memory f) private pure returns (string memory) {
        if (k == 0) return LibString.toHexString(uint256(f.marketId), 32);
        if (k == 1) return LibString.toString(f.chainId);
        if (k == 2) return LibString.toHexStringChecksummed(f.oracle);
        if (k == 3) return f.question;
        if (k == 4) return f.rules;
        if (k == 5) return _utc(f.tau);
        if (k == 6) return LibString.toString(uint256(f.tau));
        if (k == 7) return f.outcome == Outcome.YES ? "YES" : f.outcome == Outcome.NO ? "NO" : "INVALID";
        if (k == 8) return f.evidence;
        return LibString.toHexString(uint256(f.evidenceHash), 32);
    }

    function _utc(uint64 ts) private pure returns (string memory) {
        return string.concat(_date(ts), "T", _time(ts), "Z");
    }

    function _date(uint64 ts) private pure returns (string memory) {
        (uint256 y, uint256 mo, uint256 d) = DateTimeLib.timestampToDate(ts);
        return string.concat(_pad(y, 4), "-", _pad(mo, 2), "-", _pad(d, 2));
    }

    function _time(uint64 ts) private pure returns (string memory) {
        uint256 secs = uint256(ts) % 86400;
        return string.concat(_pad(secs / 3600, 2), ":", _pad((secs % 3600) / 60, 2), ":", _pad(secs % 60, 2));
    }

    function _pad(uint256 v, uint256 width) private pure returns (string memory s) {
        s = LibString.toString(v);
        while (bytes(s).length < width) {
            s = string.concat("0", s);
        }
    }

    function _slice(bytes memory t, uint256 start, uint256 end) private pure returns (bytes memory) {
        return bytes(LibString.slice(string(t), start, end));
    }
}
