// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RiskContextPort} from "../../../src/risk/RiskContextPort.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {MockAccountingPort, ICoverageScript} from "../../mocks/B/MockAccountingPort.sol";

/// @title RiskHarness (B020)
/// @notice Base composition for B tests: the real B config/pricing/context modules over the
///         scripted accounting double. Later B suites extend it with their own modules. It exposes
///         test-only drivers; it is never a production entry point.
contract RiskHarness is RiskContextPort, MockAccountingPort {
    function hInit(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) public {
        _initMarket(l, p);
    }

    function hIndex(uint64 t, uint256 p) public {
        _onIndexObservation(t, p, true);
    }

    function hPerp(uint64 t, uint256 bid, uint256 ask, uint256 depth) public {
        _recordPerp(t, bid, ask, depth, depth);
    }

    /// Feed a steady index and perp book from `from` to `to` every `step` seconds.
    function hFeed(uint64 from, uint64 to, uint64 step, uint256 index, uint256 perpBid, uint256 perpAsk)
        public
    {
        for (uint64 t = from; t <= to; t += step) {
            _onIndexObservation(t, index, true);
            if (perpAsk != 0) _recordPerp(t, perpBid, perpAsk, 1_000_000, 1_000_000);
        }
    }

    function hEpochOpened() public {
        _riskEpochOpened();
    }

    function hBegin() public {
        _acctBeginAction();
    }

    function hTouch(uint32 t) public {
        _acctTouch(t);
    }

    function hEnd() public {
        _mockEndAction();
    }
}

/// @notice Spec §7.3 order-aware deficit formula on fixed fixtures, with a scripted reserve.
///         Lives in test code so the accounting double stays free of coverage logic.
contract FormulaCoverage is ICoverageScript {
    uint256 internal constant QC = 1e18;
    uint256 public reserveQ;
    uint256 public capQ;
    uint256 public otherDbar0Q;
    uint256 public otherDbar1Q;

    constructor(uint256 reserveQ_, uint256 capQ_) {
        (reserveQ, capQ) = (reserveQ_, capQ_);
    }

    function set(uint256 reserveQ_, uint256 capQ_, uint256 o0, uint256 o1) external {
        (reserveQ, capQ, otherDbar0Q, otherDbar1Q) = (reserveQ_, capQ_, o0, o1);
    }

    function coverage(uint32, int256 cashQ, int256 lots, OA.OrderSums calldata s)
        external
        view
        returns (OA.CoverageInput memory c)
    {
        int256 u = int256(1000 * QC);
        int256 cEff = cashQ - int256(s.feeCapQ);
        int256 e0 = cEff - int256(s.bidValueQ);
        int256 e1 = cEff + u * lots - u * int256(uint256(s.askLots)) + int256(s.askValueQ);
        c.d0Q = e0 < 0 ? uint256(-e0) : 0;
        c.d1Q = e1 < 0 ? uint256(-e1) : 0;
        c.deficitCapQ = capQ;
        c.marketOk = reserveQ >= otherDbar0Q + c.d0Q && reserveQ >= otherDbar1Q + c.d1Q;
    }
}
