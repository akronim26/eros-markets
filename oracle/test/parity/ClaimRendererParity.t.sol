// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Outcome} from "../../src/types/OracleTypes.sol";
import {ClaimRenderer} from "../../src/libraries/ClaimRenderer.sol";
import {ClaimRendererV1} from "./ClaimRendererV1.sol";

/// @notice Task O18.1: the gas rewrite of `ClaimRenderer` renders exactly what the frozen `ClaimRendererV1`
///         rendered. The claim is UMA-facing text that oracle-sdk mirrors, so every output byte, every
///         revert and its error, `isValidTemplate` and `worstCaseLength` must be unchanged.
/// @dev Templates are fuzzed in two families: valid ones (the ten tokens in a random order, TAU_UNIX
///      optional, random literals without braces between them) and arbitrary ones built from tokens,
///      literals and malformed pieces (stray, unclosed, tripled or unknown braces), most of them invalid.
contract ClaimRendererParityTest is Test {
    string[10] internal TOKENS = [
        "{{MARKET_ID}}",
        "{{CHAIN_ID}}",
        "{{ORACLE}}",
        "{{QUESTION}}",
        "{{RULES}}",
        "{{TAU_UTC}}",
        "{{TAU_UNIX}}",
        "{{OUTCOME}}",
        "{{EVIDENCE}}",
        "{{EVIDENCE_HASH}}"
    ];
    string[8] internal BROKEN = ["{{", "{", "}}", "{{X}}", "{{{RULES}}", "{RULES}}", "{{RULES}", "{{rules}}"];

    // ------------------------------------------------------------------ parity

    /// The plan's default template with fuzzed fields.
    function testFuzz_defaultTemplate(
        bytes32 marketId,
        uint64 chainId,
        address oracle,
        bytes calldata question,
        bytes calldata rules,
        uint64 tau,
        uint8 outcome,
        bytes calldata evidence,
        bytes32 evidenceHash
    ) public view {
        ClaimRenderer.Fields memory f = ClaimRenderer.Fields(
            marketId,
            chainId,
            oracle,
            string(question),
            string(rules),
            tau,
            Outcome(outcome % 4),
            string(evidence),
            evidenceHash
        );
        _assertSame(_defaultTemplate(), f);
    }

    /// Valid templates: every token once in a random order, TAU_UNIX optional, random literals between.
    function testFuzz_validTemplates(uint256 seed, bytes32 marketId, uint64 tau, uint8 outcome, bytes calldata text)
        public
        view
    {
        string memory tpl = _validTemplate(seed, text);
        assertTrue(ClaimRendererV1.isValidTemplate(tpl), "the generator makes valid templates");
        _assertSame(tpl, _fields(marketId, tau, outcome, text));
    }

    /// Arbitrary templates from tokens, literals and malformed pieces: same output or the same revert.
    function testFuzz_arbitraryTemplates(uint256 seed, bytes32 marketId, uint64 tau, uint8 outcome, bytes calldata text)
        public
        view
    {
        _assertSame(_arbitraryTemplate(seed, text), _fields(marketId, tau, outcome, text));
    }

    /// Hand-picked edge cases: braces at the very end, a token cut by the end, nested and adjacent braces.
    function test_edgeTemplates() public view {
        string memory d = _defaultTemplate();
        string[9] memory tails = ["{", "{{", "{{EVIDENCE_HAS", "{{TAU_UNIX}", "}}", "{{{", "{{}}", "x{{TAU_UNIX}}", ""];
        for (uint256 i; i < tails.length; ++i) {
            _assertSame(string.concat(d, tails[i]), _fields(keccak256("m"), 1_800_000_000, 1, "evidence"));
            _assertSame(string.concat(tails[i], d), _fields(keccak256("m"), 1_800_000_000, 2, "evidence"));
        }
        _assertSame("", _fields(keccak256("m"), 1, 1, ""));
        _assertSame("{{EVIDENCE_HASH}}{{EVIDENCE}}", _fields(keccak256("m"), 1, 3, "e"));
    }

    // ------------------------------------------------------------------ comparison

    function _assertSame(string memory tpl, ClaimRenderer.Fields memory f) internal view {
        (bool okNew, bytes memory outNew) = address(this).staticcall(abi.encodeCall(this.renderNew, (tpl, f)));
        (bool okOld, bytes memory outOld) = address(this).staticcall(abi.encodeCall(this.renderOld, (tpl, _v1(f))));
        assertEq(okNew, okOld, "same success");
        assertEq(outNew, outOld, "same claim or same revert");
        assertEq(ClaimRenderer.isValidTemplate(tpl), ClaimRendererV1.isValidTemplate(tpl), "same validity");
        (bool wNew, bytes memory lenNew) =
            address(this).staticcall(abi.encodeCall(this.worstNew, (tpl, bytes(f.question).length, 7, 40)));
        (bool wOld, bytes memory lenOld) =
            address(this).staticcall(abi.encodeCall(this.worstOld, (tpl, bytes(f.question).length, 7, 40)));
        assertEq(wNew, wOld);
        assertEq(lenNew, lenOld, "same worst-case bound");
    }

    function renderNew(string memory tpl, ClaimRenderer.Fields memory f) external pure returns (bytes memory) {
        return ClaimRenderer.render(tpl, f);
    }

    function renderOld(string memory tpl, ClaimRendererV1.Fields memory f) external pure returns (bytes memory) {
        return ClaimRendererV1.render(tpl, f);
    }

    function worstNew(string memory tpl, uint256 q, uint256 r, uint256 u) external pure returns (uint256) {
        return ClaimRenderer.worstCaseLength(tpl, q, r, u);
    }

    function worstOld(string memory tpl, uint256 q, uint256 r, uint256 u) external pure returns (uint256) {
        return ClaimRendererV1.worstCaseLength(tpl, q, r, u);
    }

    // ------------------------------------------------------------------ generators

    function _validTemplate(uint256 seed, bytes calldata text) internal view returns (string memory tpl) {
        uint256[10] memory order = [uint256(0), 1, 2, 3, 4, 5, 6, 7, 8, 9];
        for (uint256 i = 9; i > 0; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % (i + 1);
            (order[i], order[j]) = (order[j], order[i]);
        }
        bool withUnix = seed % 2 == 0;
        for (uint256 i; i < 10; ++i) {
            if (order[i] == 6 && !withUnix) continue;
            tpl = string.concat(tpl, _literal(text, seed, i), TOKENS[order[i]]);
        }
        tpl = string.concat(tpl, _literal(text, seed, 10));
    }

    function _arbitraryTemplate(uint256 seed, bytes calldata text) internal view returns (string memory tpl) {
        uint256 pieces = seed % 24;
        for (uint256 i; i < pieces; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, "piece", i)));
            uint256 kind = r % 3;
            if (kind == 0) tpl = string.concat(tpl, TOKENS[(r >> 8) % 10]);
            else if (kind == 1) tpl = string.concat(tpl, BROKEN[(r >> 8) % 8]);
            else tpl = string.concat(tpl, _rawLiteral(text, r));
        }
    }

    /// A literal without braces (keeps a valid template valid).
    function _literal(bytes calldata text, uint256 seed, uint256 i) internal pure returns (string memory) {
        bytes memory b = bytes(_rawLiteral(text, uint256(keccak256(abi.encode(seed, "lit", i)))));
        for (uint256 j; j < b.length; ++j) {
            if (b[j] == "{" || b[j] == "}") b[j] = "-";
        }
        return string(b);
    }

    /// Up to 12 bytes of the fuzzed text, braces included.
    function _rawLiteral(bytes calldata text, uint256 r) internal pure returns (string memory) {
        if (text.length == 0) return " ";
        uint256 start = r % text.length;
        uint256 len = (r >> 16) % 13;
        uint256 end = start + len > text.length ? text.length : start + len;
        return string(text[start:end]);
    }

    function _fields(bytes32 marketId, uint64 tau, uint8 outcome, bytes memory text)
        internal
        pure
        returns (ClaimRenderer.Fields memory f)
    {
        f = ClaimRenderer.Fields(
            marketId, 10143, address(0xAA), string(text), "rules", tau, Outcome(outcome % 4), "ipfs://e", marketId
        );
    }

    function _v1(ClaimRenderer.Fields memory f) internal pure returns (ClaimRendererV1.Fields memory g) {
        g = ClaimRendererV1.Fields(
            f.marketId, f.chainId, f.oracle, f.question, f.rules, f.tau, f.outcome, f.evidence, f.evidenceHash
        );
    }

    /// Plan §6.4 default template, byte for byte (as RegistryFixture).
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
}
