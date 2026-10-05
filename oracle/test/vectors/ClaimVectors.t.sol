// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {ClaimRenderer} from "../../src/libraries/ClaimRenderer.sol";
import {Outcome} from "../../src/types/OracleTypes.sol";

/// @notice Task O30.3 (plan §9, §12.9, ADJ-16). Renders a fixed set of claims through `ClaimRenderer` and checks
///         the result against `vectors/claim.json` byte for byte after JSON checkout-newline normalization;
///         oracle-sdk's TypeScript mirror reproduces the
///         same file. Each vector holds the template, the fields, the Layer 1 URL and value hash (when set, the
///         evidence is `l1Evidence(valueHash, l1Url)` and `fields.evidence` is ignored, as in a Layer 1
///         proposal), the rendered bytes, the registry's worst-case bound, and the error for an invalid case.
///         After a change to the renderer or the cases, regenerate with
///         `WRITE_CLAIM_VECTORS=true forge test --mc ClaimVectorsTest`.
contract ClaimVectorsTest is Test {
    string internal constant PATH = "vectors/claim.json";

    string internal constant EXAMPLE =
        "Eros Markets market {{MARKET_ID}} (chain {{CHAIN_ID}}, oracle {{ORACLE}}).\nQuestion: {{QUESTION}}\nRules: {{RULES}}\nScheduled time T: {{TAU_UTC}} ({{TAU_UNIX}})\nAsserted outcome: {{OUTCOME}}\nEvidence: {{EVIDENCE}}, keccak256 {{EVIDENCE_HASH}}\nThis assertion is true if and only if the rules above, applied to what happened, give the asserted outcome.";
    /// Every required token once, no TAU_UNIX.
    string internal constant BARE =
        "{{MARKET_ID}}|{{CHAIN_ID}}|{{ORACLE}}|{{QUESTION}}|{{RULES}}|{{TAU_UTC}}|{{OUTCOME}}|{{EVIDENCE}}|{{EVIDENCE_HASH}}";

    struct Case {
        string name;
        string template;
        ClaimRenderer.Fields f;
        string l1Url;
        bytes32 valueHash;
    }

    // ------------------------------------------------------------------ the cases

    function _base() internal pure returns (ClaimRenderer.Fields memory f) {
        f.marketId = keccak256("market-1");
        f.chainId = 10143;
        f.oracle = 0x837a41023CF81234f89F956C94D676918b4791c1;
        f.question = "Will Arsenal beat Leeds United in the Premier League match on 10 October 2026?";
        f.rules =
            "YES if Arsenal win in regular time per the official result on premierleague.com one hour after the final whistle; NO otherwise.";
        f.tau = 1791640800; // 2026-10-10T14:00:00Z
        f.outcome = Outcome.YES;
        f.evidence = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
        f.evidenceHash = keccak256("snapshot");
    }

    function _c(string memory name, string memory template, ClaimRenderer.Fields memory f)
        internal
        pure
        returns (Case memory)
    {
        return Case(name, template, f, "", bytes32(0));
    }

    function _cases() internal pure returns (Case[] memory cs) {
        cs = new Case[](27);
        uint256 n;
        ClaimRenderer.Fields memory f;

        f = _base();
        cs[n++] = Case(
            "example-l1-yes",
            EXAMPLE,
            f,
            "https://www.thesportsdb.com/api/v1/json/3/lookupevent.php?id=2494052",
            keccak256("Arsenal 2-1")
        );
        f = _base();
        f.outcome = Outcome.NO;
        cs[n++] = _c("example-uri-no", EXAMPLE, f);
        f = _base();
        f.outcome = Outcome.INVALID;
        cs[n++] = _c("example-invalid", EXAMPLE, f);

        f = _base();
        f.question = unicode"Will Zürich’s CPI print ≥ 2.0% — résumé 東京 🚀?";
        f.rules = "Line one.\n\tTabbed \"quoted\" and back\\slash, a { brace } and {single}.\r\nEnd \x01.";
        cs[n++] = _c("unicode-and-escapes", EXAMPLE, f);

        cs[n++] = _c(
            "reordered-adjacent-no-tau-unix",
            "{{EVIDENCE_HASH}}{{EVIDENCE}}{{OUTCOME}}{{TAU_UTC}}{{RULES}}{{QUESTION}}{{ORACLE}}{{CHAIN_ID}}{{MARKET_ID}}",
            _base()
        );
        cs[n++] = _c("bare-no-tau-unix", BARE, _base());
        cs[n++] = _c("literal-braces", string.concat("{x} }} { |", BARE, "}}}{ }"), _base());
        cs[n++] = _c("token-at-end-tau-unix", string.concat(BARE, " {{TAU_UNIX}}"), _base());

        f = _base();
        f.tau = 0;
        cs[n++] = _c("tau-epoch", string.concat(BARE, "|{{TAU_UNIX}}"), f);
        f = _base();
        f.tau = 1835481599; // 2028-02-29T23:59:59Z, a leap day
        cs[n++] = _c("tau-leap-day", string.concat(BARE, "|{{TAU_UNIX}}"), f);
        f = _base();
        f.tau = 951782400; // 2000-02-29T00:00:00Z, the 400-year leap
        cs[n++] = _c("tau-2000-leap", string.concat(BARE, "|{{TAU_UNIX}}"), f);
        f = _base();
        f.tau = 253402300799; // 9999-12-31T23:59:59Z
        cs[n++] = _c("tau-year-9999", string.concat(BARE, "|{{TAU_UNIX}}"), f);
        f = _base();
        f.tau = type(uint64).max;
        f.chainId = type(uint256).max;
        cs[n++] = _c("uint64-tau-uint256-chain", string.concat(BARE, "|{{TAU_UNIX}}"), f);

        f = _base();
        f.marketId = bytes32(uint256(1));
        f.evidenceHash = bytes32(0);
        f.oracle = 0x00000000000000000000000000000000000000AA;
        f.chainId = 143;
        cs[n++] = _c("leading-zeros", BARE, f);
        f = _base();
        f.question = "";
        f.rules = "";
        f.evidence = "";
        cs[n++] = _c("empty-strings", BARE, f);
        f = _base();
        f.question = "0xdeadbeef";
        f.rules = "0x";
        f.evidence = "0x00";
        cs[n++] = _c("hex-looking-text", BARE, f);
        f = _base();
        f.evidence = string.concat("ipfs://", _repeat("a", 249)); // 256 bytes, MAX_EVIDENCE_URI_BYTES
        cs[n++] = _c("max-evidence-uri", EXAMPLE, f);

        cs[n++] = Case(
            "long-l1-url",
            EXAMPLE,
            _base(),
            string.concat("https://api.example.com/v1/events?id=2494052&fields=", _repeat("strHomeTeam,", 15)),
            keccak256("Arsenal 2-1")
        );

        // Invalid templates and outcomes: InvalidTemplate is checked first, then NoOutcome.
        cs[n++] = _c(
            "missing-token",
            "{{MARKET_ID}}{{CHAIN_ID}}{{ORACLE}}{{QUESTION}}{{RULES}}{{TAU_UTC}}{{OUTCOME}}{{EVIDENCE}}",
            _base()
        );
        cs[n++] = _c("duplicate-token", string.concat(BARE, "{{QUESTION}}"), _base());
        cs[n++] = _c("tau-unix-twice", string.concat(BARE, "{{TAU_UNIX}}{{TAU_UNIX}}"), _base());
        cs[n++] = _c("unknown-token", string.concat(BARE, "{{FOO}}"), _base());
        cs[n++] = _c("triple-brace", string.concat("{", BARE), _base());
        cs[n++] = _c("trailing-open-braces", string.concat(BARE, "{{"), _base());
        cs[n++] = _c("truncated-token", string.concat(BARE, "{{EVIDENCE_HAS"), _base());
        f = _base();
        f.outcome = Outcome.NONE;
        cs[n++] = _c("no-outcome", BARE, f);
        cs[n++] = _c("invalid-wins-over-no-outcome", string.concat(BARE, "{{market_id}}"), f);
        assertEq(n, cs.length, "case count");
    }

    function _repeat(string memory s, uint256 times) internal pure returns (string memory r) {
        for (uint256 i; i < times; ++i) {
            r = string.concat(r, s);
        }
    }

    // ------------------------------------------------------------------ rendering (external for try/catch)

    function renderExt(string calldata template, ClaimRenderer.Fields calldata f) external pure returns (bytes memory) {
        return ClaimRenderer.render(template, f);
    }

    function worstCaseExt(string calldata template, uint256 q, uint256 r, uint256 u) external pure returns (uint256) {
        return ClaimRenderer.worstCaseLength(template, q, r, u);
    }

    function _errorName(bytes memory err) internal pure returns (string memory) {
        if (bytes4(err) == ClaimRenderer.InvalidTemplate.selector) return "InvalidTemplate";
        if (bytes4(err) == ClaimRenderer.NoOutcome.selector) return "NoOutcome";
        revert("unexpected revert");
    }

    // ------------------------------------------------------------------ JSON

    function _q(string memory s) internal pure returns (string memory) {
        return LibString.escapeJSON(s, true);
    }

    function _fieldsJson(ClaimRenderer.Fields memory f) internal pure returns (string memory) {
        string memory a = string.concat(
            '{"marketId": ',
            _q(vm.toString(f.marketId)),
            ', "chainId": ',
            _q(vm.toString(f.chainId)),
            ', "oracle": ',
            _q(LibString.toHexString(f.oracle)),
            ', "question": ',
            _q(f.question),
            ', "rules": ',
            _q(f.rules)
        );
        return string.concat(
            a,
            ', "tau": ',
            _q(vm.toString(uint256(f.tau))),
            ', "outcome": ',
            vm.toString(uint256(f.outcome)),
            ', "evidence": ',
            _q(f.evidence),
            ', "evidenceHash": ',
            _q(vm.toString(f.evidenceHash)),
            "}"
        );
    }

    function _caseJson(Case memory c) internal view returns (string memory) {
        ClaimRenderer.Fields memory f = c.f;
        string memory evidence = f.evidence;
        if (bytes(c.l1Url).length != 0) f.evidence = ClaimRenderer.l1Evidence(c.valueHash, c.l1Url);

        string memory rendered = "null";
        string memory err = "null";
        try this.renderExt(c.template, f) returns (bytes memory out) {
            rendered = _q(vm.toString(out));
        } catch (bytes memory e) {
            err = _q(_errorName(e));
        }
        string memory worst = "null";
        try this.worstCaseExt(
            c.template, bytes(f.question).length, bytes(f.rules).length, bytes(c.l1Url).length
        ) returns (
            uint256 w
        ) {
            worst = vm.toString(w);
        } catch (bytes memory e) {
            assertEq(_errorName(e), "InvalidTemplate");
        }
        f.evidence = evidence;

        string memory a = string.concat(
            '    {"name": ',
            _q(c.name),
            ',\n     "template": ',
            _q(c.template),
            ',\n     "fields": ',
            _fieldsJson(f),
            ',\n     "l1Url": ',
            _q(c.l1Url),
            ', "valueHash": ',
            _q(vm.toString(c.valueHash))
        );
        return
            string.concat(a, ',\n     "rendered": ', rendered, ',\n     "worstCase": ', worst, ', "error": ', err, "}");
    }

    function _json() internal view returns (string memory j) {
        Case[] memory cs = _cases();
        j = string.concat(
            "{\n",
            '  "source": "src/libraries/ClaimRenderer.sol via test/vectors/ClaimVectors.t.sol (task O30.3); regenerate with WRITE_CLAIM_VECTORS=true forge test --mc ClaimVectorsTest",\n',
            '  "evidenceRule": "when l1Url is set, the evidence is \\"Layer 1 CRE report, value \\" + valueHash + \\", source \\" + l1Url and fields.evidence is ignored",\n',
            '  "vectors": [\n'
        );
        for (uint256 i; i < cs.length; ++i) {
            j = string.concat(j, _caseJson(cs[i]), i + 1 < cs.length ? ",\n" : "\n");
        }
        j = string.concat(j, "  ]\n}\n");
    }

    // ------------------------------------------------------------------ tests

    function test_claimVectors() public {
        string memory j = _json();
        if (vm.envOr("WRITE_CLAIM_VECTORS", false)) vm.writeFile(PATH, j);
        // Git may check out the JSON envelope as CRLF. Payload hex and escaped
        // CR/LF inside JSON strings are preserved; the rendered wire bytes must
        // still match exactly, without regenerating any expected vector.
        string memory checkedIn = LibString.replace(vm.readFile(PATH), "\r\n", "\n");
        assertEq(checkedIn, j, "vectors/claim.json is stale: regenerate with WRITE_CLAIM_VECTORS=true");
    }

    /// The example vector is what a Layer 1 YES proposal on the sample market asserts.
    function test_exampleRendersAsExpected() public pure {
        ClaimRenderer.Fields memory f = _base();
        f.evidence = "ipfs://x";
        string memory got = string(ClaimRenderer.render(EXAMPLE, f));
        assertTrue(LibString.contains(got, "chain 10143, oracle 0x837a41023CF81234f89F956C94D676918b4791c1"));
        assertTrue(LibString.contains(got, "Scheduled time T: 2026-10-10T14:00:00Z (1791640800)"));
        assertTrue(LibString.contains(got, "Asserted outcome: YES\nEvidence: ipfs://x, keccak256 0x"));
    }
}
