// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {QMath} from "../../src/math/QMath.sol";
import {LedgerMath as L} from "../../src/math/LedgerMath.sol";
import {CoverageMath as C} from "../../src/math/CoverageMath.sol";
import {FundingMath} from "../../src/math/FundingMath.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {PricingMath} from "../../src/math/PricingMath.sol";
import {OracleOutcomeMap} from "../../src/interfaces/IResolutionIngress.sol";
import "../../src/math/RiskTypes.sol" as RT;

/// @notice G0 — math contract frozen (docs/contracts/G0.json). Real A types/primitives and real B
///         types compiled together; shared pure-input smoke fixture from
///         reference/fixtures/golden_cases.json evaluated by both lanes' libraries.
contract G0Test is Test {
    function test_unitsIdentical() public pure {
        assertEq(RT.Q, MathTypes.Q);
        assertEq(RT.WAD, MathTypes.WAD);
        assertEq(RT.PAYOFF_Q_PER_LOT, MathTypes.PAYOFF_Q_PER_LOT);
        assertEq(RT.PAYOFF_Q_PER_LOT, 1000 * 1e18);
        assertEq(RT.LOTS_PER_CLAIM, MathTypes.LOTS_PER_CLAIM);
        assertEq(RT.MIN_TICK, MathTypes.MIN_TICK);
        assertEq(RT.MAX_TICK, MathTypes.MAX_TICK);
        assertEq(RT.MAX_ABS_POSITION_LOTS, uint256(uint128(MathTypes.MAX_POSITION_LOTS)));
        assertEq(RT.Q_PER_USDC, 1e24);
    }

    function test_enumOrdinalsIdentical() public pure {
        // Spec §4.6 AccountingState (B) == A's RiskStorage.Work.
        assertEq(uint8(RT.AccountingState.READY), uint8(RiskStorage.Work.READY));
        assertEq(uint8(RT.AccountingState.ROLLOVER_SWEEP), uint8(RiskStorage.Work.ROLLOVER_SWEEP));
        assertEq(uint8(RT.AccountingState.FLOOR_SWEEP), uint8(RiskStorage.Work.FLOOR_SWEEP));
        assertEq(uint8(RT.AccountingState.HALT_SWEEP), uint8(RiskStorage.Work.HALT_SWEEP));
        assertEq(uint8(MathTypes.FinalOutcome.UNSET), 0);
        assertEq(uint8(MathTypes.FinalOutcome.NO), 1);
        assertEq(uint8(MathTypes.FinalOutcome.YES), 2);
        assertEq(uint8(MathTypes.FinalOutcome.INVALID), 3);
        assertEq(uint8(MathTypes.Side.BUY), 0);
        assertEq(uint8(MathTypes.Side.SELL), 1);
    }

    /// Oracle {NONE, YES, NO, INVALID} maps explicitly in both lanes; never by ordinal cast.
    function test_oracleMappingAgrees() public pure {
        (OracleOutcomeMap.EngineCall cy, uint8 y1) = OracleOutcomeMap.engineCallFor(1);
        (OracleOutcomeMap.EngineCall cn, uint8 y0) = OracleOutcomeMap.engineCallFor(2);
        (OracleOutcomeMap.EngineCall ci,) = OracleOutcomeMap.engineCallFor(3);
        assertEq(uint8(cy), uint8(OracleOutcomeMap.EngineCall.SETTLE_BINARY));
        assertEq(uint8(cn), uint8(OracleOutcomeMap.EngineCall.SETTLE_BINARY));
        assertEq(uint8(ci), uint8(OracleOutcomeMap.EngineCall.SETTLE_INVALID));
        assertEq(uint8(MathTypes.fromBinaryY(y1)), uint8(MathTypes.fromOracleOutcome(MathTypes.OracleOutcome.YES)));
        assertEq(uint8(MathTypes.fromBinaryY(y0)), uint8(MathTypes.fromOracleOutcome(MathTypes.OracleOutcome.NO)));
    }

    /// Directed rounding conventions of the shared primitives (spec §2.1).
    function test_roundingConventions() public pure {
        assertEq(QMath.floorDiv(-7, 2), -4);
        assertEq(QMath.ceilDiv(-7, 2), -3);
        assertEq(QMath.floorDiv(7, 2), 3);
        assertEq(QMath.ceilDiv(7, 2), 4);
        assertEq(QMath.mulDiv(7, 1, 2), 3);
        assertEq(QMath.mulDivUp(7, 1, 2), 4);
        assertEq(QMath.sqrtUp(2), 2);
        // Funding rate is the only truncation toward zero (DEC-02).
        assertEq(FundingMath.rate(0.62e18, 0.6e18), 231_481_481_481_481);
        assertEq(FundingMath.rate(0.55e18, 0.6e18), -231_481_481_481_481);
    }

    /// Shared pure-input smoke fixture: both lanes evaluate the same golden inputs.
    function test_sharedSmokeFixture() public pure {
        // G01: 17 lots @ 613.
        (L.Value memory b,) = L.fill(L.Value(0, 0), L.Value(0, 0), 17, 613, 0, 0);
        assertEq(b.cashQ, -10_421e18);
        // G02 / G03: endpoints and deficits in A (LedgerMath, CoverageMath) and B (MarginMath).
        int256[2] memory cash = [int256(-480_000_000e18), int256(700_000_000e18)];
        int256[2] memory lots = [int256(1_000_000), int256(-1_000_000)];
        for (uint256 i; i < 2; ++i) {
            (int256 a0, int256 a1) = L.endpoints(L.Value(int128(lots[i]), cash[i]));
            (int256 b0, int256 b1) = MarginMath.endpoints(cash[i], lots[i]);
            assertEq(a0, b0);
            assertEq(a1, b1);
            assertEq(L.equity(L.Value(int128(lots[i]), cash[i]), 6e17), MarginMath.markEquityQ(cash[i], lots[i], 6e17));
        }
        C.Orders memory none;
        (uint256 d0,) = C.deficits(L.Value(1_000_000, -480_000_000e18), none);
        assertEq(d0, 480_000_000e18);
        // G10: oversized ask YES deficit 35,000 atoms.
        (, uint256 d1) = C.deficits(L.Value(1000, 0), C.Orders(0, 0, 2300, 2300 * 550e18, 0));
        assertEq(d1, 35_000e18);
        // G16: funding quantization agrees between A FundingMath and B PricingMath.
        assertEq(FundingMath.rate(0.62e18, 0.6e18), PricingMath.fundingRate(0.62e18, 0.6e18));
        assertEq(FundingMath.rate(0.55e18, 0.6e18), PricingMath.fundingRate(0.55e18, 0.6e18));
    }

    function test_fundingRateFunctionsAgree(uint64 q, uint64 i) public pure {
        uint256 iw = bound(i, 1, 1e18 - 1);
        uint256 qw = bound(q, 0, 1e18);
        assertEq(FundingMath.rate(qw, iw), PricingMath.fundingRate(qw, iw));
    }

    function test_endpointFunctionsAgree(int128 c, int64 n) public pure {
        int256 lots = int256(n) % int256(1 << 40);
        (int256 a0, int256 a1) = L.endpoints(L.Value(int128(lots), int256(c)));
        (int256 b0, int256 b1) = MarginMath.endpoints(int256(c), lots);
        assertEq(a0, b0);
        assertEq(a1, b1);
    }
}
