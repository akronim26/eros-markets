// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Globals, MarketInput, FeedSpec, TrustSet} from "../../src/types/OracleTypes.sol";
import {MockOracleView} from "../mocks/MockOracleView.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";

/// @notice Shared listing fixture for the registry tests (tasks O11.3, O11.4): the plan's testnet demo
///         inputs (§14.1, §12.11 globals version 1), the §6.4 default claim template and a fully valid
///         Layer 1 market whose §14.2 void bound is the C.7 testnet figure, 6,000 s.
abstract contract RegistryFixture is Test {
    uint64 internal constant NOW = 1_800_000_000;
    string internal constant HOST = "api.example-sports.com";
    string internal constant OTHER = "stats.example-data.org";

    address internal usdc = makeAddr("usdc");
    address internal gov = makeAddr("timelock");

    MockOracleView internal oracle;
    MockAssertionVenue internal venue;

    // ------------------------------------------------------------------ fixtures

    function _globals() internal pure returns (Globals memory g) {
        g.minHorizonSecs = 600;
        g.maxListingHorizon = 2_588_400;
        g.maxVoidSecs = 604_800;
        g.l2MinSecs = 60;
        g.l2MaxSecs = 3_600;
        g.bufferMinSecs = 60;
        g.bufferMaxSecs = 600;
        g.l1TimeoutMinSecs = 120;
        g.l1TimeoutMaxSecs = 3_600;
        g.tMinSecs = 60;
        g.bondBpsFloor = 1_112;
        g.highConfFloorBps = 5_000;
        g.maxClaimBytes = 16_384;
        g.dvmRoundSecs = 300;
        g.dvmMaxRolls = 0;
        g.reviewTargetSecs = 600;
        g.voidSlackSecs = 600;
        g.retryWindowSecs = 300;
        g.earlyTtlSecs = 600;
        g.minRequestIntervalSecs = 60;
        g.heartbeatMaxAgeSecs = 900;
        g.deltaPmaxBps = 200;
        g.nMin = 150;
        g.reviewLimitAtoms = 1_668_000_000;
    }

    function _feed() internal pure returns (FeedSpec memory f) {
        f.urlTemplate = "https://api.example-sports.com/v1/events/{id}";
        f.urlParam = "evt_1";
        f.finalPath = "event.status";
        f.finalValue = "FINAL";
        f.valuePath = "event.home";
        f.valueType = 1; // INT
        f.op = 2; // GT
        f.target = "2";
        f.bufferSecs = 60;
        f.l1TimeoutSecs = 300;
    }

    /// Plan §6.4 default template, byte for byte.
    function _template() internal pure returns (string memory) {
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

    /// A fully valid Layer 1 market, T 30 minutes ahead, voidSecs 2 h (plan §14.1/§14.2 stub-engine demo).
    function _market() internal view returns (MarketInput memory m) {
        m.marketId = keccak256("market-1");
        m.question = "Will the home team score more than 2 goals?";
        m.rules = "YES if the final home score is above 2; NO otherwise. INVALID if the match is not played.";
        m.claimTemplate = _template();
        m.tau = NOW + 1_800;
        m.windowStart = NOW;
        m.windowEnd = NOW + 1_800;
        m.hasFeed = true;
        m.feed = _feed();
        m.allowList = new string[](2);
        m.allowList[0] = HOST;
        m.allowList[1] = OTHER;
        m.ai.modelIdHashes = [keccak256("a:m1@1"), keccak256("b:m2@1"), keccak256("c:m3@1")];
        m.ai.promptHash = keccak256("prompt");
        m.ai.calibratorHash = keccak256("calibrator");
        m.ai.categoryId = keccak256("sports");
        m.ai.highConfBps = 9_100;
        m.uma.bondCurrency = usdc;
        m.uma.minBond = 2e6;
        m.uma.bondBps = 1_112;
        m.uma.livenessL1 = 120;
        m.uma.livenessAuto = 120;
        m.uma.livenessReviewed = 300;
        m.l2DeadlineSecs = 600;
        m.voidSecs = 7_200;
        m.monitor = address(0x30);
        m.oiCapLots = 100_000;
    }

    /// The same market without a Layer 1 feed (all-zero FeedSpec).
    function _noFeed() internal view returns (MarketInput memory m) {
        m = _market();
        m.hasFeed = false;
        FeedSpec memory z;
        m.feed = z;
    }

    function _activateVenue(uint32 id, address v) internal {
        TrustSet memory t;
        t.cfg.venue = v;
        oracle.setTrustSet(id, t, true);
    }
}
