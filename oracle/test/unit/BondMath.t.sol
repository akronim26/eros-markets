// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Path, UMAConfig} from "../../src/types/OracleTypes.sol";
import {BondMath} from "../../src/libraries/BondMath.sol";
import {VoidBound} from "../../src/libraries/VoidBound.sol";

/// @notice Task O10.4: VoidBound and BondMath against the C.7 vectors in `vectors/`, plus fuzz checks.
contract BondMathTest is Test {
    using stdJson for string;

    // ------------------------------------------------------------------ vectors

    function test_voidBound_productionAndTestnet() public view {
        string memory j = vm.readFile("vectors/voidbound.json");
        assertEq(VoidBound.minVoidSecs(_inputs(j, ".production")), j.readUint(".production.expectedSecs"));
        assertEq(VoidBound.minVoidSecs(_inputs(j, ".testnet")), j.readUint(".testnet.expectedSecs"));
        assertEq(j.readUint(".production.expectedSecs"), 3_837_600);
        assertEq(j.readUint(".testnet.expectedSecs"), 6_000);
    }

    function test_bond_c7Vector() public view {
        string memory j = vm.readFile("vectors/bond.json");
        uint256 b = BondMath.bond(
            j.readUint(".vectors[0].oiHaltLots"),
            j.readUint(".vectors[0].minBond"),
            uint16(j.readUint(".vectors[0].bondBps")),
            j.readUint(".vectors[0].venueMinimumBond")
        );
        assertEq(b, j.readUint(".vectors[0].expectedAtoms"));
        assertEq(b, 222_400_000);
    }

    // ------------------------------------------------------------------ VoidBound units

    function test_voidBound_noFeedIgnoresL1Timeout() public pure {
        VoidBound.Inputs memory i = _testnet();
        i.hasFeed = false;
        assertEq(VoidBound.minVoidSecs(i), 6_000 - 300);
        i.l1TimeoutSecs = type(uint32).max;
        assertEq(VoidBound.minVoidSecs(i), 6_000 - 300, "T_L1 unused without a feed");
    }

    function test_voidBound_maxInputsDoNotOverflow() public pure {
        VoidBound.Inputs memory i = VoidBound.Inputs(
            true,
            type(uint32).max,
            type(uint32).max,
            type(uint64).max,
            type(uint8).max,
            type(uint32).max,
            type(uint32).max,
            type(uint32).max,
            type(uint32).max
        );
        assertGt(VoidBound.minVoidSecs(i), 0);
    }

    // ------------------------------------------------------------------ BondMath units

    function test_bond_floorsApply() public pure {
        assertEq(BondMath.bond(0, 2e6, 1112, 0), 2e6, "minBond");
        assertEq(BondMath.bond(0, 0, 1112, 2e6), 2e6, "venue minimum");
        assertEq(BondMath.bond(100_000, 2e6, 1112, 2e6), 11_120_000, "testnet demo cap: 100 claims -> 11.12 USDC");
    }

    function test_bond_roundsUp() public pure {
        // 1 lot = 1,000 atoms; 1 bps of that is 0.1 atom, rounded up to 1.
        assertEq(BondMath.bond(1, 0, 1, 0), 1);
        // 7 lots at 1,112 bps: 7,000 × 1,112 / 10,000 = 778.4 -> 779.
        assertEq(BondMath.bond(7, 0, 1112, 0), 779);
    }

    function test_bond_fromUmaConfig() public pure {
        UMAConfig memory u;
        u.minBond = 2e6;
        u.bondBps = 1112;
        assertEq(BondMath.bond(2_000_000, u, 2e6), 222_400_000);
    }

    function test_bond_overflowReverts() public {
        vm.expectRevert();
        this.bondExternal(type(uint256).max / 100, 0, 1112, 0);
    }

    // ------------------------------------------------------------------ liveness

    function test_liveness_table() public pure {
        UMAConfig memory u;
        u.livenessL1 = 7200;
        u.livenessAuto = 7300;
        u.livenessReviewed = 86400;
        assertEq(BondMath.liveness(Path.L1, u, true), 7200);
        assertEq(BondMath.liveness(Path.L2_AUTO, u, true), 7300);
        assertEq(BondMath.liveness(Path.L1, u, false), 86400, "stale watchdog -> reviewed");
        assertEq(BondMath.liveness(Path.L2_AUTO, u, false), 86400, "stale watchdog -> reviewed");
        assertEq(BondMath.liveness(Path.REVIEWED, u, true), 86400);
        assertEq(BondMath.liveness(Path.PERMISSIONLESS, u, true), 86400);
    }

    function test_liveness_noPathReverts() public {
        UMAConfig memory u;
        vm.expectRevert(BondMath.NoPath.selector);
        this.livenessExternal(Path.NONE, u, true);
    }

    function test_watchdogFreshness() public pure {
        uint64 nowTs = 1_800_000_000;
        assertTrue(BondMath.isWatchdogFresh(nowTs, nowTs - 900, 900, false), "exactly max age is fresh");
        assertFalse(BondMath.isWatchdogFresh(nowTs, nowTs - 901, 900, false), "older than max age is stale");
        assertFalse(BondMath.isWatchdogFresh(nowTs, nowTs, 900, true), "revoked is stale");
        assertFalse(BondMath.isWatchdogFresh(nowTs, 0, 900, false), "never sent a heartbeat");
        assertFalse(BondMath.isWatchdogFresh(nowTs, nowTs + 1, 900, false), "future heartbeat is not trusted");
    }

    // ------------------------------------------------------------------ fuzz

    /// The proportional term is the exact ceiling: never below `bondBps` of the exposure and less than
    /// one atom above it.
    function testFuzz_bond_ceilNeverUnderSizes(uint64 oiLots, uint16 bps) public pure {
        uint256 b = BondMath.bond(oiLots, 0, bps, 0);
        uint256 scaled = uint256(oiLots) * 1000 * bps;
        assertGe(b * 10_000, scaled, "never under-sized");
        if (b > 0) assertLt((b - 1) * 10_000, scaled, "at most one atom of rounding");
    }

    function testFuzz_bond_floorsAndMonotone(uint64 oiLots, uint64 more, uint16 bps, uint64 minBond, uint64 venueMin)
        public
        pure
    {
        uint256 b = BondMath.bond(oiLots, minBond, bps, venueMin);
        assertGe(b, minBond);
        assertGe(b, venueMin);
        assertGe(BondMath.bond(uint256(oiLots) + more, minBond, bps, venueMin), b, "monotone in OI");
        if (bps < type(uint16).max) assertGe(BondMath.bond(oiLots, minBond, bps + 1, venueMin), b, "monotone in bps");
    }

    /// Raising any one input never lowers the bound; adding a feed never lowers it either.
    function testFuzz_voidBound_monotoneInEachInput(VoidBound.Inputs memory i, uint8 which, uint32 delta) public pure {
        uint256 base = VoidBound.minVoidSecs(i);
        VoidBound.Inputs memory j = i;
        uint8 w = which % 9;
        if (w == 0) {
            j.hasFeed = true;
        } else if (w == 1) {
            j.l1TimeoutSecs = _add32(i.l1TimeoutSecs, delta);
        } else if (w == 2) {
            j.l2DeadlineSecs = _add32(i.l2DeadlineSecs, delta);
        } else if (w == 3) {
            j.livenessReviewed =
                i.livenessReviewed > type(uint64).max - delta ? type(uint64).max : i.livenessReviewed + delta;
        } else if (w == 4) {
            j.dvmMaxRolls = i.dvmMaxRolls == type(uint8).max ? i.dvmMaxRolls : i.dvmMaxRolls + 1;
        } else if (w == 5) {
            j.dvmRoundSecs = _add32(i.dvmRoundSecs, delta);
        } else if (w == 6) {
            j.reviewTargetSecs = _add32(i.reviewTargetSecs, delta);
        } else if (w == 7) {
            j.retryWindowSecs = _add32(i.retryWindowSecs, delta);
        } else {
            j.voidSlackSecs = _add32(i.voidSlackSecs, delta);
        }
        assertGe(VoidBound.minVoidSecs(j), base);
    }

    // ------------------------------------------------------------------ helpers

    function bondExternal(uint256 oiLots, uint256 minBond, uint16 bps, uint256 venueMin)
        external
        pure
        returns (uint256)
    {
        return BondMath.bond(oiLots, minBond, bps, venueMin);
    }

    function livenessExternal(Path p, UMAConfig memory u, bool fresh) external pure returns (uint64) {
        return BondMath.liveness(p, u, fresh);
    }

    function _add32(uint32 a, uint32 d) internal pure returns (uint32) {
        return a > type(uint32).max - d ? type(uint32).max : a + d;
    }

    function _testnet() internal pure returns (VoidBound.Inputs memory) {
        return VoidBound.Inputs(true, 300, 600, 300, 0, 300, 600, 300, 600);
    }

    function _inputs(string memory j, string memory p) internal pure returns (VoidBound.Inputs memory i) {
        require(j.readUint(string.concat(p, ".aMax")) == 3, "vectors assume A_MAX = 3");
        i.hasFeed = j.readUint(string.concat(p, ".tL1")) > 0;
        i.l1TimeoutSecs = uint32(j.readUint(string.concat(p, ".tL1")));
        i.l2DeadlineSecs = uint32(j.readUint(string.concat(p, ".tL2")));
        i.livenessReviewed = uint64(j.readUint(string.concat(p, ".tLive")));
        i.dvmMaxRolls = uint8(j.readUint(string.concat(p, ".rMax")));
        i.dvmRoundSecs = uint32(j.readUint(string.concat(p, ".tRound")));
        i.reviewTargetSecs = uint32(j.readUint(string.concat(p, ".tR")));
        i.retryWindowSecs = uint32(j.readUint(string.concat(p, ".tRetry")));
        i.voidSlackSecs = uint32(j.readUint(string.concat(p, ".tSlack")));
    }
}
