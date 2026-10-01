// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RiskAccountingBridge} from "../../src/engine/RiskAccountingBridge.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {AdmissionMode} from "../../src/math/RiskTypes.sol";
import {MockBookAdapter} from "../mocks/B/MockBookAdapter.sol";
import {RiskLiquidation} from "../../src/risk/RiskLiquidation.sol";

/// @notice Combined A+B engine for gate tests: real Person A accounting/custody/settlement and
///         real Person B risk/lifecycle/settlement controllers in one contract. Counterparts
///         mocked: CP-BOOK (MockBookAdapter), CP-PRICE (test-fed observations), CP-ORACLE
///         (MockResolutionAuthority), CP-FACTORY (constructor). No A/B scripted double.
contract CombinedEngine is RiskAccountingBridge, MockBookAdapter {
    constructor(
        CollateralVault vault,
        address treasury_,
        IMarketConfig.Listing memory l,
        MarginMath.RiskParams memory p,
        uint256 premiumLoadWad
    ) RiskStorage(vault, treasury_, l.scheduledT, false, l.fundingEnabled) RiskAccountingBridge(premiumLoadWad) {
        _initMarket(l, p);
    }

    // ---- CP-PRICE stand-in: authenticated-observation plumbing is B016/B017; tests feed samples.
    function feed(uint64 from, uint64 to, uint256 idx, uint256 bid, uint256 ask) external {
        for (uint64 t = from; t <= to; t += 10) {
            _onIndexObservation(t, idx, true);
            if (ask != 0) _recordPerp(t, bid, ask, 1e6, 1e6);
        }
    }

    // ---- CP-BOOK stand-in entry points (MockBookAdapter drives B's real hooks).
    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }

    function place(IBookRiskHooks.OrderRequest memory r) external returns (PlaceResult memory res) {
        res = _mockPlace(r);
    }

    function rest(uint32 owner, MathTypes.Side side, uint16 tick, uint64 lots) external returns (uint32 s) {
        s = _mockRest(owner, side, tick, lots, 0, false);
    }

    function cancelAll(uint32 t) external {
        _cancelAllTopLevel(t);
    }

    function liq(uint32 t, uint64 maxLots, uint16 maxExam, uint32 partner)
        external
        returns (RiskLiquidation.LiquidationResult memory r)
    {
        r = this.liquidate(t, maxLots, maxExam, partner);
    }
}
