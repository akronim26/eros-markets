// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {SpotMarketFactory} from "../../src/native/SpotMarketFactory.sol";

/// @title DeploySpotMarketFactory (NM-S01)
/// @notice Deploys the `SpotMarketFactory` for the deployed MarketRegistry. Any funded key may run it;
///         it has no owner. Governance then points the registry at it (`SpotMarketGovernance`).
///
///   forge script script/native/DeploySpotMarketFactory.s.sol --rpc-url $RPC --broadcast --private-key $KEY
contract DeploySpotMarketFactory is Script {
    using stdJson for string;

    string internal constant OUT = "deployments/native/spot-market-factory.json";

    function run() external returns (SpotMarketFactory factory) {
        string memory d = vm.readFile(vm.envOr("DEPLOYMENTS", string("deployments/monad-testnet.json")));
        address registry = d.readAddress(".contracts.MarketRegistry.address");
        bool broadcasting = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        require(!broadcasting || !vm.exists(OUT), "SPOT_FACTORY_EXISTS");
        vm.startBroadcast();
        factory = new SpotMarketFactory(registry);
        vm.stopBroadcast();
        string memory k = "spotFactory";
        k.serialize("chainId", block.chainid);
        k.serialize("registry", registry);
        string memory json = k.serialize("spotMarketFactory", address(factory));
        vm.writeJson(json, broadcasting ? OUT : string.concat(OUT, ".dryrun.json"));
        console2.log("spotMarketFactory", address(factory));
    }
}
