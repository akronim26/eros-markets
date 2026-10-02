// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HostLib} from "../../src/libraries/HostLib.sol";

/// @notice Task O10.1: one accept and one reject test per HostLib rule, plus fuzz tests.
contract HostLibTest is Test {
    string internal constant HOST = "api.example-sports.com";

    // ------------------------------------------------------------------ scheme

    function test_scheme_https_accepted() public pure {
        assertEq(HostLib.checkTemplate("https://api.example-sports.com/v1/{id}"), HostLib.OK);
    }

    function test_scheme_http_rejected() public pure {
        assertEq(HostLib.checkTemplate("http://api.example-sports.com/v1/{id}"), HostLib.NOT_HTTPS);
    }

    function test_scheme_uppercase_rejected() public pure {
        assertEq(HostLib.checkTemplate("HTTPS://api.example-sports.com/v1/{id}"), HostLib.NOT_HTTPS);
    }

    // ------------------------------------------------------------------ host

    function test_host_valid_variants() public pure {
        assertTrue(HostLib.isValidHost("a.b"));
        assertTrue(HostLib.isValidHost("api.example-sports.com"));
        assertTrue(HostLib.isValidHost("x1.y-2.z3"));
        assertTrue(HostLib.isValidHost(string.concat(_label(63), ".com")));
    }

    function test_host_uppercase_rejected() public pure {
        assertFalse(HostLib.isValidHost("API.example.com"));
    }

    function test_host_single_label_rejected() public pure {
        assertFalse(HostLib.isValidHost("localhost"));
    }

    function test_host_edge_hyphen_rejected() public pure {
        assertFalse(HostLib.isValidHost("-api.example.com"));
        assertFalse(HostLib.isValidHost("api-.example.com"));
    }

    function test_host_empty_label_rejected() public pure {
        assertFalse(HostLib.isValidHost("api..com"));
        assertFalse(HostLib.isValidHost(".example.com"));
        assertFalse(HostLib.isValidHost("example.com."));
        assertFalse(HostLib.isValidHost(""));
    }

    function test_host_label_length() public pure {
        assertTrue(HostLib.isValidHost(string.concat(_label(63), ".com")));
        assertFalse(HostLib.isValidHost(string.concat(_label(64), ".com")));
    }

    function test_host_port_rejected() public pure {
        assertEq(HostLib.checkTemplate("https://api.example-sports.com:443/v1/{id}"), HostLib.BAD_HOST);
    }

    function test_host_userinfo_rejected() public pure {
        assertEq(HostLib.checkTemplate("https://user@api.example-sports.com/v1/{id}"), HostLib.BAD_HOST);
    }

    function test_host_ends_at_slash_query_or_fragment() public pure {
        (uint8 c1, string memory h1) = HostLib.hostOf("https://api.example-sports.com/x");
        (uint8 c2, string memory h2) = HostLib.hostOf("https://api.example-sports.com?x=1");
        (uint8 c3, string memory h3) = HostLib.hostOf("https://api.example-sports.com#f");
        (uint8 c4, string memory h4) = HostLib.hostOf("https://api.example-sports.com");
        assertEq(c1 + c2 + c3 + c4, 0);
        assertEq(h1, HOST);
        assertEq(h2, HOST);
        assertEq(h3, HOST);
        assertEq(h4, HOST);
    }

    function test_host_empty_rejected() public pure {
        (uint8 code,) = HostLib.hostOf("https:///v1");
        assertEq(code, HostLib.BAD_HOST);
    }

    // ------------------------------------------------------------------ {id}

    function test_id_absent_accepted() public pure {
        assertEq(HostLib.checkTemplate("https://api.example-sports.com/v1/events/evt_1"), HostLib.OK);
    }

    function test_id_after_slash_in_query_accepted() public pure {
        assertEq(HostLib.checkTemplate("https://api.example-sports.com/v1/events?id={id}"), HostLib.OK);
    }

    function test_id_twice_rejected() public pure {
        assertEq(HostLib.checkTemplate("https://api.example-sports.com/{id}/{id}"), HostLib.BAD_ID);
    }

    function test_id_without_slash_after_host_rejected() public pure {
        assertEq(HostLib.checkTemplate("https://api.example-sports.com?e={id}"), HostLib.BAD_ID);
    }

    function test_id_inside_host_is_a_host_error() public pure {
        // Codes are checked in order (1 https, 2 host, 3 {id}); `{` is not a host character.
        assertEq(HostLib.checkTemplate("https://{id}.example-sports.com/x"), HostLib.BAD_HOST);
    }

    // ------------------------------------------------------------------ urlParam

    function test_urlParam_valid() public pure {
        assertTrue(HostLib.isValidUrlParam("evt_1"));
        assertTrue(HostLib.isValidUrlParam("AZaz09._~-"));
        assertTrue(HostLib.isValidUrlParam(_label(128)));
    }

    function test_urlParam_empty_rejected() public pure {
        assertFalse(HostLib.isValidUrlParam(""));
    }

    function test_urlParam_too_long_rejected() public pure {
        assertFalse(HostLib.isValidUrlParam(_label(129)));
    }

    function test_urlParam_bad_chars_rejected() public pure {
        assertFalse(HostLib.isValidUrlParam("a/b"));
        assertFalse(HostLib.isValidUrlParam("a?b"));
        assertFalse(HostLib.isValidUrlParam("a b"));
        assertFalse(HostLib.isValidUrlParam("a%20"));
        assertFalse(HostLib.isValidUrlParam("{id}"));
    }

    // ------------------------------------------------------------------ substitution

    function test_substitute_and_host_of_result() public pure {
        string memory url = HostLib.substitute("https://api.example-sports.com/v1/events/{id}", "evt_1");
        assertEq(url, "https://api.example-sports.com/v1/events/evt_1");
        (uint8 code, string memory host) = HostLib.hostOf(url);
        assertEq(code, HostLib.OK);
        assertEq(host, HOST);
    }

    function test_substitute_without_id_is_identity() public pure {
        assertEq(HostLib.substitute("https://a.b/x", "evt_1"), "https://a.b/x");
    }

    // ------------------------------------------------------------------ fuzz

    /// A template the library accepts, with a valid parameter, yields a URL whose host passes the
    /// host rule and equals the template's host: substitution can never change the host. The host is
    /// built from two valid labels and, in about a quarter of the runs, one byte is replaced by a
    /// character that must be rejected (colon, at sign, slash, question mark, hash, brace, uppercase, underscore); the path and the
    /// parameter are drawn from alphabets that include `?`, `{`, `}` and `/`.
    function testFuzz_acceptedUrlKeepsValidHost(
        uint256 s1,
        uint256 s2,
        uint8 corrupt,
        uint8 pos,
        bytes memory pathSeed,
        bytes memory paramSeed
    ) public pure {
        bytes memory host = bytes(string.concat(_genLabel(s1), ".", _genLabel(s2)));
        if (corrupt % 4 == 0) host[pos % host.length] = bytes(":@/?#{A_")[corrupt % 8];
        string memory template = string.concat("https://", string(host), _map(pathSeed, "/xi?={}d", 12), "/{id}");
        string memory param = _map(paramSeed, "abcXYZ0129._~-/", 20);
        if (HostLib.checkTemplate(template) != HostLib.OK || !HostLib.isValidUrlParam(param)) return;
        (, string memory templateHost) = HostLib.hostOf(template);
        (uint8 code, string memory got) = HostLib.hostOf(HostLib.substitute(template, param));
        assertEq(code, HostLib.OK);
        assertTrue(HostLib.isValidHost(got));
        assertEq(got, templateHost);
    }

    /// Hosts built from valid labels are always accepted, so the fuzzer above reaches the accept path.
    function testFuzz_generatedHostAccepted(uint8 n, uint256 seed) public pure {
        uint256 labels = bound(n, 2, 5);
        string memory h = _genLabel(seed);
        for (uint256 i = 1; i < labels; ++i) {
            h = string.concat(h, ".", _genLabel(uint256(keccak256(abi.encode(seed, i)))));
        }
        assertTrue(HostLib.isValidHost(h));
        string memory template = string.concat("https://", h, "/v1/{id}");
        assertEq(HostLib.checkTemplate(template), HostLib.OK);
        (, string memory host) = HostLib.hostOf(HostLib.substitute(template, "evt_1"));
        assertEq(host, h);
    }

    // ------------------------------------------------------------------ helpers

    function _map(bytes memory seed, bytes memory alphabet, uint256 maxLen) internal pure returns (string memory) {
        uint256 len = seed.length < maxLen ? seed.length : maxLen;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = alphabet[uint8(seed[i]) % alphabet.length];
        }
        return string(out);
    }

    function _label(uint256 len) internal pure returns (string memory) {
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = "a";
        }
        return string(b);
    }

    /// A random valid label: 1-63 chars from [a-z0-9-], first and last char alphanumeric.
    function _genLabel(uint256 seed) internal pure returns (string memory) {
        bytes memory alnum = "abcdefghijklmnopqrstuvwxyz0123456789";
        bytes memory all = "abcdefghijklmnopqrstuvwxyz0123456789-";
        uint256 len = 1 + (seed % 63);
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, "c", i)));
            b[i] = (i == 0 || i == len - 1) ? alnum[r % alnum.length] : all[r % all.length];
        }
        return string(b);
    }
}
