// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {NativeOutcomeVault} from "@eros/native/NativeOutcomeVault.sol";
import {AIConfig, FeedSpec, MarketCore, MarketInput, UMAConfig} from "../../src/types/OracleTypes.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";

/// @title ListNativeMarket (NM-D04 / NM-D05)
/// @notice Step 2 of the native listing: list the native event through the existing MarketRegistry
///         (lister only) with the native INDEX source pinned, then call the vault's permissionless
///         `bindMarket()`. Oracle-side configuration (AI panel, UMA bond/liveness, evidence allow-list,
///         monitor, engine governance) is copied from an already-listed market on the same registry
///         (`templateMarketId`), so no new trust or calibration values are invented. No Layer-1 feed:
///         resolution uses the existing review/committee route. 1x, funding off, forced-book
///         liquidation off (maxLiqLotsPerBlock = 0).
///
///   NATIVE_DEPLOYMENT=<DeployNativeMarket output> NATIVE_LISTING=<listing.json> \
///   forge script script/native/ListNativeMarket.s.sol --rpc-url $RPC --broadcast --sender $LISTER ...
///
/// listing.json: question, rules (exact text; keccak256 must equal the deployment's erosRulesHash),
/// templateMarketId, oiCapLots, indexSourceId, indexSigner, indexRulesHash, depthNLots, maxSpreadWad.
contract ListNativeMarket is Script {
    using stdJson for string;

    function run() external returns (address engine) {
        string memory d = vm.readFile(vm.envString("NATIVE_DEPLOYMENT"));
        string memory p = vm.readFile(vm.envString("NATIVE_LISTING"));
        MarketRegistry reg = MarketRegistry(d.readAddress(".registry"));
        NativeOutcomeVault vault = NativeOutcomeVault(d.readAddress(".outcomeVault"));
        string memory rules = p.readString(".rules");
        require(keccak256(bytes(rules)) == d.readBytes32(".erosRulesHash"), "RULES_TEXT_HASH_MISMATCH");
        require(vault.rulesHash() == d.readBytes32(".erosRulesHash") && vault.marketId() == d.readBytes32(".marketId"),
            "VAULT_DEPLOYMENT_MISMATCH");

        MarketInput memory m = _marketInput(reg, d, p, rules);
        IMarketConfig.Listing memory l = _listing(reg, d, p);

        vm.startBroadcast();
        engine = reg.createMarket(m, l, "");
        vault.bindMarket();
        vm.stopBroadcast();
        require(vault.engine() == engine, "BIND_FAILED");
        console2.log("engine", engine);
        console2.log("vault bound", address(vault));
    }

    function _marketInput(MarketRegistry reg, string memory d, string memory p, string memory rules)
        internal
        view
        returns (MarketInput memory m)
    {
        bytes32 tmpl = p.readBytes32(".templateMarketId");
        MarketCore memory core = reg.getMarketCore(tmpl);
        require(core.engine != address(0), "TEMPLATE_NOT_LISTED");
        m.marketId = d.readBytes32(".marketId");
        m.question = p.readString(".question");
        m.rules = rules;
        m.claimTemplate = vm.readFile("listings/example/pack.json").readString(".marketInput.claimTemplate");
        m.windowStart = uint64(block.timestamp);
        m.tau = uint64(d.readUint(".scheduledT"));
        m.windowEnd = m.tau;
        m.hasFeed = false; // all-zero FeedSpec
        m.allowList = reg.getAllowList(tmpl);
        m.ai = reg.getAIConfig(tmpl);
        m.uma = reg.getUMAConfig(tmpl);
        m.l2DeadlineSecs = core.l2DeadlineSecs;
        m.voidSecs = 30 days;
        m.monitor = core.monitor;
        m.oiCapLots = p.readUint(".oiCapLots");
        m.dryRunHash = keccak256(bytes(string.concat("native-listing:", rules)));
        m.ambiguityLogHash = keccak256("Native Eros event: no Layer-1 feed; existing review/committee route; sandbox adjudication.");
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
        l.deploymentCapX = 1;
        l.maxTraders = 1024;
        l.indexSourceId = p.readBytes32(".indexSourceId");
        l.indexSigner = p.readAddress(".indexSigner");
        l.indexRulesHash = p.readBytes32(".indexRulesHash");
        l.depthNLots = p.readUint(".depthNLots");
        l.maxSpreadWad = p.readUint(".maxSpreadWad");
        l.bootstrapBandWad = t.bootstrapBandWad;
        l.minOrderLots = 1;
        l.maxOrderLots = t.maxOrderLots;
        l.maxLiqLotsPerBlock = 0;
        l.fundingEnabled = false;
    }
}
