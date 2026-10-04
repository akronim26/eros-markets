// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @title TestUSDC — TESTNET ONLY
/// @notice The testnet bond token (plan §12.4, `seam-decisions.md` S-13): 6 decimals like USDC, minted by an
///         open faucet capped per call, and nothing else (no owner, no pause, no blocklist, no hooks). Circle's
///         testnet faucet gives too little for the treasury ledgers, and the repository's `MockUSDC` must not
///         go on a public network (its knobs have no access control). Never deploy it on Monad mainnet; the
///         constructor refuses chainId 143.
contract TestUSDC is ERC20 {
    error MainnetRefused();
    error AboveFaucetCap();

    /// @notice The most one `mint` call creates: 100,000 USDC.
    uint256 public constant FAUCET_CAP = 100_000e6;

    constructor() {
        if (block.chainid == 143) revert MainnetRefused();
    }

    function name() public pure override returns (string memory) {
        return "Eros Test USDC";
    }

    function symbol() public pure override returns (string memory) {
        return "tUSDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Faucet: anyone mints up to `FAUCET_CAP` per call to any address.
    function mint(address to, uint256 amount) external {
        if (amount > FAUCET_CAP) revert AboveFaucetCap();
        _mint(to, amount);
    }
}
