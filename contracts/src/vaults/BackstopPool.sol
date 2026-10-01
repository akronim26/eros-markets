// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {CollateralVault, ICollateralToken} from "./CollateralVault.sol";

/// @notice Irrevocably earmarked cash. It is not recognized cover until allocated.
contract BackstopPool {
    ICollateralToken public immutable token;
    address public immutable allocator;
    mapping(address => uint256) public earmarkedAtoms;
    mapping(address => uint256) public spentAtoms;
    error Unauthorized();
    error TransferFailed();

    constructor(address token_, address allocator_) {
        token = ICollateralToken(token_);
        allocator = allocator_;
    }

    function fund(address engine, uint256 atoms) external {
        if (msg.sender != allocator) revert Unauthorized();
        uint256 beforeBalance = token.balanceOf(address(this));
        if (
            !token.transferFrom(msg.sender, address(this), atoms)
                || token.balanceOf(address(this)) - beforeBalance != atoms
        ) revert TransferFailed();
        earmarkedAtoms[engine] += atoms;
    }

    function draw(uint256 requested, uint256 seedAtoms) external returns (uint256 atoms) {
        // The caller's immutable seed must be read from the engine, never trusted as supplied.
        (bool ok, bytes memory data) = msg.sender.staticcall(abi.encodeWithSignature("reserveCapBaseQ()"));
        if (!ok || data.length != 32 || abi.decode(data, (uint256)) / 1e18 != seedAtoms) {
            revert Unauthorized();
        }
        uint256 cap = seedAtoms / 5 - spentAtoms[msg.sender];
        atoms = requested < cap ? requested : cap;
        if (atoms > earmarkedAtoms[msg.sender]) atoms = earmarkedAtoms[msg.sender];
        earmarkedAtoms[msg.sender] -= atoms;
        spentAtoms[msg.sender] += atoms;
        if (!token.transfer(msg.sender, atoms)) revert TransferFailed();
    }
}
