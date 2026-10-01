// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {CombinedEngine} from "./CombinedEngine.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../risk/B/B019.t.sol";
import {RiskFixture} from "../math/B/B011.t.sol";

/// @notice Shared fixture for combined A+B gate tests (integration/risk). Real A and B modules;
///         counterparts mocked: book (MockBookAdapter), price feed (test samples), oracle
///         (MockResolutionAuthority), token (MockUSDC), factory (constructor).
abstract contract CombinedBase is Test {
    uint256 constant Q = 1e18;
    uint256 constant USDC = 1e24; // Q per USDC
    uint64 constant L0 = 1_000_000;
    uint64 T;
    CombinedEngine e;
    CollateralVault vault;
    MockUSDC token;
    MockResolutionAuthority oracle;
    address constant GOV = address(0x60);
    address constant MONITOR = address(0x30);
    address constant SIGNER = address(0x51);
    address constant TREASURY = address(0x777);
    address constant LP = address(0xCAFE);
    address constant KEEPER = address(0xBEEF);

    function _deploy(uint256 capX, uint256 seedUsdc) internal {
        vm.warp(L0);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        oracle = new MockResolutionAuthority();
        IMarketConfig.Listing memory l = ListingFixture.make(L0, address(oracle), MONITOR, GOV, SIGNER);
        l.scheduledT = L0 + 29 days + 12 hours;
        l.token = address(token);
        l.deploymentCapX = capX;
        T = l.scheduledT;
        e = new CombinedEngine(vault, TREASURY, l, RiskFixture.profile(capX, true), 1e18);
        vault.registerEngine(address(e));
        oracle.bind(e);
        if (seedUsdc != 0) _fund(LP, seedUsdc * 1e6, true);
    }

    function _fund(address who, uint256 atoms, bool reserve_) internal {
        token.mint(who, atoms);
        vm.startPrank(who);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(e), atoms, reserve_);
        vm.stopPrank();
    }

    /// Trader address for engine id `id` (ids are A registry index + 1).
    function _who(uint32 id) internal pure returns (address) {
        return address(uint160(0x1000 + id));
    }

    /// Register traders 1..n in order with the given USDC allocations.
    function _traders(uint256[] memory usdc) internal {
        for (uint256 i; i < usdc.length; ++i) _fund(_who(uint32(i + 1)), usdc[i] * 1e6, false);
        for (uint256 i; i < usdc.length; ++i) {
            (uint32 id, address owner) = e.traderIdAt(i);
            assertEq(id, uint32(i + 1));
            assertEq(owner, _who(uint32(i + 1)));
        }
    }

    function _activate() internal {
        vm.prank(GOV);
        e.activateMarket();
    }

    function _keep(uint64 to, uint256 idx, bool perp) internal {
        vm.warp(to);
        e.feed(to - 990, to, idx, perp ? idx - 1e16 : 0, perp ? idx + 1e16 : 0);
    }

    function _epochEnd() internal view returns (uint64 end) {
        (,, end,,,,) = e.epoch();
    }

    /// Complete a rollover at the current time (pages of `page`).
    function _roll(uint8 page) internal {
        e.beginRollover();
        while (!e.rollPage(page)) {}
        e.finishRollover();
    }

    function _ioc(uint32 t, MathTypes.Side s, uint16 limit, uint64 lots)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory)
    {
        return IBookRiskHooks.OrderRequest(t, s, IBookRiskHooks.OrderKind.IOC, limit, lots, 0, false, 8);
    }

    function _cash(uint32 id) internal view returns (int256) {
        return e.account(_who(id)).value.cashQ;
    }

    function _lots(uint32 id) internal view returns (int256) {
        return e.account(_who(id)).value.lots;
    }

    /// INV-01..INV-04 on the real combined ledger.
    function _assertInvariants() internal view {
        (int128 rn, int256 rc) = e.reserve();
        int256 n = rn;
        int256 cash = rc;
        for (uint256 i; i < e.participantCount(); i++) {
            RiskStorage.Account memory a = e.account(e.participants(i));
            n += a.value.lots;
            cash += a.value.cashQ;
        }
        assertEq(n, 0, "INV-01 net position");
        assertEq(
            cash + int256(e.protocolFeeQ() + e.keeperPayableQ()) + e.fundingClearingQ(),
            int256(e.allocationQ()),
            "INV-02 ledger"
        );
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms(), "INV-03 custody");
        assertEq(vault.marketAtoms(address(e)) * Q, e.allocationQ(), "market atoms");
        (int256 s0, int256 s1) = e.coverageSlacks();
        assertGe(s0, 0, "INV-04 NO");
        assertGe(s1, 0, "INV-04 YES");
    }
}
