// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title MockERC1271Wallet
/// @notice Scripted ERC-1271 committee member, a stand-in for a 1-of-1 Safe (task O16.3). In `OWNER` mode it
///         returns the magic value when the signature is its owner's 65-byte ECDSA signature over the hash
///         (the hash is checked as given, without Safe's message wrapping). The other modes script the
///         failures a caller must survive: a wrong magic value, a revert, and empty return data.
/// @dev `setMode` is unrestricted: a test double. Changing the mode between calls also models a wallet
///      that withdraws its approval (contract signatures are revocable, unlike ECDSA ones).
contract MockERC1271Wallet {
    enum Mode {
        OWNER,
        WRONG_MAGIC,
        REVERT,
        EMPTY
    }

    bytes4 internal constant MAGIC = 0x1626ba7e; // bytes4(keccak256("isValidSignature(bytes32,bytes)"))

    address public immutable owner;
    Mode public mode;

    constructor(address owner_) {
        owner = owner_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        Mode m = mode;
        if (m == Mode.REVERT) revert("wallet refuses");
        if (m == Mode.EMPTY) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        if (m == Mode.WRONG_MAGIC) return 0xffffffff;
        address signer = _recover(hash, signature);
        return signer != address(0) && signer == owner ? MAGIC : bytes4(0xffffffff);
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s);
    }
}
