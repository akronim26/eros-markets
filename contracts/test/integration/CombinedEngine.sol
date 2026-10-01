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

    /// Index-only samples every `step` seconds (INVALID capture window after a halt).
    function feedIndex(uint64 from, uint64 to, uint64 step, uint256 idx, uint64 gapFrom, uint64 gapTo) external {
        for (uint64 t = from; t <= to; t += step) {
            if (t > gapFrom && t < gapTo) continue;
            _onIndexObservation(t, idx, true);
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

    function cancelSlot(uint32 slot) external returns (bool) {
        return _mockCancel(slot);
    }

    /// Person A's per-action context as answered by B (test view).
    function accountingContext() external view returns (Context memory) {
        return _checkedContext();
    }

    function liq(uint32 t, uint64 maxLots, uint16 maxExam, uint32 partner)
        external
        returns (RiskLiquidation.LiquidationResult memory r)
    {
        r = this.liquidate(t, maxLots, maxExam, partner);
    }
}

/// @notice Fee-enabled variant (DEC-11: the initial profile has zero fees; fee accounting must still
///         be exercised). Linear exact fee of `feeWad` on notional; cap at the limit tick.
contract CombinedEngineFee is CombinedEngine {
    uint256 public immutable feeWad;

    constructor(
        CollateralVault vault,
        address treasury_,
        IMarketConfig.Listing memory l,
        MarginMath.RiskParams memory p,
        uint256 feeWad_
    ) CombinedEngine(vault, treasury_, l, p, 1e18) {
        feeWad = feeWad_;
    }

    function _tradeFeeQ(uint64 lots, uint16 tick, bool isMaker) internal view override returns (uint256) {
        return isMaker ? 0 : uint256(lots) * tick * feeWad;
    }

    function _feeCapQ(uint64 lots, uint16 tick) internal view override returns (uint256) {
        return uint256(lots) * tick * feeWad;
    }
}

/// @notice Fault-injection variant: the k-th accounting posting reverts (unexpected assertion).
contract CombinedEngineFault is CombinedEngine {
    error InjectedAccountingFailure();

    uint256 public failAt;
    uint256 public posts;

    constructor(CollateralVault vault, address treasury_, IMarketConfig.Listing memory l, MarginMath.RiskParams memory p)
        CombinedEngine(vault, treasury_, l, p, 1e18)
    {}

    function setFailAt(uint256 k) external {
        (failAt, posts) = (k, 0);
    }

    function _acctPostFill(FillDelta memory d) internal override {
        posts += 1;
        if (posts == failAt) revert InjectedAccountingFailure();
        super._acctPostFill(d);
    }
}
