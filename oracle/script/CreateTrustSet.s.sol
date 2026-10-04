// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {GovernanceOp} from "./GovernanceOp.sol";
import {Globals, TrustSetInput} from "../src/types/OracleTypes.sol";
import {ResolutionOracle} from "../src/ResolutionOracle.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";

/// @title CreateTrustSet
/// @notice The post-deploy governance of plan §12.5 as two Timelock operations for the Safe (task O19.4):
///         1. the trust set: on testnet the sim bridge (`setSimForwarder(MockKeystoneForwarder)`,
///            `setSimRelayer(relayer, true)` for each relayer), then `createTrustSet` and `activateTrustSet` of
///            the id it will get;
///         2. the registry: `setGlobals` (globals version 1 from the params, the §12.11 testnet column),
///            `setProvider(host, true)` for each provider and `setAuthRef(keccak256(ref), true)` for each ref.
///         Both are simulated as the Timelock (the second after the first) and printed; nothing is broadcast.
/// @dev Trust-set fields from `params.trustSet` and `params.cre`; `PRODUCTION=true` builds a production set
///      (KeystoneForwarder, the workflow IDs and org owner) instead of the sim set. The environment overrides
///      the X03 addresses for dry runs: ATTESTOR, WATCHDOG, COMMITTEE and SIM_RELAYERS (comma-separated). The
///      committee is sorted ascending, as the oracle requires.
contract CreateTrustSet is GovernanceOp {
    using stdJson for string;

    function run() external returns (bytes32 trustSetOp, bytes32 registryOp) {
        string memory deployments = _deployments();
        string memory params = _params();
        address timelock = deployments.readAddress(".roles.timelock");
        ResolutionOracle ro = ResolutionOracle(_contract(deployments, "ResolutionOracle"));
        MarketRegistry reg = MarketRegistry(_contract(deployments, "MarketRegistry"));
        address venue = _contract(deployments, "UmaAdapter");

        trustSetOp = _propose("trust set", _trustSetCalls(ro, params, venue), timelock);
        registryOp = _propose("registry setup", _registryCalls(reg, params), timelock);
    }

    function _trustSetCalls(ResolutionOracle ro, string memory params, address venue)
        internal
        view
        returns (Call[] memory)
    {
        bool production = vm.envOr("PRODUCTION", false);
        address[] memory relayers = _addresses(params, "SIM_RELAYERS", ".cre.simRelayers");
        Call[] memory calls = new Call[](relayers.length + 3);
        uint256 n;
        if (!production) {
            address mockForwarder = params.readAddress(".cre.mockForwarder");
            n = _push(calls, n, address(ro), abi.encodeCall(ro.setSimForwarder, (mockForwarder)));
            for (uint256 i; i < relayers.length; ++i) {
                n = _push(calls, n, address(ro), abi.encodeCall(ro.setSimRelayer, (relayers[i], true)));
            }
        }
        TrustSetInput memory t = _trustSet(params, venue, production);
        n = _push(calls, n, address(ro), abi.encodeCall(ro.createTrustSet, (t)));
        n = _push(calls, n, address(ro), abi.encodeCall(ro.activateTrustSet, (ro.trustSetCount() + 1)));
        return _trim(calls, n);
    }

    function _trustSet(string memory params, address venue, bool production)
        internal
        view
        returns (TrustSetInput memory t)
    {
        t.production = production;
        t.runnerAttestor = _role(params, "ATTESTOR", ".trustSet.runnerAttestor");
        t.watchdog = _role(params, "WATCHDOG", ".trustSet.watchdog");
        t.committee = _sorted(_addresses(params, "COMMITTEE", ".trustSet.committee"));
        t.threshold = uint8(params.readUint(".trustSet.threshold"));
        t.venue = venue;
        if (production) {
            t.forwarder = params.readAddress(".cre.keystoneForwarder");
            t.workflowOwner = _role(params, "ORG_OWNER", ".cre.orgOwner");
            t.workflowName = bytes10(bytes(params.readString(".cre.workflowName")));
            bytes32[] memory ids = vm.envOr("WORKFLOW_IDS", ",", new bytes32[](0));
            if (ids.length == 0) {
                try vm.parseJsonBytes32Array(params, ".cre.workflowIds") returns (bytes32[] memory fromFile) {
                    ids = fromFile;
                } catch {}
            }
            if (ids.length > 0) t.workflowIds[0] = ids[0];
            if (ids.length > 1) t.workflowIds[1] = ids[1];
        } else {
            t.forwarder = params.readAddress(".cre.mockForwarder");
        }
    }

    function _registryCalls(MarketRegistry reg, string memory params) internal view returns (Call[] memory) {
        string[] memory providers = _strings(params, ".providers");
        string[] memory refs = _strings(params, ".authRefs");
        Call[] memory calls = new Call[](1 + providers.length + refs.length);
        uint256 n = _push(calls, 0, address(reg), abi.encodeCall(reg.setGlobals, (_globals(params))));
        for (uint256 i; i < providers.length; ++i) {
            n = _push(calls, n, address(reg), abi.encodeCall(reg.setProvider, (providers[i], true)));
        }
        for (uint256 i; i < refs.length; ++i) {
            n = _push(calls, n, address(reg), abi.encodeCall(reg.setAuthRef, (keccak256(bytes(refs[i])), true)));
        }
        return _trim(calls, n);
    }

    /// Globals version 1 from `params.globals` (every field of the struct, by name).
    function _globals(string memory p) internal pure returns (Globals memory g) {
        g.minHorizonSecs = uint32(p.readUint(".globals.minHorizonSecs"));
        g.maxListingHorizon = uint32(p.readUint(".globals.maxListingHorizon"));
        g.maxVoidSecs = uint32(p.readUint(".globals.maxVoidSecs"));
        g.l2MinSecs = uint32(p.readUint(".globals.l2MinSecs"));
        g.l2MaxSecs = uint32(p.readUint(".globals.l2MaxSecs"));
        g.bufferMinSecs = uint32(p.readUint(".globals.bufferMinSecs"));
        g.bufferMaxSecs = uint32(p.readUint(".globals.bufferMaxSecs"));
        g.l1TimeoutMinSecs = uint32(p.readUint(".globals.l1TimeoutMinSecs"));
        g.l1TimeoutMaxSecs = uint32(p.readUint(".globals.l1TimeoutMaxSecs"));
        g.tMinSecs = uint32(p.readUint(".globals.tMinSecs"));
        g.bondBpsFloor = uint16(p.readUint(".globals.bondBpsFloor"));
        g.highConfFloorBps = uint16(p.readUint(".globals.highConfFloorBps"));
        g.maxClaimBytes = uint32(p.readUint(".globals.maxClaimBytes"));
        g.dvmRoundSecs = uint32(p.readUint(".globals.dvmRoundSecs"));
        g.dvmMaxRolls = uint8(p.readUint(".globals.dvmMaxRolls"));
        g.reviewTargetSecs = uint32(p.readUint(".globals.reviewTargetSecs"));
        g.voidSlackSecs = uint32(p.readUint(".globals.voidSlackSecs"));
        g.retryWindowSecs = uint32(p.readUint(".globals.retryWindowSecs"));
        g.earlyTtlSecs = uint32(p.readUint(".globals.earlyTtlSecs"));
        g.minRequestIntervalSecs = uint32(p.readUint(".globals.minRequestIntervalSecs"));
        g.heartbeatMaxAgeSecs = uint32(p.readUint(".globals.heartbeatMaxAgeSecs"));
        g.deltaPmaxBps = uint16(p.readUint(".globals.deltaPmaxBps"));
        g.nMin = uint32(p.readUint(".globals.nMin"));
        g.reviewLimitAtoms = p.readUint(".globals.reviewLimitAtoms");
        g.proposerRewardAtoms = p.readUint(".globals.proposerRewardAtoms");
    }

    function _sorted(address[] memory a) internal pure returns (address[] memory) {
        for (uint256 i = 1; i < a.length; ++i) {
            for (uint256 j = i; j > 0 && a[j] < a[j - 1]; --j) {
                (a[j], a[j - 1]) = (a[j - 1], a[j]);
            }
        }
        return a;
    }
}
