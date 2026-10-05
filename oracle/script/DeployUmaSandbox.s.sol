// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ErosSandboxOracle} from "../src/venues/ErosSandboxOracle.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";

interface ISandboxFinder {
    function changeImplementationAddress(bytes32 interfaceName, address implementationAddress) external;
    function getImplementationAddress(bytes32 interfaceName) external view returns (address);
}

struct SandboxFixedPoint {
    uint256 rawValue;
}

interface ISandboxStore {
    function setFinalFee(address currency, SandboxFixedPoint calldata newFinalFee) external;
    function computeFinalFee(address currency) external view returns (SandboxFixedPoint memory);
}

interface ISandboxAddressWhitelist {
    function addToWhitelist(address newElement) external;
    function isOnWhitelist(address elementToCheck) external view returns (bool);
}

interface ISandboxIdentifierWhitelist {
    function addSupportedIdentifier(bytes32 identifier) external;
    function isIdentifierSupported(bytes32 identifier) external view returns (bool);
}

interface ISandboxOOv3 {
    function defaultCurrency() external view returns (address);
    function defaultLiveness() external view returns (uint64);
    function getMinimumBond(address currency) external view returns (uint256);
}

/// @title DeployUmaSandbox
/// @notice Testnet UMA sandbox (plan §12.4, task O19.3): UMA's `OracleSandbox.s.sol` with ErosSandboxOracle as
///         the DVM stand-in and a 6-decimal bond token. Deploys and wires, in order: Finder; Store(0, 0, 0) with
///         the final fee; AddressWhitelist with the bond token; IdentifierWhitelist with ASSERT_TRUTH;
///         ErosSandboxOracle owned by the deployer; the four Finder entries; OptimisticOracleV3(finder, token,
///         liveness); then `setRequester(OOv3)` and `transferOwnership(SANDBOX_OWNER)`. Without `BOND_TOKEN` it
///         first deploys TestUSDC (S-13). Writes `deployments/<network>.json` (§12.11: `usdc` and `uma`) when
///         broadcasting, `deployments/dryrun/<network>.json` in a simulation.
/// @dev Environment: SANDBOX_OWNER (required, the team Safe), BOND_TOKEN (optional), FINAL_FEE (default
///      1,000,000 = 1 USDC, so the minimum bond is 2 USDC), DEFAULT_LIVENESS (default 7,200). UMA's 0.8.16
///      contracts are loaded from their artifact files: run `forge build` first. Refuses chainId 143.
contract DeployUmaSandbox is Script {
    error MainnetRefused();
    error ZeroSandboxOwner();
    error MissingArtifact(string path);
    error Mismatch(string what);

    uint256 internal constant MONAD_MAINNET = 143;

    struct Deployed {
        address usdc;
        address finder;
        address store;
        address addressWhitelist;
        address identifierWhitelist;
        address sandboxOracle;
        address oov3;
        uint256 finalFee;
    }

    function run() external returns (Deployed memory d) {
        if (block.chainid == MONAD_MAINNET) revert MainnetRefused();
        address owner = vm.envAddress("SANDBOX_OWNER");
        if (owner == address(0)) revert ZeroSandboxOwner();
        address token = vm.envOr("BOND_TOKEN", address(0));
        d.finalFee = vm.envOr("FINAL_FEE", uint256(1_000_000));
        uint64 liveness = uint64(vm.envOr("DEFAULT_LIVENESS", uint256(7200)));

        vm.startBroadcast();
        d.usdc = token != address(0) ? token : address(new TestUSDC());
        // 1. Finder
        d.finder = _deploy("Finder", "");
        // 2. Store(0, 0, 0) + setFinalFee(token, FINAL_FEE)
        d.store = _deploy("Store", abi.encode(uint256(0), uint256(0), address(0)));
        ISandboxStore(d.store).setFinalFee(d.usdc, SandboxFixedPoint(d.finalFee));
        // 3. AddressWhitelist + addToWhitelist(token)
        d.addressWhitelist = _deploy("AddressWhitelist", "");
        ISandboxAddressWhitelist(d.addressWhitelist).addToWhitelist(d.usdc);
        // 4. IdentifierWhitelist + addSupportedIdentifier("ASSERT_TRUTH")
        d.identifierWhitelist = _deploy("IdentifierWhitelist", "");
        ISandboxIdentifierWhitelist(d.identifierWhitelist).addSupportedIdentifier("ASSERT_TRUTH");
        // 5. ErosSandboxOracle, owned by the deployer until step 8
        (, address deployer,) = vm.readCallers();
        ErosSandboxOracle dvm = new ErosSandboxOracle(deployer);
        d.sandboxOracle = address(dvm);
        // 6. Finder entries
        ISandboxFinder f = ISandboxFinder(d.finder);
        f.changeImplementationAddress("Store", d.store);
        f.changeImplementationAddress("CollateralWhitelist", d.addressWhitelist);
        f.changeImplementationAddress("IdentifierWhitelist", d.identifierWhitelist);
        f.changeImplementationAddress("Oracle", d.sandboxOracle);
        // 7. OptimisticOracleV3(finder, token, liveness)
        d.oov3 = _deploy("OptimisticOracleV3", abi.encode(d.finder, d.usdc, liveness));
        // 8. the requester (one-shot), then ownership to the team Safe
        dvm.setRequester(d.oov3);
        dvm.transferOwnership(owner);
        vm.stopBroadcast();

        _check(d, owner, liveness);
        _write(d);
    }

    // ------------------------------------------------------------------ checks

    function _check(Deployed memory d, address owner, uint64 liveness) internal view {
        ErosSandboxOracle dvm = ErosSandboxOracle(d.sandboxOracle);
        if (dvm.owner() != owner) revert Mismatch("sandbox owner");
        if (dvm.requester() != d.oov3) revert Mismatch("sandbox requester");
        ISandboxFinder f = ISandboxFinder(d.finder);
        if (f.getImplementationAddress("Store") != d.store) revert Mismatch("finder Store");
        if (f.getImplementationAddress("CollateralWhitelist") != d.addressWhitelist) {
            revert Mismatch("finder CollateralWhitelist");
        }
        if (f.getImplementationAddress("IdentifierWhitelist") != d.identifierWhitelist) {
            revert Mismatch("finder IdentifierWhitelist");
        }
        if (f.getImplementationAddress("Oracle") != d.sandboxOracle) revert Mismatch("finder Oracle");
        if (ISandboxStore(d.store).computeFinalFee(d.usdc).rawValue != d.finalFee) revert Mismatch("final fee");
        if (!ISandboxAddressWhitelist(d.addressWhitelist).isOnWhitelist(d.usdc)) revert Mismatch("collateral");
        if (!ISandboxIdentifierWhitelist(d.identifierWhitelist).isIdentifierSupported("ASSERT_TRUTH")) {
            revert Mismatch("identifier");
        }
        ISandboxOOv3 o = ISandboxOOv3(d.oov3);
        if (o.defaultCurrency() != d.usdc) revert Mismatch("OOv3 currency");
        if (o.defaultLiveness() != liveness) revert Mismatch("OOv3 liveness");
        if (o.getMinimumBond(d.usdc) != 2 * d.finalFee) revert Mismatch("minimum bond = 2 x final fee");
        if (bytes(TestUSDC(d.usdc).symbol()).length == 0) revert Mismatch("bond token");
        if (TestUSDC(d.usdc).decimals() != 6) revert Mismatch("bond token decimals");
    }

    // ------------------------------------------------------------------ helpers

    /// Deploys a UMA contract from its artifact file (compiled with 0.8.16 from test/uma/UmaImports.sol).
    function _deploy(string memory name, bytes memory args) internal returns (address a) {
        string memory path = string.concat("out/", name, ".sol/", name, ".json");
        if (!vm.exists(path)) revert MissingArtifact(path);
        bytes memory code = abi.encodePacked(vm.getCode(path), args);
        assembly ("memory-safe") {
            a := create(0, add(code, 0x20), mload(code))
        }
        if (a == address(0)) revert Mismatch(string.concat("deploy ", name));
    }

    /// Writes `deployments/<network>.json` with the bond token and the sandbox addresses (§12.11).
    function _write(Deployed memory d) internal {
        string memory network = networkName();
        string memory json = string.concat(
            "{\n",
            '  "network": "',
            network,
            '",\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "creChainSelector": "2183018362218727504",\n  "usdc": "',
            vm.toString(d.usdc),
            '",\n  "uma": {\n    "finder": "',
            vm.toString(d.finder),
            '",\n    "store": "',
            vm.toString(d.store),
            '",\n    "addressWhitelist": "',
            vm.toString(d.addressWhitelist),
            '",\n    "identifierWhitelist": "',
            vm.toString(d.identifierWhitelist),
            '",\n    "oov3": "',
            vm.toString(d.oov3),
            '",\n    "sandboxOracle": "',
            vm.toString(d.sandboxOracle),
            '",\n    "finalFeeAtoms": "',
            vm.toString(d.finalFee),
            '"\n  }\n}\n'
        );
        string memory path = deploymentsPath(network);
        vm.writeFile(path, json);
        console.log("wrote", path);
    }

    /// `deployments/<network>.json` when broadcasting; a simulation writes `deployments/dryrun/<network>.json`
    /// instead (gitignored), so a dry run never overwrites the real addresses. `DEPLOYMENTS_DIR` overrides the
    /// folder (a broadcast to a local fork of a real network sets it to `deployments/dryrun`).
    function deploymentsPath(string memory network) public returns (string memory) {
        bool live = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        string memory dir = vm.envOr("DEPLOYMENTS_DIR", live ? string("deployments") : string("deployments/dryrun"));
        vm.createDir(dir, true);
        return string.concat(dir, "/", network, ".json");
    }

    /// `monad-testnet` on 10143, `anvil` on 31337, else `chain-<id>`.
    function networkName() public view returns (string memory) {
        if (block.chainid == 10143) return "monad-testnet";
        if (block.chainid == 31337) return "anvil";
        return string.concat("chain-", vm.toString(block.chainid));
    }
}
