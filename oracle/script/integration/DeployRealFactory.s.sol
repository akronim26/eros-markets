pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {EngineCodeStore} from "@eros/factory/EngineCodeStore.sol";
import {MarketFactory, IFactoryRegistry} from "@eros/factory/MarketFactory.sol";
import {RegistryBookRiskEngine} from "../../src/integration/RegistryBookRiskEngine.sol";

contract DeployRealFactory is Script {
    error TestnetOnly();
    error ArtifactNotApproved();

    function run(address registry, address collateralToken, address reserveTreasury, bytes32 approvedCreationHash)
        external
        returns (EngineCodeStore store, MarketFactory factory)
    {
        if (block.chainid != 10143) revert TestnetOnly();
        bytes memory creationCode = vm.getCode("RegistryBookRiskEngine.sol:RegistryBookRiskEngine");
        if (approvedCreationHash == bytes32(0) || keccak256(creationCode) != approvedCreationHash) {
            revert ArtifactNotApproved();
        }
        vm.startBroadcast();
        store = new EngineCodeStore(creationCode);
        factory = new MarketFactory(registry, collateralToken, reserveTreasury, address(store), approvedCreationHash);
        vm.stopBroadcast();
        console2.log("EngineCodeStore", address(store));
        console2.log("MarketFactory", address(factory));
        console2.log("CollateralVault", address(factory.collateralVault()));
        console2.log(
            "Registry governance must separately authorize setFactory", IFactoryRegistry(registry).governance()
        );
        console2.logBytes32(approvedCreationHash);
    }
}
