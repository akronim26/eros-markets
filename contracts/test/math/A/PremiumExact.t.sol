pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";

contract PremiumExactTest is Test {
    int256 private constant MAX_CASH = (int256(1) << 180) - 1;
    int128 private constant MAX_LOTS = int128(1) << 40;
    int256 private constant MAX_RATE = 1e18;

    function testMaximumCashAndSlopeExactCeilings() public pure {
        int128[4] memory lots = [MAX_LOTS, MAX_LOTS, -MAX_LOTS, -MAX_LOTS];
        int256[4] memory rates = [MAX_RATE, -MAX_RATE, MAX_RATE, -MAX_RATE];
        uint256[4] memory expected = [
            uint256(468262526375688259700890767837718218715742714342216012),
            468262526375688259700208663401968292793568362812914679,
            468262526375688259700544625288233181680273499441081790,
            468262526375688259701226729723983107602447850970383123
        ];
        for (uint256 index; index < expected.length; ++index) {
            P.Segment memory segment = P.Segment(-MAX_CASH, lots[index], rates[index], 123, 2123, 1123);
            assertEq(P.cumulative(segment, _boundaryTariff(), 3723), expected[index]);
            segment.principalCashQ = MAX_CASH;
            assertEq(P.cumulative(segment, _boundaryTariff(), 3723), 0);
        }
    }

    function testFractionalCrossingsAtMaximumSlope() public pure {
        uint256[4] memory expected = [
            uint256(138341125669082452449563480385610),
            159714817259990280473726141538951,
            138341125669082452323632061422898,
            159714817259990280263695674236774
        ];
        for (uint256 index; index < expected.length; ++index) {
            int128 lots = index < 2 ? MAX_LOTS : -MAX_LOTS;
            bool rising = index % 2 == 0;
            int256 rate = (lots > 0) == rising ? MAX_RATE - 1 : 1 - MAX_RATE;
            int256 cash = int256(lots) * rate * (rising ? int256(733) : int256(1733));
            cash += rising ? int256(17) : -int256(17);
            if (lots < 0) cash -= int256(lots) * 1000e18;
            P.Segment memory segment = P.Segment(cash, lots, rate, 123, 2999, 1123);
            assertEq(P.cumulative(segment, _boundaryTariff(), 3723), expected[index]);
        }
    }

    function testFundingStopAndSurchargeOrderExactCeilings() public pure {
        uint64[5] memory stops = [uint64(1001), 2001, 1734, 123, 3723];
        uint64[5] memory surcharges = [uint64(2001), 1001, 1734, 123, 3723];
        uint256[5] memory expected = [
            uint256(20179166666666666447),
            67568113425925925410,
            76113657407407406894,
            0,
            541915648148148144344
        ];
        for (uint256 index; index < expected.length; ++index) {
            P.Segment memory segment =
                P.Segment(733e18 + 17, 1, MAX_RATE - 1, 123, stops[index], surcharges[index]);
            assertEq(P.cumulative(segment, _boundaryTariff(), 3723), expected[index]);
        }
    }

    function testSubQuantumOutcomesAndSplitsRoundOnlyOnce() public pure {
        P.Segment memory segment = P.Segment(-1, 0, 0, 0, 1, 2);
        assertEq(P.cumulative(segment, P.Tariff(1, 1, 1), 3), 1);
        assertEq(P.cumulative(segment, P.Tariff(1, 1, 1), 0), 0);
        assertEq(P.cumulative(segment, P.Tariff(0, 0, 1), 3), 0);
    }

    function testFuzzExactIntegralAtIntegerCrossings(bytes32 seed) public pure {
        uint64 duration = uint64(uint256(seed) % 64) + 1;
        P.Segment memory segment = _fuzzSegment(uint256(seed), duration);
        P.Tariff memory tariff = P.Tariff(
            uint256(keccak256(abi.encode(seed, uint256(0)))) % (1e18 + 1),
            uint256(keccak256(abi.encode(seed, uint256(1)))) % (1e18 + 1),
            uint256(keccak256(abi.encode(seed, uint256(2)))) % (1e18 + 1)
        );
        uint64 until = segment.start + duration;
        uint256 exactNumerator = _perSecondIntegralNumerator(segment, tariff, until);
        uint256 expected = (exactNumerator + 172800e36 - 1) / 172800e36;
        assertEq(P.cumulative(segment, tariff, until), expected);
    }

    function _boundaryTariff() private pure returns (P.Tariff memory) {
        return P.Tariff(1e18 - 1, 1e18 - 3, 1e18 - 7);
    }

    function _fuzzSegment(uint256 seed, uint64 duration) private pure returns (P.Segment memory segment) {
        segment.lots = int128(int256((seed >> 16) % 1_000_000 + 1));
        if (seed & 1 != 0) segment.lots = -segment.lots;
        segment.rateQPerLotSec = seed & 2 != 0 ? -MAX_RATE : MAX_RATE;
        segment.start = 123;
        segment.fundingStop = segment.start + uint64((seed >> 40) % (duration + 1));
        segment.surchargeUntil = segment.start + uint64((seed >> 56) % (duration + 1));
        uint256 crossing = (seed >> 72) % (duration + 1);
        segment.principalCashQ = int256(segment.lots) * segment.rateQPerLotSec * int256(crossing);
        if (seed & 4 != 0) segment.principalCashQ -= int256(segment.lots) * 1000e18;
    }

    function _perSecondIntegralNumerator(P.Segment memory segment, P.Tariff memory tariff, uint64 until)
        private
        pure
        returns (uint256 numerator)
    {
        for (uint64 timestamp = segment.start; timestamp < until; ++timestamp) {
            int256 cashLeft = _cashAt(segment, timestamp);
            int256 cashRight = _cashAt(segment, timestamp + 1);
            uint256 endpointSum = (_positive(-cashLeft) + _positive(-cashRight)) * tariff.hazard0WadPerDay;
            int256 payoff = int256(segment.lots) * 1000e18;
            endpointSum += (_positive(-cashLeft - payoff) + _positive(-cashRight - payoff))
                * tariff.hazard1WadPerDay;
            numerator += endpointSum * (1e18 + tariff.loadWad) * (timestamp < segment.surchargeUntil ? 4 : 1);
        }
    }

    function _cashAt(P.Segment memory segment, uint64 timestamp) private pure returns (int256) {
        uint64 fundingUntil = timestamp < segment.fundingStop ? timestamp : segment.fundingStop;
        uint64 duration = fundingUntil > segment.start ? fundingUntil - segment.start : 0;
        return
            segment.principalCashQ - int256(segment.lots) * segment.rateQPerLotSec * int256(uint256(duration));
    }

    function _positive(int256 value) private pure returns (uint256) {
        return value > 0 ? uint256(value) : 0;
    }
}
