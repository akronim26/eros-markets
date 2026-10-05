// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";
import {IOptimisticOracleV3} from "../../src/interfaces/IOptimisticOracleV3.sol";
import {UmaAdapter} from "../../src/venues/UmaAdapter.sol";
import {ErosSandboxOracle} from "../../src/venues/ErosSandboxOracle.sol";

interface IFinderExt {
    function changeImplementationAddress(bytes32, address) external;
}

struct UnsignedExt {
    uint256 rawValue;
}

interface IStoreExt {
    function setFinalFee(address, UnsignedExt calldata) external;
}

interface IAddrWlExt {
    function addToWhitelist(address) external;
}

interface IIdWlExt {
    function addSupportedIdentifier(bytes32) external;
}

/// @notice Task O13.3: extended real-UMA cases (plan §6.7, §11.1, V-U4) beyond the A2 suite: a
///         permissionless asserter (asserter = payer = caller), payer and asserter as separate roles,
///         the treasury's `disputeFor`, a settlement done directly on OOv3 then read through `statusOf`
///         (B.4 note), a never-answered dispute (`settleAssertion` reverts while `trySettle` returns
///         false), and a changed final fee reaching `minimumBond` only after `syncUmaParams`.
/// @dev Same stack as B.8: real Finder, Store, AddressWhitelist, IdentifierWhitelist and OOv3 (solc
///      0.8.16, from artifacts) with ErosSandboxOracle as the DVM. Payouts follow OOv3's own rule:
///      the winner of a dispute receives 2B minus the 50% burn of B.
contract UmaVenueExtendedTest is Test {
    MockUSDC internal usdc;
    IOptimisticOracleV3 internal oov3;
    ErosSandboxOracle internal dvm;
    UmaAdapter internal adapter;
    address internal store;

    address internal team = address(0x7EA);
    address internal oracle = address(0x0AC1E); // stands in for ResolutionOracle
    address internal treasury = address(0x7EA5); // stands in for BondTreasury
    address internal proposer = makeAddr("permissionless proposer");
    address internal publicDisputer = makeAddr("public disputer");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant MARKET = keccak256("m1");
    uint64 internal constant LIVENESS = 7200;

    function setUp() public {
        usdc = new MockUSDC();
        // UMA is built separately with solc 0.8.16; use its artifact path because
        // selective test compilation may omit it from Foundry's artifact-name map.
        address finder = deployCode("out/Finder.sol/Finder.json");
        store = deployCode("out/Store.sol/Store.json", abi.encode(uint256(0), uint256(0), address(0)));
        address awl = deployCode("out/AddressWhitelist.sol/AddressWhitelist.json");
        address iwl = deployCode("out/IdentifierWhitelist.sol/IdentifierWhitelist.json");
        dvm = new ErosSandboxOracle(team);
        IFinderExt(finder).changeImplementationAddress("Store", store);
        IFinderExt(finder).changeImplementationAddress("CollateralWhitelist", awl);
        IFinderExt(finder).changeImplementationAddress("IdentifierWhitelist", iwl);
        IFinderExt(finder).changeImplementationAddress("Oracle", address(dvm));
        IAddrWlExt(awl).addToWhitelist(address(usdc));
        IIdWlExt(iwl).addSupportedIdentifier("ASSERT_TRUTH");
        IStoreExt(store).setFinalFee(address(usdc), UnsignedExt(1e6)); // minimum bond 2 USDC
        oov3 = IOptimisticOracleV3(
            deployCode(
                "out/OptimisticOracleV3.sol/OptimisticOracleV3.json", abi.encode(finder, address(usdc), uint64(7200))
            )
        );
        vm.prank(team);
        dvm.setRequester(address(oov3));
        adapter = new UmaAdapter(oov3, address(usdc), oracle, treasury);
        usdc.mint(treasury, 1_000_000e6);
        usdc.mint(proposer, 1_000_000e6);
        usdc.mint(publicDisputer, 1_000_000e6);
    }

    // ------------------------------------------------------------------ helpers

    /// The oracle asserts with `payer` funding the bond (it approved the adapter) and `asserter` repaid.
    function _assert(address payer, address asserter, uint256 bond) internal returns (bytes32 id) {
        vm.prank(payer);
        usdc.approve(address(adapter), bond);
        vm.prank(oracle);
        id = adapter.assertOutcome(
            IAssertionVenue.AssertRequest(MARKET, bytes("Eros Markets market ... YES"), asserter, payer, LIVENESS, bond)
        );
    }

    /// The treasury disputes through the adapter with its own float (BondTreasury.disputeViaVenue).
    function _treasuryDispute(bytes32 id, uint256 bond) internal {
        vm.prank(treasury);
        usdc.approve(address(adapter), bond);
        vm.prank(treasury);
        adapter.disputeFor(id, treasury, treasury);
    }

    function _answer(bytes32 id, int256 price) internal {
        IOptimisticOracleV3.Assertion memory a = oov3.getAssertion(id);
        bytes32 req = dvm.requestId("ASSERT_TRUTH", a.assertionTime, _stamp(id, a.asserter));
        vm.prank(team);
        dvm.pushPriceByRequestId(req, price);
    }

    // OOv3 ancillary stamp: "assertionId:<hex64>,ooAsserter:<hex40>" (AncillaryData lib, lowercase, no 0x)
    function _stamp(bytes32 id, address asserter) internal pure returns (bytes memory) {
        return abi.encodePacked(
            "assertionId:", _hexNo0x(abi.encodePacked(id)), ",ooAsserter:", _hexNo0x(abi.encodePacked(asserter))
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

    // ------------------------------------------------------------------ permissionless asserter

    function test_permissionlessAsserterIsPaidBack() public {
        uint256 before = usdc.balanceOf(proposer);
        bytes32 id = _assert(proposer, proposer, 5e6);
        assertEq(usdc.balanceOf(proposer), before - 5e6, "the caller paid its own bond");
        assertEq(usdc.balanceOf(treasury), 1_000_000e6, "the treasury is not involved");
        IAssertionVenue.AssertionStatus memory s = adapter.statusOf(id);
        assertEq(s.asserter, proposer);
        assertEq(s.bond, 5e6);
        assertEq(s.expiresAt, block.timestamp + LIVENESS);
        vm.warp(block.timestamp + LIVENESS);
        assertTrue(adapter.trySettle(id));
        assertEq(usdc.balanceOf(proposer), before, "bond returned to the proposer");
    }

    function test_payerFundsAndAsserterIsRepaid() public {
        uint256 payerBefore = usdc.balanceOf(treasury);
        bytes32 id = _assert(treasury, proposer, 5e6); // separate roles
        assertEq(usdc.balanceOf(treasury), payerBefore - 5e6, "pulled from the payer");
        assertEq(adapter.statusOf(id).asserter, proposer);
        vm.warp(block.timestamp + LIVENESS);
        uint256 asserterBefore = usdc.balanceOf(proposer);
        adapter.trySettle(id);
        assertEq(usdc.balanceOf(proposer), asserterBefore + 5e6, "repaid to the asserter");
        assertEq(usdc.balanceOf(treasury), payerBefore - 5e6, "not to the payer");
    }

    // ------------------------------------------------------------------ treasury disputeFor

    function test_treasuryDisputeWinsTwoBondsLessBurn() public {
        bytes32 id = _assert(proposer, proposer, 10e6);
        uint256 before = usdc.balanceOf(treasury);
        _treasuryDispute(id, 10e6);
        assertEq(usdc.balanceOf(treasury), before - 10e6, "the treasury posted the same bond");
        IAssertionVenue.AssertionStatus memory s = adapter.statusOf(id);
        assertTrue(s.disputed);
        assertEq(s.disputer, treasury);
        assertTrue(adapter.disputeSeen(id));
        _answer(id, 0); // the team (sandbox DVM) rules the assertion false
        assertTrue(adapter.trySettle(id));
        s = adapter.statusOf(id);
        assertTrue(s.settled && !s.truthful);
        assertEq(usdc.balanceOf(treasury), before - 10e6 + 20e6 - 5e6, "2B minus the 50% burn of B");
    }

    function test_treasuryDisputeLosesItsBond() public {
        bytes32 id = _assert(proposer, proposer, 10e6);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 proposerBefore = usdc.balanceOf(proposer);
        _treasuryDispute(id, 10e6);
        _answer(id, 1e18);
        assertTrue(adapter.trySettle(id));
        assertTrue(adapter.statusOf(id).truthful);
        assertEq(usdc.balanceOf(treasury), treasuryBefore - 10e6);
        assertEq(usdc.balanceOf(proposer), proposerBefore + 20e6 - 5e6, "the asserter wins 2B minus the burn");
    }

    /// Payer and disputer are separate roles: the bond comes from the payer, the winnings go to the
    /// disputer. The adapter keeps no allowance to OOv3 after asserting or disputing.
    function test_disputeFor_payerFundsDisputerWins() public {
        bytes32 id = _assert(proposer, proposer, 10e6);
        assertEq(usdc.allowance(address(adapter), address(oov3)), 0, "no allowance left after the assert");
        address payer = makeAddr("payer");
        address winner = makeAddr("winner");
        usdc.mint(payer, 10e6);
        vm.prank(payer);
        usdc.approve(address(adapter), 10e6);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.prank(treasury);
        adapter.disputeFor(id, payer, winner);
        assertEq(usdc.balanceOf(payer), 0, "pulled from the payer");
        assertEq(usdc.balanceOf(treasury), treasuryBefore, "not from the caller");
        assertEq(adapter.statusOf(id).disputer, winner);
        assertEq(usdc.allowance(address(adapter), address(oov3)), 0, "no allowance left after the dispute");
        _answer(id, 0);
        adapter.trySettle(id);
        assertEq(usdc.balanceOf(winner), 20e6 - 5e6, "the disputer receives 2B minus the burn");
    }

    function test_disputeForIsTreasuryOnly() public {
        bytes32 id = _assert(proposer, proposer, 5e6);
        address[3] memory callers = [oracle, stranger, proposer];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(UmaAdapter.OnlyTreasury.selector);
            adapter.disputeFor(id, treasury, treasury);
        }
    }

    function test_disputeForUnknownAssertion() public {
        vm.prank(treasury);
        vm.expectRevert(UmaAdapter.UnknownAssertion.selector);
        adapter.disputeFor(keccak256("unknown"), treasury, treasury);
    }

    // ------------------------------------------------------------------ settled directly on OOv3

    function test_settledDirectlyOnOov3IsReadThroughStatus() public {
        bytes32 id = _assert(treasury, treasury, 5e6);
        vm.warp(block.timestamp + LIVENESS);
        vm.prank(stranger);
        oov3.settleAssertion(id); // anyone can settle on OOv3 itself
        assertFalse(adapter.trySettle(id), "nothing left to settle; never reverts");
        IAssertionVenue.AssertionStatus memory s = adapter.statusOf(id);
        assertTrue(s.settled && s.truthful, "the oracle must read status, not trySettle's return");
        assertTrue(adapter.resolveSeen(id), "OOv3 still called the adapter back");
        assertEq(usdc.balanceOf(treasury), 1_000_000e6, "the bond went back to the asserter");
    }

    // ------------------------------------------------------------------ never-answered dispute (V-U4)

    function test_neverAnsweredDispute_settleRevertsTrySettleDoesNot() public {
        bytes32 id = _assert(treasury, treasury, 5e6);
        vm.startPrank(publicDisputer);
        usdc.approve(address(oov3), 5e6);
        oov3.disputeAssertion(id, publicDisputer);
        vm.stopPrank();
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 365 days);
            vm.expectRevert(ErosSandboxOracle.NoPrice.selector);
            oov3.settleAssertion(id);
            assertFalse(adapter.trySettle(id));
        }
        IAssertionVenue.AssertionStatus memory s = adapter.statusOf(id);
        assertTrue(s.disputed && !s.settled);
        _answer(id, 1e18); // a late answer still settles it
        assertTrue(adapter.trySettle(id));
        assertTrue(adapter.statusOf(id).truthful);
    }

    function test_disputeAfterExpiryRefusedByOov3() public {
        bytes32 id = _assert(proposer, proposer, 5e6);
        vm.warp(block.timestamp + LIVENESS);
        vm.prank(treasury);
        usdc.approve(address(adapter), 5e6);
        vm.prank(treasury);
        vm.expectRevert("Assertion is expired");
        adapter.disputeFor(id, treasury, treasury);
    }

    // ------------------------------------------------------------------ final fee and minimum bond

    function test_finalFeeChangeReachesMinimumBondAfterSync() public {
        assertEq(adapter.minimumBond(), 2e6);
        IStoreExt(store).setFinalFee(address(usdc), UnsignedExt(3e6));
        assertEq(adapter.minimumBond(), 2e6, "OOv3 caches the final fee");
        oov3.syncUmaParams(adapter.identifier(), address(usdc)); // anyone may sync
        assertEq(adapter.minimumBond(), 6e6, "2 x the new final fee");
        vm.prank(proposer);
        usdc.approve(address(adapter), 2e6);
        vm.prank(oracle);
        vm.expectRevert("Bond amount too low");
        adapter.assertOutcome(IAssertionVenue.AssertRequest(MARKET, "c", proposer, proposer, LIVENESS, 2e6));
        _assert(proposer, proposer, 6e6);
    }

    function test_bondCurrencyAndIdentifier() public view {
        assertEq(adapter.bondCurrency(), address(usdc));
        assertEq(adapter.identifier(), bytes32("ASSERT_TRUTH"));
        assertEq(adapter.identifier(), oov3.defaultIdentifier());
    }
}
