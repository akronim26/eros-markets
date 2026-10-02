// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RState, FeedSpec} from "../../src/types/OracleTypes.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";

/// @notice Task O02.2 (plan Appendix C.7). Pins the ABI constants the CRE workflow and the services
///         hard-code, and checks that every committed C.7 vector in `vectors/` reproduces from its
///         inputs. Later tasks (O10, O16, O20, O30) assert the same files from their own code.
contract ConstantsTest is Test {
    using stdJson for string;

    string internal eip;
    string internal spec;
    string internal voidBound;
    string internal bond;

    function setUp() public {
        eip = vm.readFile("vectors/eip712.json");
        spec = vm.readFile("vectors/spechash.json");
        voidBound = vm.readFile("vectors/voidbound.json");
        bond = vm.readFile("vectors/bond.json");
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

    // ------------------------------------------------------------------ C.7 vectors reproduce

    function test_panelResultDigestP1() public view {
        uint256[] memory l = eip.readUintArray(".P1.labels");
        uint256[] memory c = eip.readUintArray(".P1.calibratedBps");
        uint8[3] memory labels = [uint8(l[0]), uint8(l[1]), uint8(l[2])];
        uint16[3] memory bps = [uint16(c[0]), uint16(c[1]), uint16(c[2])];
        bytes32 structHash = keccak256(
            abi.encode(
                eip.readBytes32(".typehash.PanelResult"),
                _pre(".P1.preimages.marketId"),
                uint8(eip.readUint(".P1.phase")),
                uint8(eip.readUint(".P1.attempt")),
                keccak256(abi.encode(labels)),
                keccak256(abi.encode(bps)),
                _pre(".P1.preimages.evidenceHash"),
                _pre(".P1.preimages.evidenceURIHash"),
                _pre(".P1.preimages.gateHash"),
                uint8(eip.readUint(".P1.flags")),
                uint32(eip.readUint(".P1.trustSetId")),
                uint64(eip.readUint(".P1.deadline"))
            )
        );
        assertEq(_digest(structHash), eip.readBytes32(".P1.digest"));
        assertEq(eip.readBytes32(".P1.digest"), 0xc31506d1641a8f03330d1ba677ab016d51c96b1af48ae24d475b84413535b5bc);
    }

    function test_reviewedProposalDigestR1() public view {
        bytes32 structHash = keccak256(
            abi.encode(
                eip.readBytes32(".typehash.ReviewedProposal"),
                _pre(".R1.preimages.marketId"),
                uint8(eip.readUint(".R1.outcome")),
                _pre(".R1.preimages.evidenceHash"),
                _pre(".R1.preimages.evidenceURIHash"),
                _pre(".R1.preimages.noteHash"),
                uint8(eip.readUint(".R1.attempt")),
                uint8(eip.readUint(".R1.rejectedMask")),
                eip.readBool(".R1.early"),
                uint32(eip.readUint(".R1.trustSetId")),
                uint64(eip.readUint(".R1.deadline"))
            )
        );
        assertEq(_digest(structHash), eip.readBytes32(".R1.digest"));
        assertEq(eip.readBytes32(".R1.digest"), 0xc3e6776ea7d4164e5eae882701e26b5174ff4b13de6d6701ff360b4243a4301b);
    }

    function test_specHashOfB3FeedSpec() public view {
        string memory k = ".vectors[0].spec";
        FeedSpec memory s = FeedSpec({
            urlTemplate: spec.readString(string.concat(k, ".urlTemplate")),
            urlParam: spec.readString(string.concat(k, ".urlParam")),
            authRef: spec.readBytes32(string.concat(k, ".authRef")),
            finalPath: spec.readString(string.concat(k, ".finalPath")),
            finalValue: spec.readString(string.concat(k, ".finalValue")),
            valuePath: spec.readString(string.concat(k, ".valuePath")),
            valueType: uint8(spec.readUint(string.concat(k, ".valueType"))),
            decimals: uint8(spec.readUint(string.concat(k, ".decimals"))),
            op: uint8(spec.readUint(string.concat(k, ".op"))),
            target: spec.readString(string.concat(k, ".target")),
            bufferSecs: uint32(spec.readUint(string.concat(k, ".bufferSecs"))),
            l1TimeoutSecs: uint32(spec.readUint(string.concat(k, ".l1TimeoutSecs")))
        });
        assertEq(keccak256(abi.encode(s)), spec.readBytes32(".vectors[0].specHash"));
        assertEq(
            spec.readBytes32(".vectors[0].specHash"), 0x50661463875a7d2a9c9ca378a3d4d1ee141fef1d82091ecd7ab36829ea7f80cd
        );
    }

    function test_voidBounds() public view {
        assertEq(_voidBound(".production"), voidBound.readUint(".production.expectedSecs"));
        assertEq(_voidBound(".testnet"), voidBound.readUint(".testnet.expectedSecs"));
        assertEq(voidBound.readUint(".production.expectedSecs"), 3_837_600, "1,066 h");
        assertEq(voidBound.readUint(".testnet.expectedSecs"), 6_000, "100 min");
    }

    function test_bondVector() public view {
        uint256 exposure = bond.readUint(".vectors[0].oiHaltLots") * 1000;
        uint256 bps = bond.readUint(".vectors[0].bondBps");
        uint256 b = (exposure * bps + 9_999) / 10_000; // ceil
        uint256 minBond = bond.readUint(".vectors[0].minBond");
        uint256 venueMin = bond.readUint(".vectors[0].venueMinimumBond");
        if (minBond > b) b = minBond;
        if (venueMin > b) b = venueMin;
        assertEq(b, bond.readUint(".vectors[0].expectedAtoms"));
        assertEq(b, 222_400_000, "222.4 USDC");
    }

    // ------------------------------------------------------------------ helpers

    function _pre(string memory key) internal view returns (bytes32) {
        return keccak256(bytes(eip.readString(key)));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(eip.readString(".domain.name"))),
                keccak256(bytes(eip.readString(".domain.version"))),
                eip.readUint(".domain.chainId"),
                eip.readAddress(".domain.verifyingContract")
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    function _voidBound(string memory p) internal view returns (uint256) {
        uint256 aMax = voidBound.readUint(string.concat(p, ".aMax"));
        return voidBound.readUint(string.concat(p, ".tL1")) + voidBound.readUint(string.concat(p, ".tL2")) + aMax
            * (voidBound.readUint(string.concat(p, ".tLive"))
                + (voidBound.readUint(string.concat(p, ".rMax")) + 2)
                * voidBound.readUint(string.concat(p, ".tRound"))) + (aMax - 1)
            * (voidBound.readUint(string.concat(p, ".tR")) + voidBound.readUint(string.concat(p, ".tRetry")))
            + voidBound.readUint(string.concat(p, ".tSlack"));
    }
}
