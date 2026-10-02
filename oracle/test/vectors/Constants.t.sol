// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RState} from "../../src/types/OracleTypes.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";

/// @notice Task O02.2 (plan Appendix C.7). Pins the ABI constants the CRE workflow and the services
///         hard-code. The C.7 vectors in `vectors/` are asserted through the libraries that use them
///         (SigLib, FeedSpecLib, BondMath/VoidBound) and later from TypeScript (O20, O30).
contract ConstantsTest is Test {
    using stdJson for string;

    string internal eip;

    function setUp() public {
        eip = vm.readFile("vectors/eip712.json");
    }

    // ------------------------------------------------------------------ ABI constants

    function test_receiverInterfaceId() public pure {
        assertEq(type(IReceiver).interfaceId, bytes4(0x805f2132));
        assertEq(IReceiver.onReport.selector, bytes4(0x805f2132), "single-function interface: id == selector");
    }

    function test_resolutionRequestedTopic() public pure {
        assertEq(
            IResolutionOracle.ResolutionRequested.selector,
            0xa3af2aef1d2a3c4b347e31fedf3782adb4c12febbd7961c698f034aed1a93a13
        );
    }

    function test_l1PendingIsThree() public pure {
        assertEq(uint8(RState.L1Pending), 3, "the CRE workflow hard-codes STATE_L1_PENDING = 3");
    }

    function test_getL1JobSelector() public pure {
        assertEq(IResolutionOracle.getL1Job.selector, bytes4(0xad3a62cf));
    }

    function test_typehashes() public view {
        assertEq(keccak256(bytes(eip.readString(".typeString.PanelResult"))), eip.readBytes32(".typehash.PanelResult"));
        assertEq(
            keccak256(bytes(eip.readString(".typeString.ReviewedProposal"))),
            eip.readBytes32(".typehash.ReviewedProposal")
        );
        assertEq(
            eip.readBytes32(".typehash.PanelResult"), 0x69db7560f727032b47f7c3e6e9c198309778224bf26d820414042f3952f7d905
        );
        assertEq(
            eip.readBytes32(".typehash.ReviewedProposal"),
            0x859e8252aa8c9e5c1f41c429345599a5fbb3c1c5664602fff262b2ff0e856f57
        );
    }
}
