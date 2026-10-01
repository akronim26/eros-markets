// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EndToEndTest} from "../integration/EndToEnd.t.sol";
import {ReleaseDefaultsTest} from "../integration/ReleaseDefaults.t.sol";

/// @notice G7 — integrated handoff. Replays the risk_spec section 11 end-to-end scenario and the
///         initial-deployment defaults on real A+B modules from one clean commit. Live counterpart
///         status is reported separately (artifacts/risk/counterpart-status.json): all BLOCKED.
contract G7EndToEndTest is EndToEndTest {}

contract G7ReleaseDefaultsTest is ReleaseDefaultsTest {}
