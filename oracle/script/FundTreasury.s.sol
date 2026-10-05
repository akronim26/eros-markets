// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {GovernanceOp} from "./GovernanceOp.sol";
import {Ledger} from "../src/types/OracleTypes.sol";
import {BondTreasury} from "../src/BondTreasury.sol";

interface IFundToken {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function mint(address to, uint256 amount) external; // TestUSDC faucet (testnet only)
}

/// @title FundTreasury
/// @notice Treasury setup (plan §12.5, §14.1; task O19.4): `setLimits(maxPerMarket, maxOpenDisputes)` from
///         `params.treasuryLimits` as a Timelock operation for the Safe (both limits start at 0, so without it
///         `fundAssertion` and `disputeViaVenue` revert), then the funder's deposits. Deposits are not governance:
///         with `DEPOSIT=true` the script approves the treasury and deposits ASSERTION_ATOMS into ASSERTION,
///         FLOAT_ATOMS into WATCHDOG_FLOAT and REWARD_ATOMS into PROPOSER_REWARD (defaults 1,000 USDC, 1,000
///         USDC, 0: §12.5), broadcast with `--broadcast`; on testnet `MINT=true` first takes the shortfall from
///         the TestUSDC faucet (100,000 USDC per call).
contract FundTreasury is GovernanceOp {
    using stdJson for string;

    function run() external returns (bytes32 id) {
        string memory deployments = _deployments();
        string memory params = _params();
        address timelock = deployments.readAddress(".roles.timelock");
        BondTreasury treasury = BondTreasury(_contract(deployments, "BondTreasury"));
        uint256 maxPerMarket = params.readUint(".treasuryLimits.maxPerMarketAtoms");
        uint32 maxOpenDisputes = uint32(params.readUint(".treasuryLimits.maxOpenDisputes"));
        Call[] memory calls = new Call[](1);
        _push(calls, 0, address(treasury), abi.encodeCall(treasury.setLimits, (maxPerMarket, maxOpenDisputes)));
        id = _propose("treasury limits", calls, timelock);
        if (vm.envOr("DEPOSIT", false)) _deposit(treasury, deployments.readAddress(".usdc"));
    }

    function _deposit(BondTreasury treasury, address usdc) internal {
        uint256 assertion = vm.envOr("ASSERTION_ATOMS", uint256(1_000e6));
        uint256 float_ = vm.envOr("FLOAT_ATOMS", uint256(1_000e6));
        uint256 reward = vm.envOr("REWARD_ATOMS", uint256(0));
        uint256 total = assertion + float_ + reward;
        IFundToken token = IFundToken(usdc);
        vm.startBroadcast();
        (, address funder,) = vm.readCallers();
        if (vm.envOr("MINT", false) && block.chainid != 143) {
            uint256 have = token.balanceOf(funder);
            while (have < total) {
                uint256 step = total - have > 100_000e6 ? 100_000e6 : total - have;
                token.mint(funder, step);
                have += step;
            }
        }
        require(token.approve(address(treasury), total), "approve");
        if (assertion != 0) treasury.deposit(Ledger.ASSERTION, assertion);
        if (float_ != 0) treasury.deposit(Ledger.WATCHDOG_FLOAT, float_);
        if (reward != 0) treasury.deposit(Ledger.PROPOSER_REWARD, reward);
        vm.stopBroadcast();
        console.log("deposited (atoms): ASSERTION", assertion);
        console.log("                   WATCHDOG_FLOAT", float_);
        console.log("                   PROPOSER_REWARD", reward);
    }
}
