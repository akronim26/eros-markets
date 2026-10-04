// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.16;

// Compiles UMA's sandbox stack (AGPL, test/sandbox only) so tests/scripts can vm.deployCode it.
import "@uma/core/contracts/optimistic-oracle-v3/implementation/OptimisticOracleV3.sol";
import "@uma/core/contracts/data-verification-mechanism/implementation/Finder.sol";
import "@uma/core/contracts/data-verification-mechanism/implementation/Store.sol";
import "@uma/core/contracts/data-verification-mechanism/implementation/IdentifierWhitelist.sol";
import "@uma/core/contracts/common/implementation/AddressWhitelist.sol";
