// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {GovernanceOp} from "../GovernanceOp.sol";
import {Globals} from "../../src/types/OracleTypes.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";

/// @title SpotMarketGovernance (NM-S03)
/// @notice The Timelock operations around a native spot listing, printed for the proposer (nothing is
///         broadcast; every call is simulated as the Timelock first).
///
///   OP=enable  (before listing) only what the registry is missing:
///     - `setProvider(host, true)` for each evidence host of the listing (the Layer-1 host first);
///     - `setAuthRef(feed.authRef, true)` for the API-Sports credential reference (the key itself
///       stays in the CRE/listener environment);
///     - `setGlobals` raising only `bufferMaxSecs` / `l1TimeoutMaxSecs` to the canonical sports feed
///       timing (a game is not final within the default 1 h L1 window); every other value is copied;
///     - `setFactory(SPOT_FACTORY)`.
///   OP=restore (after listing): `setFactory` back to the perp `MarketFactory` of the deployment.
///
///   OP=enable SPOT_FACTORY=0x.. SPOT_LISTING=listings/native/<m>/listing.json \
///   forge script script/native/SpotMarketGovernance.s.sol --rpc-url $RPC
contract SpotMarketGovernance is GovernanceOp {
    using stdJson for string;

    function run() external returns (bytes32 id) {
        string memory d = _deployments();
        address timelock = d.readAddress(".roles.timelock");
        MarketRegistry reg = MarketRegistry(_contract(d, "MarketRegistry"));
        string memory op = vm.envString("OP");
        if (keccak256(bytes(op)) == keccak256("restore")) {
            address perpFactory = _contract(d, "MarketFactory");
            Call[] memory restore = new Call[](1);
            _push(restore, 0, address(reg), abi.encodeCall(reg.setFactory, (perpFactory)));
            return _propose("native spot: restore perp factory", restore, timelock);
        }
        require(keccak256(bytes(op)) == keccak256("enable"), "OP_MUST_BE_enable_OR_restore");

        string memory listing = vm.readFile(vm.envString("SPOT_LISTING"));
        string memory feed = vm.readFile(listing.readString(".feed"));
        string[] memory hosts = listing.readStringArray(".evidenceHosts");
        require(keccak256(bytes(hosts[0])) == keccak256(bytes(feed.readString(".provider"))), "L1_HOST_NOT_FIRST");
        address spotFactory = vm.envAddress("SPOT_FACTORY");
        require(spotFactory.code.length != 0, "SPOT_FACTORY_NOT_DEPLOYED");

        Call[] memory calls = new Call[](hosts.length + 3);
        uint256 n;
        for (uint256 i; i < hosts.length; ++i) {
            if (!reg.providerAllowed(hosts[i])) {
                n = _push(calls, n, address(reg), abi.encodeCall(reg.setProvider, (hosts[i], true)));
            }
        }
        bytes32 authRef = feed.readBytes32(".feed.authRef");
        if (!reg.authRefKnown(authRef)) {
            n = _push(calls, n, address(reg), abi.encodeCall(reg.setAuthRef, (authRef, true)));
        }
        Globals memory g = reg.globals();
        uint32 buffer = uint32(feed.readUint(".feed.bufferSecs"));
        uint32 timeout = uint32(feed.readUint(".feed.l1TimeoutSecs"));
        if (g.bufferMaxSecs < buffer || g.l1TimeoutMaxSecs < timeout) {
            if (g.bufferMaxSecs < buffer) g.bufferMaxSecs = buffer;
            if (g.l1TimeoutMaxSecs < timeout) g.l1TimeoutMaxSecs = timeout;
            n = _push(calls, n, address(reg), abi.encodeCall(reg.setGlobals, (g)));
        }
        if (reg.factory() != spotFactory) {
            n = _push(calls, n, address(reg), abi.encodeCall(reg.setFactory, (spotFactory)));
        }
        require(n != 0, "NOTHING_TO_DO");
        id = _propose("native spot: enable listing", _trim(calls, n), timelock);
    }
}
