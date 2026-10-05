pragma solidity ^0.8.30;

/// @notice Deployment helper: keep each STOP-prefixed store comfortably below 128 KiB.
/// These bytes are data only; MarketFactory independently verifies their combined hash.
library EngineCodeParts {
    function split(bytes memory code) internal pure returns (bytes memory first, bytes memory second) {
        uint256 cut = code.length > 100_000 ? 100_000 : code.length;
        first = new bytes(cut);
        second = new bytes(code.length - cut);
        assembly ("memory-safe") {
            mcopy(add(first, 32), add(code, 32), cut)
            mcopy(add(second, 32), add(add(code, 32), cut), sub(mload(code), cut))
        }
    }
}
