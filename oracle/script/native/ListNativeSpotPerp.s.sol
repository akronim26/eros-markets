// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {NativeOutcomeVault} from "@eros/native/NativeOutcomeVault.sol";
import {MarketCore, MarketInput} from "../../src/types/OracleTypes.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {ListNativeSpotMarket} from "./ListNativeSpotMarket.s.sol";

/// @title ListNativeSpotPerp
/// @notice Lists an Eros perp whose INDEX is the YES book of an already-listed native spot market.
///         The perp has its own market id and rules, carries the spot market's API-Sports Layer-1 feed
///         (so it resolves on the same event through the same lifecycle), and pins the native INDEX
///         source built by `native-rules.js ... <perpMarketId>`. The spot vault stays bound to its
///         spot anchor; nothing here touches it. Needs the registry factory to be the perp
///         `MarketFactory` (the state `SpotMarketGovernance OP=restore` leaves). Lister only.
///         Oracle and engine configuration without a perp-specific value is copied from
///         `templateMarketId`; the depth rule is the listing's own. Funding off. Leverage ceiling and
///         forced-book liquidation come from the listing's optional `deploymentCapX` (default 1) and
///         `maxLiqLotsPerBlock` (default 0, liquidation off); a ceiling above 1 needs liquidation on
///         and a calibrated profile staged at activation (ActivateNativeMarket PROFILE=...).
///
///   NATIVE_DEPLOYMENT=deployments/native/<spot>.json PERP_LISTING=listings/native/<m>/listing.json \
///   forge script script/native/ListNativeSpotPerp.s.sol --rpc-url $RPC --broadcast --private-key $LISTER_KEY
contract ListNativeSpotPerp is Script {
    using stdJson for string;

    function run() external returns (address engine) {
        string memory d = vm.readFile(vm.envString("NATIVE_DEPLOYMENT"));
        string memory p = vm.readFile(vm.envString("PERP_LISTING"));
        MarketRegistry reg = MarketRegistry(d.readAddress(".registry"));
        bytes32 spotId = d.readBytes32(".marketId");
        NativeOutcomeVault vault = NativeOutcomeVault(d.readAddress(".outcomeVault"));
        require(vault.marketId() == spotId && vault.engine() == reg.getMarketCore(spotId).engine, "SPOT_NOT_LISTED");
        require(p.readBytes32(".marketId") != spotId, "PERP_NEEDS_OWN_MARKET_ID");

        MarketInput memory m = _marketInput(reg, d, p);
        IMarketConfig.Listing memory l = _listing(reg, d, p);

        vm.startBroadcast();
        engine = reg.createMarket(m, l, "");
        vm.stopBroadcast();
        require(reg.getMarketCore(m.marketId).engine == engine, "LIST_FAILED");
        console2.log("perp engine", engine);
    }

    function _marketInput(MarketRegistry reg, string memory d, string memory p)
        internal
        returns (MarketInput memory m)
    {
        bytes32 tmpl = p.readBytes32(".templateMarketId");
        MarketCore memory core = reg.getMarketCore(tmpl);
        require(core.engine != address(0), "TEMPLATE_NOT_LISTED");
        ListNativeSpotMarket spot = new ListNativeSpotMarket(); // FeedSpec reader only; not broadcast
        string memory f = vm.readFile(p.readString(".feed"));
        m.marketId = p.readBytes32(".marketId");
        m.question = p.readString(".question");
        m.rules = p.readString(".rules");
        m.claimTemplate = vm.readFile("listings/example/pack.json").readString(".marketInput.claimTemplate");
        m.windowStart = uint64(block.timestamp);
        m.tau = uint64(d.readUint(".scheduledT"));
        m.windowEnd = m.tau;
        m.hasFeed = true;
        m.feed = spot.readFeed(f);
        require(keccak256(abi.encode(m.feed)) == f.readBytes32(".specHash"), "FEED_SPEC_HASH_MISMATCH");
        m.allowList = p.readStringArray(".evidenceHosts");
        m.ai = reg.getAIConfig(tmpl);
        m.uma = reg.getUMAConfig(tmpl);
        m.l2DeadlineSecs = core.l2DeadlineSecs;
        m.voidSecs = uint32(p.readUint(".voidSecs"));
        m.monitor = core.monitor;
        m.oiCapLots = p.readUint(".oiCapLots");
        m.dryRunHash = keccak256(bytes(string.concat("native-spot-perp-listing:", m.rules)));
        m.ambiguityLogHash = keccak256(
            "Eros perp on a native spot market's YES book: API-Sports Layer-1 feed; review route fallback; INVALID settles 0.5."
        );
    }

    function _listing(MarketRegistry reg, string memory d, string memory p)
        internal
        view
        returns (IMarketConfig.Listing memory l)
    {
        IMarketConfig.Listing memory t =
            IMarketConfig(reg.getMarketCore(p.readBytes32(".templateMarketId")).engine).listing();
        l.token = d.readAddress(".collateral");
        l.governance = t.governance;
        l.template = t.template;
        l.deploymentCapX = p.keyExists(".deploymentCapX") ? p.readUint(".deploymentCapX") : 1;
        l.maxTraders = 1024;
        l.indexSourceId = p.readBytes32(".indexSourceId");
        l.indexSigner = p.readAddress(".indexSigner");
        l.indexRulesHash = p.readBytes32(".indexRulesHash");
        l.depthNLots = p.readUint(".depthNLots");
        l.maxSpreadWad = p.readUint(".maxSpreadWad");
        l.bootstrapBandWad = t.bootstrapBandWad;
        l.minOrderLots = 1;
        l.maxOrderLots = t.maxOrderLots;
        l.maxLiqLotsPerBlock = p.keyExists(".maxLiqLotsPerBlock") ? uint64(p.readUint(".maxLiqLotsPerBlock")) : 0;
        require(l.deploymentCapX == 1 || l.maxLiqLotsPerBlock > 0, "LEVERAGE_NEEDS_LIQUIDATION");
        l.fundingEnabled = false;
    }
}
