// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @title GovernanceOp
/// @notice Shared base of the governance scripts (plan §12.5 "Timelock operations", V-R8; task O19.4). A
///         script builds a batch of calls; this base encodes it as a Solady Timelock (ERC-7821) operation,
///         runs every call as the Timelock on the current chain (a fork in a dry run) so an operation that
///         would revert is caught before anyone proposes it, and prints what the Safe proposes: `MODE`,
///         `EXEC`, `ID`, and the Safe transaction to the Timelock. Nothing governance-related is broadcast.
/// @dev `EXEC = abi.encode(calls, abi.encode(predecessor, salt))` and
///      `ID = keccak256(abi.encode(MODE, keccak256(EXEC)))`, the encoding of the §12.5 cast recipe (checked by
///      `TimelockRecipe.t.sol`). `SALT` (a new one per operation) and `PREDECESSOR` come from the environment;
///      without `SALT` the salt is derived from the operation's name and the block time. Addresses come from
///      `deployments/<network>.json` (`DEPLOYMENTS` overrides the path), parameters from
///      `deployments/params.<network>.json` (`PARAMS`).
abstract contract GovernanceOp is Script {
    using stdJson for string;

    /// ERC-7821 batch mode with opData (§12.5 `MODE`).
    bytes32 public constant MODE = 0x0100000000007821000100000000000000000000000000000000000000000000;

    /// Solady ERC7821.Call.
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    error ZeroAddress(string what);
    error CallFailed(uint256 index, bytes reason);

    // ------------------------------------------------------------------ encoding

    function encodeOp(Call[] memory calls, bytes32 predecessor, bytes32 salt)
        public
        pure
        returns (bytes memory exec, bytes32 id)
    {
        exec = abi.encode(calls, abi.encode(predecessor, salt));
        id = keccak256(abi.encode(MODE, keccak256(exec)));
    }

    // ------------------------------------------------------------------ simulate and print

    /// Runs `calls` as `timelock` (in order, as `execute` would), then prints the operation for the Safe.
    function _propose(string memory name, Call[] memory calls, address timelock) internal returns (bytes32 id) {
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(timelock);
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
        bytes32 predecessor = vm.envOr("PREDECESSOR", bytes32(0));
        bytes32 salt = vm.envOr("SALT", keccak256(abi.encode(name, block.timestamp)));
        bytes memory exec;
        (exec, id) = encodeOp(calls, predecessor, salt);
        uint256 delay = _delay(timelock);
        console.log("== Timelock operation:", name);
        console.log("calls", calls.length, "(each simulated as the Timelock: ok)");
        console.log("TIMELOCK", timelock);
        console.log("MODE");
        console.logBytes32(MODE);
        console.log("PREDECESSOR");
        console.logBytes32(predecessor);
        console.log("SALT");
        console.logBytes32(salt);
        console.log("EXEC");
        console.logBytes(exec);
        console.log("ID");
        console.logBytes32(id);
        console.log("Safe transaction: to TIMELOCK, value 0, data = propose(MODE, EXEC, delay) with delay", delay);
        console.logBytes(abi.encodeWithSignature("propose(bytes32,bytes,uint256)", MODE, exec, delay));
        console.log("After the delay, anyone: execute(MODE, EXEC)");
        console.logBytes(abi.encodeWithSignature("execute(bytes32,bytes)", MODE, exec));
    }

    function _delay(address timelock) internal view returns (uint256 d) {
        (bool ok, bytes memory ret) = timelock.staticcall(abi.encodeWithSignature("minDelay()"));
        if (ok && ret.length == 32) d = abi.decode(ret, (uint256));
    }

    // ------------------------------------------------------------------ files

    function networkName() public view returns (string memory) {
        if (block.chainid == 10143) return "monad-testnet";
        if (block.chainid == 143) return "monad-mainnet";
        if (block.chainid == 31337) return "anvil";
        return string.concat("chain-", vm.toString(block.chainid));
    }

    function _deployments() internal view returns (string memory) {
        return vm.readFile(vm.envOr("DEPLOYMENTS", string.concat("deployments/", networkName(), ".json")));
    }

    function _params() internal view returns (string memory) {
        return vm.readFile(vm.envOr("PARAMS", string.concat("deployments/params.", networkName(), ".json")));
    }

    function _contract(string memory deployments, string memory name) internal pure returns (address a) {
        a = deployments.readAddress(string.concat(".contracts.", name, ".address"));
        if (a == address(0)) revert ZeroAddress(name);
    }

    /// An address from the environment, else from the params file; refused when zero (X03 placeholder).
    function _role(string memory params, string memory env, string memory key) internal view returns (address a) {
        a = vm.envOr(env, params.readAddress(key));
        if (a == address(0)) revert ZeroAddress(key);
    }

    /// An address array from the environment (comma-separated), else from the params file ([] allowed).
    function _addresses(string memory params, string memory env, string memory key)
        internal
        view
        returns (address[] memory a)
    {
        a = vm.envOr(env, ",", new address[](0));
        if (a.length != 0) return a;
        try vm.parseJsonAddressArray(params, key) returns (address[] memory fromFile) {
            a = fromFile;
        } catch {}
    }

    function _strings(string memory params, string memory key) internal view returns (string[] memory s) {
        try vm.parseJsonStringArray(params, key) returns (string[] memory fromFile) {
            s = fromFile;
        } catch {}
    }

    function _push(Call[] memory calls, uint256 n, address to, bytes memory data) internal pure returns (uint256) {
        calls[n] = Call(to, 0, data);
        return n + 1;
    }

    function _trim(Call[] memory calls, uint256 n) internal pure returns (Call[] memory out) {
        out = new Call[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = calls[i];
        }
    }
}
