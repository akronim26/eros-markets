// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "./CombinedBase.sol";
import {CombinedEngine} from "./CombinedEngine.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../risk/B/B019.t.sol";
import {RiskFixture} from "../math/B/B011.t.sol";

/// @notice Initial-deployment defaults (docs/spec/local_fixture_manifest.json): caps 1x,
///         fundingEnabled=false, recovery and conversion disabled, on the combined engine.
contract ReleaseDefaultsTest is CombinedBase {
    function test_initialDeploymentDefaults() public {
        vm.warp(L0);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        oracle = new MockResolutionAuthority();
        IMarketConfig.Listing memory l = ListingFixture.make(L0, address(oracle), MONITOR, GOV, SIGNER);
        l.scheduledT = L0 + 29 days + 12 hours;
        l.token = address(token);
        l.deploymentCapX = 1;
        l.fundingEnabled = false;
        T = l.scheduledT;
        e = new CombinedEngine(vault, TREASURY, l, RiskFixture.profile(1, true), 1e18);
        vault.registerEngine(address(e));
        oracle.bind(e);
        _fund(LP, 100_000e6, true);
        uint256[] memory u = new uint256[](2);
        (u[0], u[1]) = (120, 400);
        _traders(u);
        _activate();
        vm.warp(L0 + 12 hours); // index 0.59, perp mid 0.60: funding would be nonzero if enabled
        e.feed(L0 + 12 hours - 990, L0 + 12 hours, 59e16, 60e16 - 1e16, 60e16 + 1e16);
        _roll(32);
        assertFalse(e.fundingFeatureEnabled(), "fundingEnabled=false");
        (,,,,, int256 rate,) = e.epoch();
        assertEq(rate, 0, "no funding rate");
        assertEq(e.fundingBudgetQ(), 0);
        assertFalse(e.recoveryEnabled(), "recovery disabled");
        assertEq(e.conversionEligibility(), e.R_DISABLED(), "conversion disabled");
        // 1x: a leveraged entry is refused, an exactly backed one passes.
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000);
        // 1x: a 5x-sized IOC is halved to an exactly backed size (120 USDC buys at most 200 claims).
        uint64 filled = e.place(_ioc(1, MathTypes.Side.BUY, 600, 1_000_000)).filledLots;
        assertGt(filled, 0);
        assertLe(filled, 200_000, "no leverage at cap 1");
        assertGe(_cash(1), 0, "E0 >= 0: fully backed");
        _assertInvariants();
    }
}
