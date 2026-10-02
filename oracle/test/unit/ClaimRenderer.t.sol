// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Outcome} from "../../src/types/OracleTypes.sol";
import {ClaimRenderer} from "../../src/libraries/ClaimRenderer.sol";

/// @notice Task O10.3. The expected text of the default template was produced independently in
///         TypeScript (viem 2.57.2 for the checksummed address and the hashes, `Date.toISOString` for the
///         UTC time), not with this library.
contract ClaimRendererTest is Test {
    string[9] internal REQUIRED =
        ["MARKET_ID", "CHAIN_ID", "ORACLE", "QUESTION", "RULES", "TAU_UTC", "OUTCOME", "EVIDENCE", "EVIDENCE_HASH"];

    /// Plan §6.4 default template, byte for byte.
    function _defaultTemplate() internal pure returns (string memory) {
        return string.concat(
            "Eros Markets market {{MARKET_ID}} (chain {{CHAIN_ID}}, oracle {{ORACLE}}).\n",
            "Question: {{QUESTION}}\n",
            "Rules: {{RULES}}\n",
            "Scheduled time T: {{TAU_UTC}} ({{TAU_UNIX}})\n",
            "Asserted outcome: {{OUTCOME}}\n",
            "Evidence: {{EVIDENCE}}, keccak256 {{EVIDENCE_HASH}}\n",
            "This assertion is true if and only if the rules above, applied to what happened, give the asserted outcome."
        );
    }

    function _expected() internal pure returns (string memory) {
        return string.concat(
            "Eros Markets market 0x7b93462ab20ad959cbf5322617af620671b89dd2fb2bc1417dadf5414ad384cf (chain 10143, oracle 0x00000000000000000000000000000000000000AA).\n",
            "Question: Will the Lakers beat the Celtics on 2027-01-15?\n",
            "Rules: YES if the Lakers win the game; NO otherwise. INVALID if the game is not played.\n",
            "Scheduled time T: 2027-01-15T08:00:00Z (1800000000)\n",
            "Asserted outcome: YES\n",
            "Evidence: ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi, keccak256 0xde77e793564bc5ba0713b610c743ab0d819d9580fcae7c67b4c6f835fb9ee500\n",
            "This assertion is true if and only if the rules above, applied to what happened, give the asserted outcome."
        );
    }

    function _fields() internal pure returns (ClaimRenderer.Fields memory f) {
        f.marketId = keccak256("market-1");
        f.chainId = 10143;
        f.oracle = address(0xAA);
        f.question = "Will the Lakers beat the Celtics on 2027-01-15?";
        f.rules = "YES if the Lakers win the game; NO otherwise. INVALID if the game is not played.";
        f.tau = 1800000000;
        f.outcome = Outcome.YES;
        f.evidence = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
        f.evidenceHash = keccak256("snapshot");
    }

    // ------------------------------------------------------------------ rendering

    function test_defaultTemplateRendersExpectedText() public pure {
        assertTrue(ClaimRenderer.isValidTemplate(_defaultTemplate()));
        assertEq(string(ClaimRenderer.render(_defaultTemplate(), _fields())), _expected());
    }

    function test_outcomeWords() public view {
        string memory t = _minimal("");
        ClaimRenderer.Fields memory f = _fields();
        assertTrue(_contains(string(ClaimRenderer.render(t, f)), "|YES|"));
        f.outcome = Outcome.NO;
        assertTrue(_contains(string(ClaimRenderer.render(t, f)), "|NO|"));
        f.outcome = Outcome.INVALID;
        assertTrue(_contains(string(ClaimRenderer.render(t, f)), "|INVALID|"));
    }

    function test_noOutcomeReverts() public {
        ClaimRenderer.Fields memory f = _fields();
        f.outcome = Outcome.NONE;
        vm.expectRevert(ClaimRenderer.NoOutcome.selector);
        this.renderExternal(_defaultTemplate(), f);
    }

    function test_invalidTemplateReverts() public {
        vm.expectRevert(ClaimRenderer.InvalidTemplate.selector);
        this.renderExternal("no tokens", _fields());
    }

    function test_utcZeroPadding() public pure {
        ClaimRenderer.Fields memory f = _fields();
        f.tau = 946717445; // 2000-01-01T09:04:05Z
        assertTrue(_contains(string(ClaimRenderer.render(_defaultTemplate(), f)), "2000-01-01T09:04:05Z (946717445)"));
    }

    function test_l1EvidenceText() public pure {
        bytes32 v = keccak256("3");
        string memory url = "https://api.example-sports.com/v1/events/evt_1";
        string memory s = ClaimRenderer.l1Evidence(v, url);
        assertEq(s, string.concat("Layer 1 CRE report, value ", vm.toString(v), ", source ", url));
        assertEq(bytes(s).length, ClaimRenderer.L1_EVIDENCE_FIXED + bytes(url).length);
    }

    function test_literalTextAroundTokensKept() public view {
        string memory t = string.concat("a { b } c }} d ", _minimal(""), " end");
        assertTrue(ClaimRenderer.isValidTemplate(t));
        string memory out = string(ClaimRenderer.render(t, _fields()));
        assertTrue(_contains(out, "a { b } c }} d |0x7b93"));
        assertTrue(_contains(out, " end"));
    }

    // ------------------------------------------------------------------ token rules

    function test_tauUnixOptional() public view {
        assertTrue(ClaimRenderer.isValidTemplate(_minimal("")));
        assertTrue(ClaimRenderer.isValidTemplate(_minimal("{{TAU_UNIX}}")));
    }

    function test_tauUnixTwiceRejected() public view {
        assertFalse(ClaimRenderer.isValidTemplate(_minimal("{{TAU_UNIX}}{{TAU_UNIX}}")));
    }

    function test_eachRequiredTokenMissingRejected() public view {
        for (uint256 k; k < 9; ++k) {
            string memory t;
            for (uint256 j; j < 9; ++j) {
                if (j != k) t = string.concat(t, "|{{", REQUIRED[j], "}}");
            }
            assertFalse(ClaimRenderer.isValidTemplate(t), REQUIRED[k]);
        }
    }

    function test_eachRequiredTokenTwiceRejected() public view {
        for (uint256 k; k < 9; ++k) {
            assertFalse(ClaimRenderer.isValidTemplate(_minimal(string.concat("{{", REQUIRED[k], "}}"))), REQUIRED[k]);
        }
    }

    function test_unknownOrMalformedTokensRejected() public view {
        assertFalse(ClaimRenderer.isValidTemplate(_minimal("{{FOO}}")), "unknown");
        assertFalse(ClaimRenderer.isValidTemplate(_minimal("{{market_id}}")), "lowercase");
        assertFalse(ClaimRenderer.isValidTemplate(_minimal("{{MARKET_ID")), "unclosed");
        assertFalse(ClaimRenderer.isValidTemplate(_minimal("{{ RULES }}")), "spaces");
        assertFalse(ClaimRenderer.isValidTemplate(_minimal("{{")), "stray double brace");
        string memory triple = "{{{MARKET_ID}}";
        for (uint256 k = 1; k < 9; ++k) {
            triple = string.concat(triple, "|{{", REQUIRED[k], "}}");
        }
        assertFalse(ClaimRenderer.isValidTemplate(triple), "triple brace before a token");
    }

    function test_worstCaseLengthOfDefault() public pure {
        uint256 tokenBytes =
            bytes(
            "{{MARKET_ID}}{{CHAIN_ID}}{{ORACLE}}{{QUESTION}}{{RULES}}{{TAU_UTC}}{{TAU_UNIX}}{{OUTCOME}}{{EVIDENCE}}{{EVIDENCE_HASH}}"
        )
        .length;
        uint256 want = bytes(_defaultTemplate()).length - tokenBytes + 10 + 20 + 66 + 20 + 42 + 20 + 20 + 7 + 66 + 256;
        assertEq(ClaimRenderer.worstCaseLength(_defaultTemplate(), 10, 20, 0), want);
        // A long L1 URL makes the L1 text exceed 256 bytes: 26 + 66 + 9 + 200 = 301.
        assertEq(ClaimRenderer.worstCaseLength(_defaultTemplate(), 10, 20, 200), want - 256 + 301);
    }

    /// Every variable field at its maximum: a 20-digit chain id, the last second of the year 9999 and a
    /// 256-byte evidence URI. The only slack left is the plan's 20 bytes for the unix time, which is
    /// 12 digits here, so the bound is exactly 8 bytes above the rendered length.
    function test_worstCaseExactAtMaximum() public pure {
        ClaimRenderer.Fields memory f = _fields();
        f.chainId = type(uint64).max; // 18446744073709551615: 20 digits
        f.tau = 253402300799; // 9999-12-31T23:59:59Z
        bytes memory uri = new bytes(256);
        for (uint256 i; i < 256; ++i) {
            uri[i] = "u";
        }
        f.evidence = string(uri);
        f.outcome = Outcome.INVALID; // 7 bytes, the longest outcome
        uint256 got = ClaimRenderer.render(_defaultTemplate(), f).length;
        uint256 maxLen =
            ClaimRenderer.worstCaseLength(_defaultTemplate(), bytes(f.question).length, bytes(f.rules).length, 0);
        assertEq(maxLen - got, 20 - 12);
    }

    // ------------------------------------------------------------------ fuzz

    /// Rendered length never exceeds the §6.3 worst-case bound, for any question and rules, evidence
    /// that is a URI of at most 256 bytes or the L1 text, tau up to the year 9999 and a 64-bit chain id.
    function testFuzz_renderedLengthWithinBound(
        bytes memory question,
        bytes memory rules,
        bytes memory uri,
        bytes memory url,
        bool l1,
        uint64 tau,
        uint64 chainId,
        address oracle,
        bytes32 marketId,
        bytes32 h,
        uint8 outcome
    ) public pure {
        ClaimRenderer.Fields memory f;
        f.marketId = marketId;
        f.chainId = chainId;
        f.oracle = oracle;
        f.question = string(question);
        f.rules = string(rules);
        f.tau = uint64(bound(tau, 0, 253402300799)); // 9999-12-31T23:59:59Z
        f.outcome = Outcome(bound(outcome, 1, 3));
        f.evidence = l1 ? ClaimRenderer.l1Evidence(h, string(url)) : string(_trim(uri, 256));
        f.evidenceHash = h;
        uint256 got = ClaimRenderer.render(_defaultTemplate(), f).length;
        uint256 maxLen =
            ClaimRenderer.worstCaseLength(_defaultTemplate(), question.length, rules.length, l1 ? url.length : 0);
        assertLe(got, maxLen);
    }

    // ------------------------------------------------------------------ helpers

    function renderExternal(string memory t, ClaimRenderer.Fields memory f) external pure returns (bytes memory) {
        return ClaimRenderer.render(t, f);
    }

    /// The nine required tokens once each, separated by `|`, followed by `extra`.
    function _minimal(string memory extra) internal view returns (string memory t) {
        for (uint256 k; k < 9; ++k) {
            t = string.concat(t, "|{{", REQUIRED[k], "}}");
        }
        t = string.concat(t, "|", extra);
    }

    function _trim(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        if (b.length <= n) return b;
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
    }

    function _contains(string memory s, string memory needle) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(needle);
        if (b.length > a.length) return false;
        for (uint256 i; i + b.length <= a.length; ++i) {
            bool eq = true;
            for (uint256 j; j < b.length; ++j) {
                if (a[i + j] != b[j]) {
                    eq = false;
                    break;
                }
            }
            if (eq) return true;
        }
        return false;
    }
}
