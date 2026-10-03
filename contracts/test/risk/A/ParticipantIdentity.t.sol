pragma solidity ^0.8.30;

import {AccountingTestBase} from "./AccountingTestBase.sol";

interface IParticipantIdentity {
    function participantId(address owner) external view returns (uint32);
}

contract ParticipantIdentityTest is AccountingTestBase {
    function testIdsExistAtFirstAllocationAndMatchRegistryOrder() public view {
        IParticipantIdentity registry = IParticipantIdentity(address(h));
        assertEq(registry.participantId(alice), 1);
        assertEq(registry.participantId(bob), 2);
        assertEq(registry.participantId(lp), 0);
        assertEq(registry.participantId(address(0)), 0);
        assertEq(h.participants(registry.participantId(alice) - 1), alice);
        assertEq(h.participants(registry.participantId(bob) - 1), bob);
    }

    function testRegistrationAndReallocationNeverReassignIds() public {
        IParticipantIdentity registry = IParticipantIdentity(address(h));
        h.registerOnly(alice);
        _fund(alice, 1e6, false);
        _trade();
        assertEq(registry.participantId(alice), 1);
        assertEq(registry.participantId(bob), 2);
        assertEq(h.participantCount(), 2);
        _assertLedger();
    }

    function testFullRegistryIdsRemainBoundedAndRejectedJoinLeavesNoId() public {
        IParticipantIdentity registry = IParticipantIdentity(address(h));
        for (uint256 index = 2; index < 1024; ++index) {
            address owner = address(uint160(100_000 + index));
            h.registerOnly(owner);
            assertEq(registry.participantId(owner), index + 1);
            assertEq(h.participants(index), owner);
        }
        address rejectedOwner = address(200_000);
        vm.expectRevert();
        h.registerOnly(rejectedOwner);
        assertEq(registry.participantId(rejectedOwner), 0);
        assertFalse(h.registered(rejectedOwner));
        assertEq(h.participantCount(), 1024);
        uint256 firstStart = gasleft();
        assertEq(registry.participantId(alice), 1);
        uint256 firstGas = firstStart - gasleft();
        uint256 lastStart = gasleft();
        assertEq(registry.participantId(address(101_023)), 1024);
        uint256 lastGas = lastStart - gasleft();
        assertLe(lastGas, firstGas + 1000);
        assertLt(lastGas, 10_000);
    }

    function testInvalidRegistrationLeavesCanonicalIdentityUnchanged() public {
        vm.expectRevert();
        h.registerOnly(address(0));
        IParticipantIdentity registry = IParticipantIdentity(address(h));
        assertEq(registry.participantId(address(0)), 0);
        assertEq(registry.participantId(alice), 1);
        assertEq(registry.participantId(bob), 2);
        assertEq(h.participantCount(), 2);
    }
}
