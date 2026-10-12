// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @title OutcomeToken
/// @notice One side (YES or NO) of a native Eros binary event (NM-C01). A standard six-decimal
///         ERC-20: one atom is backed by one collateral atom inside a complete set held by the
///         issuing `NativeOutcomeVault`. Only that vault can mint or burn; there is no admin, pause,
///         rebase, fee or proxy. Transfers stay open through and after resolution.
contract OutcomeToken is ERC20 {
    error OnlyVault();

    address public immutable vault;
    bytes32 public immutable marketId;
    bool public immutable isYes;

    string private _name;
    string private _symbol;

    constructor(bytes32 marketId_, bool isYes_, string memory name_, string memory symbol_) {
        vault = msg.sender;
        marketId = marketId_;
        isYes = isYes_;
        _name = name_;
        _symbol = symbol_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev Plain ERC-20 allowance semantics: no implicit Permit2 infinite allowance.
    function _givePermit2InfiniteAllowance() internal pure override returns (bool) {
        return false;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    /// @dev The vault only ever burns its caller's own balance (never an arbitrary `from`).
    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
