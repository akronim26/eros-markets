// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {ErosSandboxOracle} from "../../src/venues/ErosSandboxOracle.sol";

/// @notice Task O13.1: the TESTNET ONLY sandbox DVM (plan §6.7, D14, Appendix B.5): only the owner
///         answers, one answer per request, requests from anyone but the bound OOv3 are ignored, and
///         `setRequester` is one-shot (reverting with `AlreadyAnswered`, ADJ-23).
/// @dev The request id is recomputed here from its B.5 definition, keccak256(abi.encode(identifier,
///      time, ancillaryData)).
contract ErosSandboxOracleTest is Test {
    bytes32 internal constant ID = "ASSERT_TRUTH";
    uint256 internal constant TIME = 1_800_000_000;
    bytes internal constant ANC = "assertionId:ab,ooAsserter:cd";

    address internal team = makeAddr("team safe");
    address internal oov3 = makeAddr("oov3");
    address internal stranger = makeAddr("stranger");
    ErosSandboxOracle internal dvm;

    function setUp() public {
        dvm = new ErosSandboxOracle(team);
        vm.prank(team);
        dvm.setRequester(oov3);
    }

    function _reqId() internal pure returns (bytes32) {
        return keccak256(abi.encode(ID, TIME, ANC));
    }

    function _request() internal {
        vm.prank(oov3);
        dvm.requestPrice(ID, TIME, ANC);
    }

    // ------------------------------------------------------------------ setup

    function test_ownerAndRequester() public view {
        assertEq(dvm.owner(), team);
        assertEq(dvm.requester(), oov3);
        assertEq(dvm.requestId(ID, TIME, ANC), _reqId());
    }

    function test_setRequester_onlyOwner() public {
        ErosSandboxOracle fresh = new ErosSandboxOracle(team);
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        fresh.setRequester(oov3);
    }

    function test_setRequester_oneShot() public {
        vm.prank(team);
        vm.expectRevert(ErosSandboxOracle.AlreadyAnswered.selector); // ADJ-23: the prototype's error name
        dvm.setRequester(stranger);
        assertEq(dvm.requester(), oov3);
    }

    // ------------------------------------------------------------------ requests

    function test_request_fromOov3Recorded() public {
        vm.expectEmit(address(dvm));
        emit ErosSandboxOracle.PriceRequested(_reqId(), ID, TIME, ANC);
        _request();
        (bool requested, bool answered,, bytes32 identifier, uint256 time,) = dvm.requests(_reqId());
        assertTrue(requested);
        assertFalse(answered);
        assertEq(identifier, ID);
        assertEq(time, TIME);
    }

    function test_request_fromAnyoneElseIgnored() public {
        vm.recordLogs();
        vm.prank(stranger);
        dvm.requestPrice(ID, TIME, ANC); // no revert, no record, no event
        assertEq(vm.getRecordedLogs().length, 0);
        (bool requested,,,,,) = dvm.requests(_reqId());
        assertFalse(requested);
        vm.prank(team);
        vm.expectRevert(ErosSandboxOracle.NotRequested.selector);
        dvm.pushPriceByRequestId(_reqId(), 1e18);
    }

    function test_request_beforeRequesterIsSetIgnored() public {
        ErosSandboxOracle fresh = new ErosSandboxOracle(team);
        vm.prank(oov3);
        fresh.requestPrice(ID, TIME, ANC);
        (bool requested,,,,,) = fresh.requests(_reqId());
        assertFalse(requested);
    }

    function test_request_repeatIgnored() public {
        _request();
        vm.recordLogs();
        _request();
        assertEq(vm.getRecordedLogs().length, 0, "requested once");
    }

    // ------------------------------------------------------------------ answers

    function test_answer_ownerOnly() public {
        _request();
        address[2] memory callers = [stranger, oov3];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Ownable.Unauthorized.selector);
            dvm.pushPriceByRequestId(_reqId(), 1e18);
        }
        assertFalse(dvm.hasPrice(ID, TIME, ANC));
    }

    function test_answer_true() public {
        _request();
        assertFalse(dvm.hasPrice(ID, TIME, ANC));
        vm.expectRevert(ErosSandboxOracle.NoPrice.selector);
        dvm.getPrice(ID, TIME, ANC);
        vm.expectEmit(address(dvm));
        emit ErosSandboxOracle.PricePushed(_reqId(), 1e18);
        vm.prank(team);
        dvm.pushPriceByRequestId(_reqId(), 1e18);
        assertTrue(dvm.hasPrice(ID, TIME, ANC));
        assertEq(dvm.getPrice(ID, TIME, ANC), 1e18);
    }

    function test_answer_false() public {
        _request();
        vm.prank(team);
        dvm.pushPriceByRequestId(_reqId(), 0);
        assertTrue(dvm.hasPrice(ID, TIME, ANC));
        assertEq(dvm.getPrice(ID, TIME, ANC), 0);
    }

    function test_answer_oncePerRequest() public {
        _request();
        vm.startPrank(team);
        dvm.pushPriceByRequestId(_reqId(), 0);
        vm.expectRevert(ErosSandboxOracle.AlreadyAnswered.selector);
        dvm.pushPriceByRequestId(_reqId(), 1e18);
        vm.stopPrank();
        assertEq(dvm.getPrice(ID, TIME, ANC), 0, "the first answer stands");
    }

    function test_answer_unknownRequest() public {
        vm.prank(team);
        vm.expectRevert(ErosSandboxOracle.NotRequested.selector);
        dvm.pushPriceByRequestId(keccak256("unknown"), 1e18);
    }

    function test_answer_followsOwnershipTransfer() public {
        _request();
        address deployer = address(this);
        ErosSandboxOracle d = new ErosSandboxOracle(deployer); // deploy script: owner = deployer first
        d.setRequester(oov3);
        d.transferOwnership(team); // then hand it to the team Safe (§12.4 step 8)
        vm.prank(oov3);
        d.requestPrice(ID, TIME, ANC);
        vm.expectRevert(Ownable.Unauthorized.selector);
        d.pushPriceByRequestId(_reqId(), 1e18);
        vm.prank(team);
        d.pushPriceByRequestId(_reqId(), 1e18);
        assertEq(d.getPrice(ID, TIME, ANC), 1e18);
    }
}
