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
        vm.cool(address(h));
        uint256 firstStart = gasleft();
        uint32 firstId = registry.participantId(alice);
        uint256 firstGas = firstStart - gasleft();
        vm.cool(address(h));
        uint256 lastStart = gasleft();
        uint32 lastId = registry.participantId(address(101_023));
        uint256 lastGas = lastStart - gasleft();
        // Measure the registry calls, not the test framework's assertion machinery.
        assertEq(firstId, 1);
        assertEq(lastId, 1024);
        emit log_named_uint("cold-account first participant lookup", firstGas);
        emit log_named_uint("cold-account last participant lookup", lastGas);
        assertLe(lastGas, firstGas + 1000);
        // Monad charges 10,100 for a cold account and 8,100 for a cold storage page;
        // Prague charges 2,600 + 2,100. Keep the same constant-work comparison and
        // explicit network budgets, including dispatch overhead.
        // https://docs.monad.xyz/developer-essentials/opcode-pricing
        uint256 lookupBudget = vm.envOr("MONAD_GAS_CHECK", false) ? 20_000 : 10_000;
        assertLt(firstGas, lookupBudget);
        assertLt(lastGas, lookupBudget);
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
