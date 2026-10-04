// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";
import {IOptimisticOracleV3} from "../../src/interfaces/IOptimisticOracleV3.sol";
import {UmaAdapter} from "../../src/venues/UmaAdapter.sol";
import {ErosSandboxOracle} from "../../src/venues/ErosSandboxOracle.sol";

interface IFinder {
    function changeImplementationAddress(bytes32, address) external;
}

struct Unsigned {
    uint256 rawValue;
}

interface IStoreLike {
    function setFinalFee(address, Unsigned calldata) external;
}

interface IAddrWl {
    function addToWhitelist(address) external;
}

interface IIdWl {
    function addSupportedIdentifier(bytes32) external;
}

/// Real UMA OOv3 (0.8.16, deployed from artifacts) + Eros adapter + team-gated sandbox oracle.
contract UmaVenueTest is Test {
    MockUSDC usdc;
    IOptimisticOracleV3 oov3;
    ErosSandboxOracle dvm;
    UmaAdapter adapter;
    address team = address(0x7EA);
    address oracle = address(0x0AC1E); // stands in for ResolutionOracle
    address treasury = address(0x7EA5); // stands in for BondTreasury
    address publicDisputer = address(0xD15);
    bytes32 constant MARKET = keccak256("m1");

    function setUp() public {
        usdc = new MockUSDC();
        address finder = deployCode("Finder.sol:Finder");
        address store = deployCode("Store.sol:Store", abi.encode(uint256(0), uint256(0), address(0)));
        address awl = deployCode("AddressWhitelist.sol:AddressWhitelist");
        address iwl = deployCode("IdentifierWhitelist.sol:IdentifierWhitelist");
        dvm = new ErosSandboxOracle(team);
        IFinder(finder).changeImplementationAddress("Store", store);
        IFinder(finder).changeImplementationAddress("CollateralWhitelist", awl);
        IFinder(finder).changeImplementationAddress("IdentifierWhitelist", iwl);
        IFinder(finder).changeImplementationAddress("Oracle", address(dvm));
        IAddrWl(awl).addToWhitelist(address(usdc));
        IIdWl(iwl).addSupportedIdentifier("ASSERT_TRUTH");
        IStoreLike(store).setFinalFee(address(usdc), Unsigned(1e6)); // 1 USDC final fee -> 2 USDC minimum bond
        oov3 = IOptimisticOracleV3(
            deployCode("OptimisticOracleV3.sol:OptimisticOracleV3", abi.encode(finder, address(usdc), uint64(7200)))
        );
        vm.prank(team);
        dvm.setRequester(address(oov3));
        adapter = new UmaAdapter(oov3, address(usdc), oracle, treasury);
        usdc.mint(treasury, 1_000_000e6);
        usdc.mint(publicDisputer, 1_000_000e6);
    }

    function _assert(uint256 bond) internal returns (bytes32 id) {
        vm.prank(treasury);
        usdc.approve(address(adapter), bond);
        vm.prank(oracle);
        id = adapter.assertOutcome(
            IAssertionVenue.AssertRequest(MARKET, bytes("Eros Markets market ... YES"), treasury, treasury, 7200, bond)
        );
    }

    function test_minimumBondIsTwiceFinalFee() public view {
        assertEq(adapter.minimumBond(), 2e6);
    }

    function test_undisputedTrueReturnsBondToTreasury() public {
        uint256 before = usdc.balanceOf(treasury);
        bytes32 id = _assert(1112e6);
        assertEq(usdc.balanceOf(treasury), before - 1112e6);
        assertFalse(adapter.trySettle(id), "cannot settle inside liveness");
        vm.warp(block.timestamp + 7200);
        assertTrue(adapter.trySettle(id));
        IAssertionVenue.AssertionStatus memory s = adapter.statusOf(id);
        assertTrue(s.settled && s.truthful && !s.disputed);
        assertEq(usdc.balanceOf(treasury), before, "OOv3 paid the asserter (treasury)");
        assertTrue(adapter.resolveSeen(id));
        assertEq(adapter.marketOf(id), MARKET);
    }

    function test_disputedFalsePaysDisputerAndOnlyTeamCanAnswer() public {
        bytes32 id = _assert(1112e6);
        vm.startPrank(publicDisputer);
        usdc.approve(address(oov3), 1112e6);
        oov3.disputeAssertion(id, publicDisputer);
        vm.stopPrank();
        assertTrue(adapter.statusOf(id).disputed);
        assertTrue(adapter.disputeSeen(id));
        // dispute requested with ancillary stamp; anyone but the team is refused
        bytes32 reqId = dvm.requestId("ASSERT_TRUTH", block.timestamp, _stamp(id));
        vm.expectRevert();
        dvm.pushPriceByRequestId(reqId, 1e18);
        assertFalse(adapter.trySettle(id), "DVM not answered: cannot settle, does not revert");
        vm.prank(team);
        dvm.pushPriceByRequestId(reqId, 0);
        uint256 before = usdc.balanceOf(publicDisputer);
        assertTrue(adapter.trySettle(id));
        IAssertionVenue.AssertionStatus memory s = adapter.statusOf(id);
        assertTrue(s.settled && !s.truthful);
        assertEq(usdc.balanceOf(publicDisputer), before + 2 * 1112e6 - 556e6, "2B minus 50% burn");
    }

    function test_neverAnsweredDisputeStaysUnsettled() public {
        bytes32 id = _assert(5e6);
        vm.startPrank(publicDisputer);
        usdc.approve(address(oov3), 5e6);
        oov3.disputeAssertion(id, publicDisputer);
        vm.stopPrank();
        vm.warp(block.timestamp + 365 days);
        assertFalse(adapter.trySettle(id));
        assertFalse(adapter.statusOf(id).settled);
    }

    function test_callbacksFromStrangersDoNothingAndNeverRevert() public {
        bytes32 id = _assert(5e6);
        adapter.assertionDisputedCallback(id);
        adapter.assertionResolvedCallback(id, true);
        assertFalse(adapter.disputeSeen(id));
        assertFalse(adapter.resolveSeen(id));
    }

    function test_onlyOracleCanAssert() public {
        vm.expectRevert(UmaAdapter.OnlyOracle.selector);
        adapter.assertOutcome(IAssertionVenue.AssertRequest(MARKET, "x", treasury, treasury, 7200, 5e6));
    }

    // OOv3 ancillary stamp: "assertionId:<hex64>,ooAsserter:<hex40>" (AncillaryData lib, lowercase, no 0x)
    function _stamp(bytes32 id) internal view returns (bytes memory) {
        return abi.encodePacked(
            "assertionId:", _hexNo0x(abi.encodePacked(id)), ",ooAsserter:", _hexNo0x(abi.encodePacked(treasury))
        );
    }

    function _hexNo0x(bytes memory b) internal pure returns (bytes memory out) {
        bytes16 h = "0123456789abcdef";
        out = new bytes(b.length * 2);
        for (uint256 i; i < b.length; ++i) {
            out[2 * i] = h[uint8(b[i]) >> 4];
            out[2 * i + 1] = h[uint8(b[i]) & 15];
        }
    }
}
