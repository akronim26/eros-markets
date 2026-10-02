// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ClaimRenderer} from "../../../src/libraries/ClaimRenderer.sol";

/// @title RenderClaim
/// @notice The claim preview of `oracle-cli list` (plan §12.9 step 6, ADJ-16): renders through the contracts'
///         own `ClaimRenderer` until the oracle-sdk mirror exists (O30.3). Called with
///         `forge script ... --sig 'run(bytes)' <args> --json`; nothing is deployed or sent.
contract RenderClaim {
    /// @param args `abi.encode(template, fields, l1Url)`; `fields.evidence` is ignored when `l1Url` is set
    ///        and replaced by the Layer 1 text for `valueHash`.
    /// @return claim the rendered claim
    /// @return worstCase the registry's §6.3 rule 6 bound for this template, question, rules and URL
    function run(bytes calldata args) external pure returns (bytes memory claim, uint256 worstCase) {
        (string memory template, ClaimRenderer.Fields memory f, string memory l1Url, bytes32 valueHash) =
            abi.decode(args, (string, ClaimRenderer.Fields, string, bytes32));
        if (bytes(l1Url).length != 0) f.evidence = ClaimRenderer.l1Evidence(valueHash, l1Url);
        claim = ClaimRenderer.render(template, f);
        worstCase = ClaimRenderer.worstCaseLength(
            template, bytes(f.question).length, bytes(f.rules).length, bytes(l1Url).length
        );
    }
}
