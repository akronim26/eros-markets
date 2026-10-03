pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {HaltView, IResolutionEngine, SettlementView} from "../../src/interfaces/IResolutionIngress.sol";
import {
    TestnetFixtureControl,
    TestnetRiskCollateral,
    TestnetResolutionAuthority
} from "../mocks/integration/TestnetRiskFixtures.sol";

contract TestnetResolutionEngineRecorder is IResolutionEngine {
    address public lastCaller;
    uint8 public lastBinaryOutcome;
    uint256 public haltCalls;
    uint256 public binaryCalls;
    uint256 public invalidCalls;
    bool public rejectCalls;

    error RecordingRejected();

    function setRejectCalls(bool reject) external {
        rejectCalls = reject;
    }

    function halt() external returns (HaltView memory snapshot) {
        if (rejectCalls) revert RecordingRejected();
        lastCaller = msg.sender;
        ++haltCalls;
        snapshot.halted = true;
        snapshot.snapshotId = keccak256("testnet-fixture-recorder");
    }

    function settle(uint8 binaryOutcome) external returns (bool) {
        if (rejectCalls) revert RecordingRejected();
        lastCaller = msg.sender;
        lastBinaryOutcome = binaryOutcome;
        ++binaryCalls;
        return true;
    }

    function settleInvalid() external returns (bool) {
        if (rejectCalls) revert RecordingRejected();
        lastCaller = msg.sender;
        ++invalidCalls;
        return true;
    }

    function materializeScheduledHalt() external pure returns (HaltView memory snapshot) {
        snapshot.halted = true;
    }

    function getHaltSnapshot() external pure returns (HaltView memory snapshot) {
        snapshot.halted = true;
    }

    function getSettlementStatus() external pure returns (SettlementView memory status) {
        status.halted = true;
    }
}

contract TestnetRiskFixturesTest is Test {
    address constant CONTROLLER = address(0xA110CE);
    address constant OUTSIDER = address(0xBAD);
    address constant TRADER = address(0xBEEF);

    TestnetRiskCollateral collateral;
    TestnetResolutionAuthority authority;
    TestnetResolutionEngineRecorder recorder;

    function setUp() public {
        vm.chainId(31337);
        collateral = new TestnetRiskCollateral(CONTROLLER);
        authority = new TestnetResolutionAuthority(CONTROLLER);
        recorder = new TestnetResolutionEngineRecorder();
    }

    function testOnlyControllerCanMintSixDecimalAtoms() public {
        assertEq(collateral.decimals(), 6);
        assertEq(collateral.totalSupply(), 0);
        vm.prank(OUTSIDER);
        vm.expectRevert(TestnetFixtureControl.FixtureUnauthorized.selector);
        collateral.mint(TRADER, 123_000_001);
        vm.prank(CONTROLLER);
        collateral.mint(TRADER, 123_000_001);
        assertEq(collateral.balanceOf(TRADER), 123_000_001);
        assertEq(collateral.totalSupply(), 123_000_001);
        vm.prank(TRADER);
        collateral.transfer(OUTSIDER, 1);
        assertEq(collateral.balanceOf(TRADER), 123_000_000);
        assertEq(collateral.balanceOf(OUTSIDER), 1);
    }

    function testZeroControllerAndMintRecipientRejected() public {
        vm.expectRevert(TestnetFixtureControl.InvalidFixtureController.selector);
        new TestnetRiskCollateral(address(0));
        vm.expectRevert(TestnetFixtureControl.InvalidFixtureController.selector);
        new TestnetResolutionAuthority(address(0));
        vm.prank(CONTROLLER);
        vm.expectRevert(TestnetRiskCollateral.InvalidTestRecipient.selector);
        collateral.mint(address(0), 1);
        assertEq(collateral.totalSupply(), 0);
    }

    function testFixturesRejectMainnetAndUnknownChains() public {
        uint256[3] memory forbidden = [uint256(1), uint256(143), uint256(99999)];
        for (uint256 chainIndex; chainIndex < forbidden.length; ++chainIndex) {
            vm.chainId(forbidden[chainIndex]);
            vm.expectRevert(TestnetFixtureControl.UnsupportedFixtureChain.selector);
            new TestnetRiskCollateral(CONTROLLER);
            vm.expectRevert(TestnetFixtureControl.UnsupportedFixtureChain.selector);
            new TestnetResolutionAuthority(CONTROLLER);
        }
    }

    function testFixturesAllowMonadTestnetAndLocalOnly() public {
        vm.chainId(10143);
        TestnetRiskCollateral testnetCollateral = new TestnetRiskCollateral(CONTROLLER);
        TestnetResolutionAuthority testnetAuthority = new TestnetResolutionAuthority(CONTROLLER);
        assertEq(testnetCollateral.controller(), CONTROLLER);
        assertEq(testnetAuthority.controller(), CONTROLLER);
        assertEq(collateral.controller(), CONTROLLER);
        assertEq(authority.controller(), CONTROLLER);
    }

    function testAuthorityBindOnceRequiresControllerAndDeployedEngine() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(TestnetFixtureControl.FixtureUnauthorized.selector);
        authority.bind(recorder);
        vm.startPrank(CONTROLLER);
        vm.expectRevert(TestnetResolutionAuthority.InvalidFixtureEngine.selector);
        authority.bind(IResolutionEngine(address(0)));
        vm.expectRevert(TestnetResolutionAuthority.InvalidFixtureEngine.selector);
        authority.bind(IResolutionEngine(TRADER));
        authority.bind(recorder);
        assertEq(address(authority.engine()), address(recorder));
        vm.expectRevert(TestnetResolutionAuthority.FixtureAlreadyBound.selector);
        authority.bind(recorder);
        vm.stopPrank();
    }

    function testAuthorityRefusesUnboundCalls() public {
        vm.startPrank(CONTROLLER);
        vm.expectRevert(TestnetResolutionAuthority.FixtureNotBound.selector);
        authority.halt();
        vm.expectRevert(TestnetResolutionAuthority.FixtureNotBound.selector);
        authority.finalize(1);
        vm.expectRevert(TestnetResolutionAuthority.FixtureNotBound.selector);
        authority.finalizeInvalid();
        vm.stopPrank();
    }

    function testOnlyControllerCanHaltOrFinalize() public {
        vm.prank(CONTROLLER);
        authority.bind(recorder);
        vm.startPrank(OUTSIDER);
        vm.expectRevert(TestnetFixtureControl.FixtureUnauthorized.selector);
        authority.halt();
        vm.expectRevert(TestnetFixtureControl.FixtureUnauthorized.selector);
        authority.finalize(1);
        vm.expectRevert(TestnetFixtureControl.FixtureUnauthorized.selector);
        authority.finalizeInvalid();
        vm.stopPrank();
        assertEq(recorder.haltCalls() + recorder.binaryCalls() + recorder.invalidCalls(), 0);
    }

    function testAuthorityForwardsBinaryAndInvalidSeparatelyAndPropagatesFailure() public {
        vm.startPrank(CONTROLLER);
        authority.bind(recorder);
        HaltView memory snapshot = authority.halt();
        assertTrue(snapshot.halted);
        assertEq(snapshot.snapshotId, keccak256("testnet-fixture-recorder"));
        assertTrue(authority.finalize(0));
        assertEq(recorder.lastBinaryOutcome(), 0);
        assertTrue(authority.finalize(1));
        assertEq(recorder.lastBinaryOutcome(), 1);
        assertTrue(authority.finalizeInvalid());
        vm.expectRevert(TestnetResolutionAuthority.InvalidBinaryOutcome.selector);
        authority.finalize(2);
        recorder.setRejectCalls(true);
        vm.expectRevert(TestnetResolutionEngineRecorder.RecordingRejected.selector);
        authority.finalize(1);
        vm.stopPrank();
        assertEq(recorder.lastCaller(), address(authority));
        assertEq(recorder.haltCalls(), 1);
        assertEq(recorder.binaryCalls(), 2);
        assertEq(recorder.invalidCalls(), 1);
    }
}
