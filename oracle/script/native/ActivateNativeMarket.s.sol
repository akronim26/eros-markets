// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {GovernanceOp} from "../GovernanceOp.sol";

interface IActivatable {
    function activateMarket() external;
}

/// @title ActivateNativeMarket (NM-D04 follow-up / NM-G01)
/// @notice Prints the Timelock operation that activates a native engine: `activateMarket()` as the
///         engine governance (the Timelock). Simulates it as the Timelock first; broadcasts nothing.
///         Send the printed `propose(MODE, EXEC, delay)` from a Timelock proposer, wait the delay,
///         then anyone sends `execute(MODE, EXEC)`. No calibration is staged: the market stays 1x.
///
///   ENGINE=<engine> forge script script/native/ActivateNativeMarket.s.sol --rpc-url $RPC
contract ActivateNativeMarket is GovernanceOp {
    function run() external returns (bytes32 id) {
        address engine = vm.envAddress("ENGINE");
        address timelock = vm.envOr("TIMELOCK", address(0x9fe0cF0DD3d190347548c2dC71cdbb4aAAC211F5));
        Call[] memory calls = new Call[](1);
        calls[0] = Call(engine, 0, abi.encodeCall(IActivatable.activateMarket, ()));
        id = _propose(string.concat("activate native ", vm.toString(engine)), calls, timelock);
    }
}
