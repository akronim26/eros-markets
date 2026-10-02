// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LibString} from "solady/utils/LibString.sol";

/// @title HostLib
/// @notice URL and host rules for Layer 1 feeds and allow-lists (plan §6.3 rule 3, §7.3; task O10.1).
///         The same rules run in the TypeScript evaluator (`packages/feedspec`) and are pinned by
///         `vectors/feedspec.json`, so a market the registry lists is a market the workflow can fetch.
/// @dev Codes match `IMarketRegistry.BadFeed`: 1 https, 2 host, 3 {id}, 4 urlParam.
///      Host: lowercase `[a-z0-9-]` labels of 1-63 bytes joined by dots, at least two labels, no label
///      starting or ending with `-` (the TypeScript `HOST_RE`). This also rejects userinfo (an at sign) and
///      ports (`:`). The host ends at the first `/`, `?` or `#`.
///      `{id}`: at most once, and after the first `/` that follows the host.
library HostLib {
    uint8 internal constant OK = 0;
    uint8 internal constant NOT_HTTPS = 1;
    uint8 internal constant BAD_HOST = 2;
    uint8 internal constant BAD_ID = 3;
    uint8 internal constant BAD_URL_PARAM = 4;

    string internal constant SCHEME = "https://";
    string internal constant ID = "{id}";
    uint256 internal constant MAX_LABEL = 63;
    uint256 internal constant MAX_URL_PARAM = 128;

    /// @notice True when `host` is lowercase labels of [a-z0-9-], 1-63 bytes each, no edge hyphen,
    ///         at least two labels.
    function isValidHost(string memory host) internal pure returns (bool) {
        bytes memory h = bytes(host);
        uint256 labels;
        uint256 start;
        for (uint256 i; i <= h.length; ++i) {
            if (i == h.length || h[i] == ".") {
                uint256 len = i - start;
                if (len == 0 || len > MAX_LABEL) return false;
                if (h[start] == "-" || h[i - 1] == "-") return false;
                ++labels;
                start = i + 1;
            } else if (!_isLowerAlnum(h[i]) && h[i] != "-") {
                return false;
            }
        }
        return labels >= 2;
    }

    /// @notice Host part of an `https://` URL. `code` is OK, NOT_HTTPS or BAD_HOST.
    function hostOf(string memory url) internal pure returns (uint8 code, string memory host) {
        if (!LibString.startsWith(url, SCHEME)) return (NOT_HTTPS, "");
        host = LibString.slice(url, bytes(SCHEME).length, _hostEnd(url));
        if (!isValidHost(host)) return (BAD_HOST, "");
        return (OK, host);
    }

    /// @notice Checks a URL template: scheme, host, and `{id}` count and placement.
    function checkTemplate(string memory template) internal pure returns (uint8) {
        (uint8 code,) = hostOf(template);
        if (code != OK) return code;
        uint256 id = LibString.indexOf(template, ID);
        if (id == LibString.NOT_FOUND) return OK;
        if (LibString.indexOf(template, ID, id + 1) != LibString.NOT_FOUND) return BAD_ID;
        uint256 slash = LibString.indexOf(template, "/", _hostEnd(template));
        if (slash == LibString.NOT_FOUND || id < slash) return BAD_ID;
        return OK;
    }

    /// @notice `urlParam` matches `[A-Za-z0-9._~-]{1,128}`.
    function isValidUrlParam(string memory param) internal pure returns (bool) {
        bytes memory p = bytes(param);
        if (p.length == 0 || p.length > MAX_URL_PARAM) return false;
        for (uint256 i; i < p.length; ++i) {
            bytes1 c = p[i];
            bool ok = _isLowerAlnum(c) || (c >= "A" && c <= "Z") || c == "." || c == "_" || c == "~" || c == "-";
            if (!ok) return false;
        }
        return true;
    }

    /// @notice Replaces the single `{id}` (if any) with `param`. Callers check the template first.
    function substitute(string memory template, string memory param) internal pure returns (string memory) {
        return LibString.replace(template, ID, param);
    }

    function _hostEnd(string memory url) private pure returns (uint256) {
        bytes memory u = bytes(url);
        for (uint256 i = bytes(SCHEME).length; i < u.length; ++i) {
            if (u[i] == "/" || u[i] == "?" || u[i] == "#") return i;
        }
        return u.length;
    }

    function _isLowerAlnum(bytes1 c) private pure returns (bool) {
        return (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    }
}
