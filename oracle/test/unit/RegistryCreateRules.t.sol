// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Globals, MarketInput, GroupInfo} from "../../src/types/OracleTypes.sol";
import {IMarketRegistry} from "../../src/interfaces/IMarketRegistry.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {RegistryFixture} from "./RegistryFixture.sol";
import {MockOracleView} from "../mocks/MockOracleView.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";

/// @dev Exposes `createMarket` rules 1-6 and the groups switch; marks a market listed for the duplicate rule.
contract RegistryRulesHarness is MarketRegistry {
    bool public groupsOn;

    constructor(address oracle_, address usdc_, address gov_)
        MarketRegistry(oracle_, address(0x7EA5), address(0xFAC), usdc_, gov_, address(0x1157))
    {}

    function setGroupsOn(bool on) external {
        groupsOn = on;
    }

    function validate(MarketInput calldata m) external returns (uint256 venueMinimumBond) {
        (, venueMinimumBond) = _validateMarket(m);
    }

    function markListed(bytes32 id) external {
        _cores[id].engine = address(0xE);
    }

    function _groupsEnabled() internal view override returns (bool) {
        return groupsOn;
    }
}

/// @notice Task O11.3: `createMarket` rules 1-6 (plan §6.3), one test per error code with the exact code
///         (C.4), plus a fully valid input.
/// @dev Inputs are the plan's testnet demo values (§14.1, §12.11 globals). The void bound for them is the
///      §14.2 / C.7 testnet figure, 6,000 s; the claim bound is recomputed here from the §6.3 rule 6 text.
contract RegistryCreateRulesTest is RegistryFixture {
    RegistryRulesHarness internal reg;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(NOW);
        oracle = new MockOracleView();
        venue = new MockAssertionVenue(usdc, 2e6);
        _activateVenue(1, address(venue));
        reg = new RegistryRulesHarness(address(oracle), usdc, gov);
        vm.startPrank(gov);
        reg.setGlobals(_globals());
        reg.setProvider(HOST, true);
        reg.setProvider(OTHER, true);
        vm.stopPrank();
    }

    function _ok(MarketInput memory m) internal {
        reg.validate(m);
    }

    function _rejects(MarketInput memory m, bytes4 err, uint8 code) internal {
        vm.expectRevert(abi.encodeWithSelector(err, code));
        reg.validate(m);
    }

    function _rejects(MarketInput memory m, bytes4 err) internal {
        vm.expectRevert(err);
        reg.validate(m);
    }

    // ------------------------------------------------------------------ valid inputs

    function test_validMarketPasses() public {
        assertEq(reg.validate(_market()), 2e6, "venue minimum of the active trust set");
    }

    function test_validNoFeedMarketPasses() public {
        _ok(_noFeed());
    }

    // ------------------------------------------------------------------ rule 1: identity

    function test_rule1_duplicateMarket() public {
        reg.markListed(keccak256("market-1"));
        _rejects(_market(), IMarketRegistry.DuplicateMarket.selector);
    }

    function test_rule1_zeroMarketId() public {
        MarketInput memory m = _market();
        m.marketId = 0;
        _rejects(m, IMarketRegistry.DuplicateMarket.selector);
    }

    function test_rule1_noActiveTrustSet() public {
        oracle.setActiveTrustSetId(0);
        _rejects(_market(), IMarketRegistry.NoActiveTrustSet.selector);
    }

    function test_rule1_noGlobalsYet() public {
        RegistryRulesHarness fresh = new RegistryRulesHarness(address(oracle), usdc, gov);
        vm.expectRevert(abi.encodeWithSelector(IMarketRegistry.BadGlobals.selector, uint8(0)));
        fresh.validate(_market());
    }

    /// The harness switch (off by default) stands in for a build without the group code.
    function test_rule1_groupsSwitchedOff() public {
        MarketInput memory m = _market();
        m.groupId = keccak256("group");
        _rejects(m, IMarketRegistry.EarlyCheckOrGroupsDisabled.selector);
    }

    function test_rule1_groupMismatch() public {
        reg.setGroupsOn(true);
        MarketInput memory a = _market();
        a.groupId = keccak256("group");
        a.groupExclusive = true;
        _ok(a);
        GroupInfo memory gi = reg.groupInfo(keccak256("group"));
        assertTrue(gi.exists && gi.exclusive, "first market records the group");

        MarketInput memory b = a;
        b.marketId = keccak256("market-2");
        b.groupExclusive = false;
        _rejects(b, IMarketRegistry.GroupMismatch.selector);
        b.groupExclusive = true;
        _ok(b);

        // A non-exclusive group is recorded as such and refuses an exclusive member.
        MarketInput memory c = _market();
        c.marketId = keccak256("market-3");
        c.groupId = keccak256("open group");
        _ok(c);
        gi = reg.groupInfo(keccak256("open group"));
        assertTrue(gi.exists && !gi.exclusive);
        c.marketId = keccak256("market-4");
        c.groupExclusive = true;
        _rejects(c, IMarketRegistry.GroupMismatch.selector);
    }

    // ------------------------------------------------------------------ rule 2: times (BadTimes)

    function test_rule2_code1_horizonLower() public {
        MarketInput memory m = _market();
        m.tau = NOW + 600;
        m.windowEnd = m.tau;
        _ok(m);
        m.tau = NOW + 599;
        m.windowEnd = m.tau;
        _rejects(m, IMarketRegistry.BadTimes.selector, 1);
    }

    function test_rule2_code1_horizonUpper() public {
        Globals memory g = _globals();
        g.maxVoidSecs = 90 days;
        vm.prank(gov);
        reg.setGlobals(g);
        MarketInput memory m = _market();
        m.tau = NOW + 2_588_400;
        m.windowEnd = m.tau;
        m.voidSecs = 2_588_400 + 3_600; // the engine gate
        _ok(m);
        m.tau += 1;
        m.windowEnd = m.tau;
        _rejects(m, IMarketRegistry.BadTimes.selector, 1);
    }

    function test_rule2_code2_window() public {
        MarketInput memory m = _market();
        m.windowStart = m.windowEnd;
        _rejects(m, IMarketRegistry.BadTimes.selector, 2);
        m = _market();
        m.windowEnd = m.tau + 1;
        _rejects(m, IMarketRegistry.BadTimes.selector, 2);
        m.windowEnd = m.tau;
        m.windowStart = m.tau - 1;
        _ok(m);
    }

    function test_rule2_code3_l2Deadline() public {
        MarketInput memory m = _market();
        m.l2DeadlineSecs = 60;
        _ok(m);
        m.l2DeadlineSecs = 59;
        _rejects(m, IMarketRegistry.BadTimes.selector, 3);
        m.l2DeadlineSecs = 3_600;
        m.voidSecs = 9_000; // the bound grows with T_L2: 6,000 - 600 + 3,600
        _ok(m);
        m.l2DeadlineSecs = 3_601;
        _rejects(m, IMarketRegistry.BadTimes.selector, 3);
    }

    function test_rule2_code4_voidBound() public {
        MarketInput memory m = _market();
        m.voidSecs = 6_000; // §14.2 testnet demo bound, above the engine gate (1,800 + 3,600)
        _ok(m);
        m.voidSecs = 5_999;
        _rejects(m, IMarketRegistry.BadTimes.selector, 4);
    }

    function test_rule2_code4_voidBoundWithoutFeedOmitsL1Timeout() public {
        MarketInput memory m = _noFeed();
        m.voidSecs = 5_700; // 6,000 - T_L1 300
        _ok(m);
        m.voidSecs = 5_699;
        _rejects(m, IMarketRegistry.BadTimes.selector, 4);
        assertEq(reg.minVoidSecs(false, 300, 600, 300), 5_700);
    }

    function test_rule2_code5_voidAboveMax() public {
        MarketInput memory m = _market();
        m.voidSecs = 604_800;
        _ok(m);
        m.voidSecs = 604_801;
        _rejects(m, IMarketRegistry.BadTimes.selector, 5);
    }

    function test_rule2_code6_engineGate() public {
        MarketInput memory m = _market();
        m.tau = NOW + 3_600;
        m.windowEnd = m.tau;
        m.voidSecs = 7_200; // T + 3,600 == listedAt + voidSecs
        _ok(m);
        m.voidSecs = 7_199; // still above the 6,000 void bound
        _rejects(m, IMarketRegistry.BadTimes.selector, 6);
    }

    // ------------------------------------------------------------------ rule 3: feed (BadFeed)

    function test_rule3_code1_https() public {
        MarketInput memory m = _market();
        m.feed.urlTemplate = "http://api.example-sports.com/v1/events/{id}";
        _rejects(m, IMarketRegistry.BadFeed.selector, 1);
    }

    function test_rule3_code2_host() public {
        MarketInput memory m = _market();
        m.feed.urlTemplate = "https://api.example-sports.com:443/v1/events/{id}";
        _rejects(m, IMarketRegistry.BadFeed.selector, 2);
    }

    function test_rule3_code3_id() public {
        MarketInput memory m = _market();
        m.feed.urlTemplate = "https://api.example-sports.com/{id}/{id}";
        _rejects(m, IMarketRegistry.BadFeed.selector, 3);
    }

    function test_rule3_code4_urlParam() public {
        MarketInput memory m = _market();
        m.feed.urlParam = "a/b";
        _rejects(m, IMarketRegistry.BadFeed.selector, 4);
    }

    function test_rule3_code5_l1HostNotFirst() public {
        MarketInput memory m = _market();
        (m.allowList[0], m.allowList[1]) = (OTHER, HOST);
        _rejects(m, IMarketRegistry.BadFeed.selector, 5);
    }

    function test_rule3_code5_feedWithEmptyAllowList() public {
        MarketInput memory m = _market();
        m.allowList = new string[](0);
        _rejects(m, IMarketRegistry.BadFeed.selector, 5);
    }

    function test_rule3_code6_path() public {
        MarketInput memory m = _market();
        m.feed.valuePath = "event..home";
        _rejects(m, IMarketRegistry.BadFeed.selector, 6);
    }

    function test_rule3_code7_finalValue() public {
        MarketInput memory m = _market();
        m.feed.finalValue = "";
        _rejects(m, IMarketRegistry.BadFeed.selector, 7);
    }

    function test_rule3_code8_opForType() public {
        MarketInput memory m = _market();
        m.feed.valueType = 0; // STRING
        m.feed.target = "FINAL";
        m.feed.op = 2; // GT
        _rejects(m, IMarketRegistry.BadFeed.selector, 8);
    }

    function test_rule3_code9_decimals() public {
        MarketInput memory m = _market();
        m.feed.decimals = 2; // INT
        _rejects(m, IMarketRegistry.BadFeed.selector, 9);
    }

    function test_rule3_code10_target() public {
        MarketInput memory m = _market();
        m.feed.target = "02";
        _rejects(m, IMarketRegistry.BadFeed.selector, 10);
    }

    function test_rule3_code11_timing() public {
        MarketInput memory m = _market();
        m.feed.bufferSecs = 59; // globals bufferMinSecs 60
        _rejects(m, IMarketRegistry.BadFeed.selector, 11);
        m.feed.bufferSecs = 300; // == l1TimeoutSecs
        _rejects(m, IMarketRegistry.BadFeed.selector, 11);
        m.feed.bufferSecs = 60;
        m.feed.l1TimeoutSecs = 3_601; // globals l1TimeoutMaxSecs 3,600
        m.voidSecs = 604_800;
        _rejects(m, IMarketRegistry.BadFeed.selector, 11);
    }

    function test_rule3_code12_authRef() public {
        MarketInput memory m = _market();
        m.feed.authRef = keccak256("SPORTSDATA_V1");
        _rejects(m, IMarketRegistry.BadFeed.selector, 12);
        vm.prank(gov);
        reg.setAuthRef(keccak256("SPORTSDATA_V1"), true);
        _ok(m);
    }

    function test_rule3_code13_specWithoutFeed() public {
        MarketInput memory m = _noFeed();
        m.feed.l1TimeoutSecs = type(uint32).max; // T_L1 is not part of the void bound without a feed
        _rejects(m, IMarketRegistry.BadFeed.selector, 13);
    }

    // ------------------------------------------------------------------ rule 4: allow-list (BadAllowList)

    function test_rule4_code1_empty() public {
        MarketInput memory m = _noFeed();
        m.allowList = new string[](0);
        _rejects(m, IMarketRegistry.BadAllowList.selector, 1);
    }

    function test_rule4_code2_badHost() public {
        MarketInput memory m = _market();
        m.allowList[1] = "Stats.example-data.org";
        _rejects(m, IMarketRegistry.BadAllowList.selector, 2);
    }

    function test_rule4_code3_providerNotAllowed() public {
        MarketInput memory m = _market();
        m.allowList[1] = "news.example.net";
        _rejects(m, IMarketRegistry.BadAllowList.selector, 3);
        vm.prank(gov);
        reg.setProvider(OTHER, false);
        m.allowList[1] = OTHER;
        _rejects(m, IMarketRegistry.BadAllowList.selector, 3);
    }

    function test_rule4_codeOrder() public {
        MarketInput memory m = _noFeed();
        m.allowList[0] = "news.example.net"; // valid host, not a provider: code 3
        m.allowList[1] = "bad_host.example"; // invalid host: code 2
        _rejects(m, IMarketRegistry.BadAllowList.selector, 2);
    }

    // ------------------------------------------------------------------ rule 5: AIConfig (BadAIConfig)

    function test_rule5_code1_modelHashes() public {
        MarketInput memory m = _market();
        m.ai.modelIdHashes[2] = 0;
        _rejects(m, IMarketRegistry.BadAIConfig.selector, 1);
        m.ai.modelIdHashes[2] = m.ai.modelIdHashes[0];
        _rejects(m, IMarketRegistry.BadAIConfig.selector, 1);
        m.ai.modelIdHashes[2] = keccak256("c:m3@1");
        m.ai.modelIdHashes[1] = m.ai.modelIdHashes[2];
        _rejects(m, IMarketRegistry.BadAIConfig.selector, 1);
    }

    function test_rule5_code2_prompt() public {
        MarketInput memory m = _market();
        m.ai.promptHash = 0;
        _rejects(m, IMarketRegistry.BadAIConfig.selector, 2);
    }

    function test_rule5_code3_calibrator() public {
        MarketInput memory m = _market();
        m.ai.calibratorHash = 0;
        _rejects(m, IMarketRegistry.BadAIConfig.selector, 3);
    }

    function test_rule5_code4_category() public {
        MarketInput memory m = _market();
        m.ai.categoryId = 0;
        _rejects(m, IMarketRegistry.BadAIConfig.selector, 4);
    }

    function test_rule5_code5_highConf() public {
        MarketInput memory m = _market();
        m.ai.highConfBps = 5_000;
        _ok(m);
        m.ai.highConfBps = 10_000;
        _ok(m);
        m.ai.highConfBps = 4_999;
        _rejects(m, IMarketRegistry.BadAIConfig.selector, 5);
        m.ai.highConfBps = 10_001;
        _rejects(m, IMarketRegistry.BadAIConfig.selector, 5);
    }

    // ------------------------------------------------------------------ rule 6: UMAConfig (BadUMAConfig)

    function test_rule6_code1_currency() public {
        MarketInput memory m = _market();
        m.uma.bondCurrency = makeAddr("other token");
        _rejects(m, IMarketRegistry.BadUMAConfig.selector, 1);
    }

    function test_rule6_code2_minBondBelowVenue() public {
        MarketInput memory m = _market();
        m.uma.minBond = 2e6 - 1;
        _rejects(m, IMarketRegistry.BadUMAConfig.selector, 2);
    }

    function test_rule6_code2_venueOfTheActiveTrustSet() public {
        MockAssertionVenue dearer = new MockAssertionVenue(usdc, 3e6);
        _activateVenue(2, address(dearer));
        MarketInput memory m = _market();
        _rejects(m, IMarketRegistry.BadUMAConfig.selector, 2);
        m.uma.minBond = 3e6;
        assertEq(reg.validate(m), 3e6);
        venue.setMinimumBond(5e6); // the inactive set's venue no longer matters
        _ok(m);
    }

    function test_rule6_code3_bondBps() public {
        MarketInput memory m = _market();
        m.uma.bondBps = 1_111;
        _rejects(m, IMarketRegistry.BadUMAConfig.selector, 3);
    }

    function test_rule6_code4_liveness() public {
        MarketInput memory m = _market();
        m.uma.livenessL1 = 60;
        m.uma.livenessAuto = 60;
        m.uma.livenessReviewed = 60; // every liveness at T_min, reviewed == max(L1, auto)
        _ok(m);
        MarketInput memory b = _market();
        b.uma.livenessL1 = 59;
        _rejects(b, IMarketRegistry.BadUMAConfig.selector, 4);
        b = _market();
        b.uma.livenessAuto = 59;
        _rejects(b, IMarketRegistry.BadUMAConfig.selector, 4);
        b = _market();
        b.uma.livenessAuto = 60;
        b.uma.livenessReviewed = 119; // below livenessL1 120, above livenessAuto
        _rejects(b, IMarketRegistry.BadUMAConfig.selector, 4);
        b = _market();
        b.uma.livenessAuto = 301; // above livenessReviewed 300
        _rejects(b, IMarketRegistry.BadUMAConfig.selector, 4);
    }

    function test_rule6_code5_templateTokens() public {
        MarketInput memory m = _market();
        m.claimTemplate = "{{MARKET_ID}} {{QUESTION}}";
        _rejects(m, IMarketRegistry.BadUMAConfig.selector, 5);
    }

    /// Bound per §6.3 rule 6: template bytes minus token bytes, plus question and rules, plus
    /// 66 + 20 + 42 + 20 + 20 + 7 + 66 = 241 for the fixed tokens, plus max(256, L1 evidence text).
    function test_rule6_code6_claimTooLong() public {
        MarketInput memory m = _market();
        uint256 fixedPart = _templateLiteralBytes() + bytes(m.rules).length + 241 + 256;
        m.question = string(_filled(16_384 - fixedPart));
        _ok(m);
        m.question = string(_filled(16_384 - fixedPart + 1));
        _rejects(m, IMarketRegistry.BadUMAConfig.selector, 6);
    }

    /// A long substituted URL makes the L1 evidence text exceed 256 bytes: 26 + 66 + 9 + URL.
    function test_rule6_code6_longL1UrlCounts() public {
        MarketInput memory m = _market();
        m.feed.urlParam = string(_filled(128));
        uint256 urlLen = bytes("https://api.example-sports.com/v1/events/").length + 128;
        uint256 fixedPart = _templateLiteralBytes() + bytes(m.rules).length + 241 + (26 + 66 + 9 + urlLen);
        m.question = string(_filled(16_384 - fixedPart));
        _ok(m);
        m.question = string(_filled(16_384 - fixedPart + 1));
        _rejects(m, IMarketRegistry.BadUMAConfig.selector, 6);
    }

    // ------------------------------------------------------------------ rule order

    function test_rulesRunInOrder() public {
        MarketInput memory m = _market();
        m.uma.bondBps = 0; // rule 6
        m.ai.promptHash = 0; // rule 5
        m.windowStart = m.windowEnd; // rule 2
        _rejects(m, IMarketRegistry.BadTimes.selector, 2);
    }

    // ------------------------------------------------------------------ helpers

    /// Default template length without its ten tokens (each token counted from its literal text).
    function _templateLiteralBytes() internal pure returns (uint256) {
        uint256 tokens =
            bytes(
            "{{MARKET_ID}}{{CHAIN_ID}}{{ORACLE}}{{QUESTION}}{{RULES}}{{TAU_UTC}}{{TAU_UNIX}}{{OUTCOME}}{{EVIDENCE}}{{EVIDENCE_HASH}}"
        )
        .length;
        return bytes(_template()).length - tokens;
    }

    function _filled(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = "q";
        }
    }
}
