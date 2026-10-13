// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {MarginMath} from "@eros/math/MarginMath.sol";
import {HorizonMath} from "@eros/math/HorizonMath.sol";
import {GovernanceOp} from "../GovernanceOp.sol";

interface IActivatable {
    function activateMarket() external;
    function stageRiskParams(MarginMath.RiskParams calldata p) external;
}

/// @title ActivateNativeMarket (NM-D04 follow-up / NM-G01)
/// @notice Prints the Timelock operation that activates a native engine: `activateMarket()` as the
///         engine governance (the Timelock). Simulates it as the Timelock first; broadcasts nothing.
///         Send the printed `propose(MODE, EXEC, delay)` from a Timelock proposer, wait the delay,
///         then anyone sends `execute(MODE, EXEC)`. Without `PROFILE` no calibration is staged and the
///         market stays 1x. With `PROFILE=<calibration.json>` (the `riskParams` object written by the
///         fresh-market planner) the same operation first stages that profile, so the opening epoch
///         activates it and the listing's leverage ceiling applies.
///
///   ENGINE=<engine> [PROFILE=<calibration.json>] forge script script/native/ActivateNativeMarket.s.sol --rpc-url $RPC
contract ActivateNativeMarket is GovernanceOp {
    using stdJson for string;

    function run() external returns (bytes32 id) {
        address engine = vm.envAddress("ENGINE");
        address timelock = vm.envOr("TIMELOCK", address(0x9fe0cF0DD3d190347548c2dC71cdbb4aAAC211F5));
        string memory profilePath = vm.envOr("PROFILE", string(""));
        bool staged = bytes(profilePath).length != 0;
        Call[] memory calls = new Call[](staged ? 2 : 1);
        if (staged) {
            MarginMath.RiskParams memory p = _profile(vm.readFile(profilePath));
            calls[0] = Call(engine, 0, abi.encodeCall(IActivatable.stageRiskParams, (p)));
        }
        calls[calls.length - 1] = Call(engine, 0, abi.encodeCall(IActivatable.activateMarket, ()));
        id = _propose(string.concat("activate native ", vm.toString(engine)), calls, timelock);
    }

    function _profile(string memory j) internal pure returns (MarginMath.RiskParams memory p) {
        p.h0Secs = j.readUint(".riskParams.h0Secs");
        p.absorptionClaimsPerMin = j.readUint(".riskParams.absorptionClaimsPerMin");
        p.queueSecs = j.readUint(".riskParams.queueSecs");
        p.hazard0WadPerDay = j.readUint(".riskParams.hazard0WadPerDay");
        p.hazard1WadPerDay = j.readUint(".riskParams.hazard1WadPerDay");
        p.epsilonWad = j.readUint(".riskParams.epsilonWad");
        p.gammaWad = j.readUint(".riskParams.gammaWad");
        p.sWad = j.readUint(".riskParams.sWad");
        p.lambdaWadPerClaim = j.readUint(".riskParams.lambdaWadPerClaim");
        p.template = MarginMath.Template(j.readUint(".riskParams.template"));
        p.calibrated = j.readBool(".riskParams.calibrated");
        p.deploymentCapX = j.readUint(".riskParams.deploymentCapX");
        p.realized = _envelope(j, ".riskParams.realized");
        p.templateEnv = _envelope(j, ".riskParams.templateEnv");
    }

    function _envelope(string memory j, string memory key) internal pure returns (HorizonMath.Envelope memory e) {
        uint256[] memory h = j.readUintArray(string.concat(key, ".hSecs"));
        e.hSecs = new uint64[](h.length);
        for (uint256 i; i < h.length; ++i) e.hSecs[i] = uint64(h[i]);
        e.sigmaWad = j.readUintArray(string.concat(key, ".sigmaWad"));
        e.validFrom = uint64(j.readUint(string.concat(key, ".validFrom")));
        e.validUntil = uint64(j.readUint(string.concat(key, ".validUntil")));
    }
}
