// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Timelock} from "solady/accounts/Timelock.sol";
import {BondTreasury} from "../src/BondTreasury.sol";
import {ResolutionOracle} from "../src/ResolutionOracle.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {KeeperRouter} from "../src/KeeperRouter.sol";
import {UmaAdapter} from "../src/venues/UmaAdapter.sol";
import {StubMarketFactory} from "../src/testnet/StubMarketFactory.sol";
import {IOptimisticOracleV3} from "../src/interfaces/IOptimisticOracleV3.sol";

/// @title DeployOracle
/// @notice The oracle stack (plan §12.5, task O19.3). Every link is a constructor immutable, so the script
///         precomputes each address from the deployer's nonce and deploys in this exact order, with no other
///         deployer transaction in between (the Timelock's `initialize` is one): Timelock (initialized in the
///         same script: delay, admin 0, proposer and canceller the team Safe, executor OPEN_ROLE_HOLDER),
///         BondTreasury, ResolutionOracle, UmaAdapter, MarketRegistry, KeeperRouter and, on testnet only,
///         StubMarketFactory. It asserts every address and every immutable link, that the deployer holds no
///         role, then writes `deployments/<network>.json` (§12.11). There are no wiring calls: trust sets,
///         globals, providers and treasury limits go through the Timelock (O19.4 scripts).
/// @dev Parameters from `deployments/params.<network>.json` (or `PARAMS`); the environment may override
///      TEAM_SAFE, GUARDIAN_SAFE, USDC and OOV3. A zero bond token or OOv3 is taken from the deployments file
///      DeployUmaSandbox wrote. On Monad mainnet (143) no stub is deployed, the registry gets factory 0 and the
///      Timelock delay must be at least 48 h. A simulation writes `deployments/dryrun/<network>.json`.
///      `deployBlock` is the chain head when the script ran: a lower bound of every contract's real deployment
///      block (each transaction may land in a later block), which is where an indexer starts scanning.
contract DeployOracle is Script {
    using stdJson for string;

    error ZeroAddress(string what);
    error DelayTooShort(uint256 delay);
    error Mismatch(string what);

    uint256 internal constant MONAD_MAINNET = 143;
    uint64 internal constant TESTNET_SELECTOR = 2183018362218727504;
    uint256 internal constant MAINNET_MIN_DELAY = 172_800;

    struct Params {
        address usdc;
        address oov3;
        address teamSafe;
        address guardianSafe;
        uint256 delay;
        uint64 selector;
    }

    struct Deployed {
        address deployer;
        Timelock timelock;
        BondTreasury treasury;
        ResolutionOracle oracle;
        UmaAdapter adapter;
        MarketRegistry registry;
        KeeperRouter router;
        StubMarketFactory stubFactory; // 0 on mainnet
        uint256 deployBlock;
    }

    function run() external returns (Deployed memory d) {
        string memory network = networkName();
        (Params memory p, string memory params) = _params(network);
        bool mainnet = block.chainid == MONAD_MAINNET;
        if (mainnet && p.delay < MAINNET_MIN_DELAY) revert DelayTooShort(p.delay);

        vm.startBroadcast();
        (, d.deployer,) = vm.readCallers();
        uint256 n = vm.getNonce(d.deployer);
        // n: Timelock, n + 1: its initialize call, then one nonce per contract.
        address treasuryAt = vm.computeCreateAddress(d.deployer, n + 2);
        address oracleAt = vm.computeCreateAddress(d.deployer, n + 3);
        address adapterAt = vm.computeCreateAddress(d.deployer, n + 4);
        address registryAt = vm.computeCreateAddress(d.deployer, n + 5);
        address routerAt = vm.computeCreateAddress(d.deployer, n + 6);
        address stubAt = mainnet ? address(0) : vm.computeCreateAddress(d.deployer, n + 7);
        d.deployBlock = block.number;

        // 1. Timelock, initialized in the same script
        d.timelock = new Timelock();
        if (address(d.timelock) != vm.computeCreateAddress(d.deployer, n)) revert Mismatch("Timelock address");
        _initialize(d.timelock, p);
        // 2-6. the stack, every link a precomputed address
        d.treasury = new BondTreasury(p.usdc, oracleAt, registryAt, address(d.timelock));
        d.oracle = new ResolutionOracle(registryAt, treasuryAt, p.usdc, p.selector, address(d.timelock), p.guardianSafe);
        d.adapter = new UmaAdapter(IOptimisticOracleV3(p.oov3), p.usdc, oracleAt, treasuryAt);
        d.registry = new MarketRegistry(oracleAt, treasuryAt, stubAt, p.usdc, address(d.timelock), p.teamSafe);
        d.router = new KeeperRouter(oracleAt);
        // 7. the testnet stand-in factory (never on mainnet)
        if (!mainnet) d.stubFactory = new StubMarketFactory(registryAt);
        vm.stopBroadcast();

        if (address(d.treasury) != treasuryAt) revert Mismatch("BondTreasury address");
        if (address(d.oracle) != oracleAt) revert Mismatch("ResolutionOracle address");
        if (address(d.adapter) != adapterAt) revert Mismatch("UmaAdapter address");
        if (address(d.registry) != registryAt) revert Mismatch("MarketRegistry address");
        if (address(d.router) != routerAt) revert Mismatch("KeeperRouter address");
        if (address(d.stubFactory) != stubAt) revert Mismatch("StubMarketFactory address");
        _check(d, p, mainnet);
        _write(d, p, params, network);
    }

    function _initialize(Timelock t, Params memory p) internal {
        address[] memory proposers = new address[](1);
        address[] memory executors = new address[](1);
        address[] memory cancellers = new address[](1);
        proposers[0] = p.teamSafe;
        executors[0] = t.OPEN_ROLE_HOLDER();
        cancellers[0] = p.teamSafe;
        t.initialize(p.delay, address(0), proposers, executors, cancellers);
    }

    // ------------------------------------------------------------------ checks

    /// Every immutable link, the Timelock's roles and delay, sim mode by chain, and no role left to the deployer.
    function _check(Deployed memory d, Params memory p, bool mainnet) internal view {
        Timelock t = d.timelock;
        address tl = address(t);
        if (t.minDelay() != p.delay) revert Mismatch("Timelock delay");
        if (!t.hasRole(p.teamSafe, t.PROPOSER_ROLE())) revert Mismatch("Safe proposes");
        if (!t.hasRole(p.teamSafe, t.CANCELLER_ROLE())) revert Mismatch("Safe cancels");
        if (!t.hasRole(t.OPEN_ROLE_HOLDER(), t.EXECUTOR_ROLE())) revert Mismatch("anyone executes");
        for (uint256 role; role <= t.MAX_ROLE(); ++role) {
            if (d.deployer != p.teamSafe && t.hasRole(d.deployer, role)) revert Mismatch("deployer holds a role");
        }

        BondTreasury tr = d.treasury;
        if (tr.usdc() != p.usdc || tr.oracle() != address(d.oracle) || tr.registry() != address(d.registry)) {
            revert Mismatch("treasury links");
        }
        if (tr.governance() != tl) revert Mismatch("treasury governance");

        ResolutionOracle o = d.oracle;
        if (o.registry() != address(d.registry) || o.treasury() != address(d.treasury) || o.usdc() != p.usdc) {
            revert Mismatch("oracle links");
        }
        if (o.governance() != tl || o.guardian() != p.guardianSafe) revert Mismatch("oracle roles");
        if (o.monadChainSelector() != p.selector) revert Mismatch("oracle chain selector");
        if (o.simMode() == mainnet || o.simModeAllowed() == mainnet) revert Mismatch("sim mode by chain");
        if (o.trustSetCount() != 0 || o.activeTrustSetId() != 0) revert Mismatch("no trust set yet");

        UmaAdapter a = d.adapter;
        if (address(a.oov3()) != p.oov3 || a.usdc() != p.usdc) revert Mismatch("adapter venue");
        if (a.oracle() != address(d.oracle) || a.treasury() != address(d.treasury)) revert Mismatch("adapter links");

        MarketRegistry r = d.registry;
        if (r.oracle() != address(d.oracle) || r.treasury() != address(d.treasury) || r.usdc() != p.usdc) {
            revert Mismatch("registry links");
        }
        if (r.governance() != tl || r.lister() != p.teamSafe) revert Mismatch("registry roles");
        if (r.factory() != address(d.stubFactory)) revert Mismatch("registry factory");

        if (address(d.router.oracle()) != address(d.oracle)) revert Mismatch("router oracle");
        if (!mainnet && d.stubFactory.registry() != address(d.registry)) revert Mismatch("stub factory registry");
    }

    // ------------------------------------------------------------------ parameters

    function _params(string memory network) internal view returns (Params memory p, string memory json) {
        string memory path = vm.envOr("PARAMS", string.concat("deployments/params.", network, ".json"));
        json = vm.readFile(path);
        p.usdc = vm.envOr("USDC", json.readAddress(".usdc"));
        p.oov3 = vm.envOr("OOV3", json.readAddress(".uma.oov3"));
        p.teamSafe = vm.envOr("TEAM_SAFE", json.readAddress(".roles.teamSafe"));
        p.guardianSafe = vm.envOr("GUARDIAN_SAFE", json.readAddress(".roles.guardianSafe"));
        p.delay = json.readUint(".timelockDelaySecs");
        p.selector = uint64(vm.parseUint(json.readString(".creChainSelector")));
        if (p.usdc == address(0) || p.oov3 == address(0)) {
            string memory deployed = _existing(network);
            if (bytes(deployed).length != 0) {
                if (p.usdc == address(0)) p.usdc = deployed.readAddress(".usdc");
                if (p.oov3 == address(0)) p.oov3 = deployed.readAddress(".uma.oov3");
            }
        }
        if (p.usdc == address(0)) revert ZeroAddress("usdc");
        if (p.oov3 == address(0)) revert ZeroAddress("uma.oov3");
        if (p.teamSafe == address(0)) revert ZeroAddress("roles.teamSafe (X03)");
        if (p.guardianSafe == address(0)) revert ZeroAddress("roles.guardianSafe (X03)");
        if (p.selector == 0) revert ZeroAddress("creChainSelector");
    }

    /// The deployments file of this network (the dry-run one in a simulation), or "" if there is none.
    function _existing(string memory network) internal view returns (string memory) {
        string memory path = _path(network);
        return vm.exists(path) ? vm.readFile(path) : "";
    }

    // ------------------------------------------------------------------ output (§12.11)

    function _write(Deployed memory d, Params memory p, string memory params, string memory network) internal {
        string memory prior = _existing(network);
        string memory json = string.concat(
            "{\n",
            '  "network": "',
            network,
            '",\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "creChainSelector": "',
            vm.toString(uint256(p.selector)),
            '",\n  "usdc": "',
            vm.toString(p.usdc),
            '",\n  "roles": { "timelock": "',
            vm.toString(address(d.timelock)),
            '", "teamSafe": "',
            vm.toString(p.teamSafe),
            '", "guardianSafe": "',
            vm.toString(p.guardianSafe),
            '", "lister": "',
            vm.toString(p.teamSafe),
            '" },\n',
            _contracts(d),
            _uma(prior, p),
            _cre(params),
            '  "trustSets": [],\n  "globalsVersion": 0,\n  "timelockOps": []\n}\n'
        );
        string memory path = _path(network);
        vm.writeFile(path, json);
        console.log("wrote", path);
    }

    function _contracts(Deployed memory d) internal view returns (string memory s) {
        s = string.concat(
            '  "contracts": {\n',
            _entry("Timelock", address(d.timelock), d.deployBlock, false),
            ",\n",
            _entry("BondTreasury", address(d.treasury), d.deployBlock, false),
            ",\n",
            _entry("ResolutionOracle", address(d.oracle), d.deployBlock, false),
            ",\n",
            _entry("UmaAdapter", address(d.adapter), d.deployBlock, false),
            ",\n",
            _entry("MarketRegistry", address(d.registry), d.deployBlock, false),
            ",\n",
            _entry("KeeperRouter", address(d.router), d.deployBlock, false)
        );
        if (address(d.stubFactory) != address(0)) {
            s = string.concat(s, ",\n", _entry("StubMarketFactory", address(d.stubFactory), d.deployBlock, true));
        }
        s = string.concat(s, "\n  },\n");
    }

    function _entry(string memory name, address a, uint256 deployBlock, bool testnetOnly)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            '    "',
            name,
            '": { "address": "',
            vm.toString(a),
            '", "codehash": "',
            vm.toString(a.codehash),
            '", "deployBlock": ',
            vm.toString(deployBlock),
            testnetOnly ? ', "testnetOnly": true }' : " }"
        );
    }

    /// The UMA section DeployUmaSandbox wrote, kept as it was; else only the OOv3 address.
    function _uma(string memory prior, Params memory p) internal view returns (string memory) {
        if (bytes(prior).length == 0 || !vm.keyExistsJson(prior, ".uma.finder")) {
            return string.concat('  "uma": { "oov3": "', vm.toString(p.oov3), '" },\n');
        }
        return string.concat(
            '  "uma": { "finder": "',
            vm.toString(prior.readAddress(".uma.finder")),
            '", "store": "',
            vm.toString(prior.readAddress(".uma.store")),
            '", "addressWhitelist": "',
            vm.toString(prior.readAddress(".uma.addressWhitelist")),
            '", "identifierWhitelist": "',
            vm.toString(prior.readAddress(".uma.identifierWhitelist")),
            '", "oov3": "',
            vm.toString(p.oov3),
            '", "sandboxOracle": "',
            vm.toString(prior.readAddress(".uma.sandboxOracle")),
            '", "finalFeeAtoms": "',
            prior.readString(".uma.finalFeeAtoms"),
            '" },\n'
        );
    }

    /// The CRE section from the params; workflow IDs and sim relayers are added when known (X01, O19.4).
    function _cre(string memory params) internal pure returns (string memory) {
        return string.concat(
            '  "cre": { "mockForwarder": "',
            vm.toString(params.readAddress(".cre.mockForwarder")),
            '", "keystoneForwarder": "',
            vm.toString(params.readAddress(".cre.keystoneForwarder")),
            '", "orgOwner": "',
            vm.toString(params.readAddress(".cre.orgOwner")),
            '", "workflowName": "',
            params.readString(".cre.workflowName"),
            '", "workflowIds": [], "simRelayers": [] },\n'
        );
    }

    // ------------------------------------------------------------------ network

    /// `deployments/<network>.json` when broadcasting, `deployments/dryrun/<network>.json` in a simulation;
    /// `DEPLOYMENTS_DIR` overrides the folder (a broadcast to a local fork of a real network).
    function _path(string memory network) internal view returns (string memory) {
        bool live = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        string memory dir = vm.envOr("DEPLOYMENTS_DIR", live ? string("deployments") : string("deployments/dryrun"));
        return string.concat(dir, "/", network, ".json");
    }

    /// `monad-testnet` on 10143, `monad-mainnet` on 143, `anvil` on 31337, else `chain-<id>`.
    function networkName() public view returns (string memory) {
        if (block.chainid == 10143) return "monad-testnet";
        if (block.chainid == MONAD_MAINNET) return "monad-mainnet";
        if (block.chainid == 31337) return "anvil";
        return string.concat("chain-", vm.toString(block.chainid));
    }
}
