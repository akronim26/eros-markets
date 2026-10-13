pragma solidity ^0.8.30;

contract EngineCodeStore {
    error InvalidCodeSize();

    constructor(bytes memory creationCode) {
        if (creationCode.length == 0 || creationCode.length >= 131072) revert InvalidCodeSize();
        bytes memory data = bytes.concat(hex"00", creationCode);
        assembly ("memory-safe") {
            return(add(data, 32), mload(data))
        }
    }
}
