// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Timelock} from "solady/accounts/Timelock.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {GovernanceOp} from "../../script/GovernanceOp.sol";

/// @dev The governance scripts' encoder, made concrete.
contract OpEncoder is GovernanceOp {}

/// @notice Task O19.4: the Timelock recipe of plan §12.5 (V-R8). Solady's Timelock initialized with the step 1
///         arguments of `DeployOracle` (delay 300 s, admin 0, the team Safe proposes and cancels, anyone
///         executes): the scripts' encoding equals the §12.5 cast recipe byte for byte; only the Safe proposes;
///         execution before the delay is refused; an unrelated address executes after it; the operation then
///         reads Done and cannot run twice; a change of role needs the Timelock itself.
contract TimelockRecipeTest is Test {
    bytes32 internal constant MODE = 0x0100000000007821000100000000000000000000000000000000000000000000;
    uint256 internal constant DELAY = 300;

    // §12.5 cast recipe, run on 2 Oct 2026 with ORACLE = 0x…AA, SIM_RELAYER = 0x…BB, SALT = 1, predecessor 0:
    //   CALL=$(cast calldata "setSimRelayer(address,bool)" $SIM_RELAYER true)
    //   OPDATA=$(cast abi-encode "f(bytes32,bytes32)" $ZERO $SALT)
    //   EXEC=$(cast abi-encode "f((address,uint256,bytes)[],bytes)" "[($ORACLE,0,$CALL)]" $OPDATA)
    //   ID=$(cast keccak $(cast abi-encode "f(bytes32,bytes32)" $MODE $(cast keccak $EXEC)))
    bytes internal constant CAST_EXEC =
        hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000aa000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044ef908d8800000000000000000000000000000000000000000000000000000000000000bb000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001";
    bytes32 internal constant CAST_ID = 0xa5f8377336e0ab60699a242ddaf0b254dec5816360cc3e32a57474fb5517648f;

    OpEncoder internal enc;
    Timelock internal tl;
    ResolutionOracle internal ro;
    address internal safe = makeAddr("team safe");
    address internal stranger = makeAddr("unrelated executor");
    address internal relayer = makeAddr("sim relayer");

    function setUp() public {
        vm.chainId(10143);
        enc = new OpEncoder();
        tl = new Timelock();
        address[] memory proposers = new address[](1);
        address[] memory executors = new address[](1);
        address[] memory cancellers = new address[](1);
        (proposers[0], executors[0], cancellers[0]) = (safe, tl.OPEN_ROLE_HOLDER(), safe);
        tl.initialize(DELAY, address(0), proposers, executors, cancellers); // step 1 of §12.5
        ro = new ResolutionOracle(address(0x1), address(0x2), address(0x3), 1, address(tl), makeAddr("guardian"));
    }

    /// The scripts' `encodeOp` is the §12.5 cast recipe, and the id is the Timelock's own.
    function test_encodingMatchesTheCastRecipe() public view {
        GovernanceOp.Call[] memory calls = new GovernanceOp.Call[](1);
        calls[0] = GovernanceOp.Call(
            address(0xAA), 0, abi.encodeWithSignature("setSimRelayer(address,bool)", address(0xBB), true)
        );
        (bytes memory exec, bytes32 id) = enc.encodeOp(calls, bytes32(0), bytes32(uint256(1)));
        assertEq(exec, CAST_EXEC, "EXEC");
        assertEq(id, CAST_ID, "ID");
        assertEq(enc.MODE(), MODE);
    }

    /// Propose from the Safe, refuse before the delay, execute from an unrelated address after it.
    function test_recipe() public {
        (bytes memory exec, bytes32 id) = _op(relayer, 1);

        vm.prank(stranger);
        vm.expectRevert(); // only the proposer role
        tl.propose(MODE, exec, DELAY);
        vm.prank(safe);
        vm.expectRevert(); // below the minimum delay
        tl.propose(MODE, exec, DELAY - 1);

        vm.prank(safe);
        assertEq(tl.propose(MODE, exec, DELAY), id, "the Timelock's id is the recipe's");
        assertEq(uint8(tl.operationState(id)), uint8(Timelock.OperationState.Waiting));

        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(stranger);
        vm.expectRevert(); // not ready yet
        tl.execute(MODE, exec);
        assertFalse(ro.isSimRelayer(relayer));

        vm.warp(block.timestamp + 1);
        assertEq(uint8(tl.operationState(id)), uint8(Timelock.OperationState.Ready));
        vm.prank(stranger);
        tl.execute(MODE, exec);
        assertTrue(ro.isSimRelayer(relayer), "executed by the Timelock as governance");
        assertEq(uint8(tl.operationState(id)), uint8(Timelock.OperationState.Done));

        vm.prank(stranger);
        vm.expectRevert(); // done once
        tl.execute(MODE, exec);
    }

    /// The Safe can cancel a waiting operation; a cancelled operation never executes.
    function test_cancel() public {
        (bytes memory exec, bytes32 id) = _op(relayer, 2);
        vm.prank(safe);
        tl.propose(MODE, exec, DELAY);
        vm.prank(stranger);
        vm.expectRevert(); // only the canceller role
        tl.cancel(id);
        vm.prank(safe);
        tl.cancel(id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        tl.execute(MODE, exec);
        assertFalse(ro.isSimRelayer(relayer));
    }

    /// Admin 0: nobody grants a role directly, not even the Safe; the deployer kept nothing.
    function test_rolesOnlyThroughTheTimelock() public {
        assertTrue(tl.hasRole(safe, tl.PROPOSER_ROLE()));
        assertTrue(tl.hasRole(safe, tl.CANCELLER_ROLE()));
        assertTrue(tl.hasRole(tl.OPEN_ROLE_HOLDER(), tl.EXECUTOR_ROLE()));
        for (uint256 r; r <= tl.MAX_ROLE(); ++r) {
            assertFalse(tl.hasRole(address(this), r), "the deployer holds no role");
        }
        assertEq(tl.minDelay(), DELAY);
        uint256 proposer = tl.PROPOSER_ROLE();
        vm.prank(safe);
        vm.expectRevert();
        tl.setRole(stranger, proposer, true);
        assertFalse(tl.hasRole(stranger, proposer));
    }

    function _op(address r, uint256 salt) internal view returns (bytes memory exec, bytes32 id) {
        GovernanceOp.Call[] memory calls = new GovernanceOp.Call[](1);
        calls[0] = GovernanceOp.Call(address(ro), 0, abi.encodeCall(ro.setSimRelayer, (r, true)));
        (exec, id) = enc.encodeOp(calls, bytes32(0), bytes32(salt));
    }
}
