pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LocalBookRiskSmoke} from "../../script/LocalBookRiskSmoke.s.sol";

contract LocalBookRiskSmokeTest is Test {
    function testLocalSmokeCompletesRealBookTradeAndCashSettlement() public {
        vm.chainId(31337);
        vm.warp(1_000_000);
        vm.setEnv("LOCAL_SMOKE_SENDER", vm.toString(address(this)));
        LocalBookRiskSmoke smoke = new LocalBookRiskSmoke();
        smoke.run();
    }

    function testLocalSmokeCannotRunOnPublicTestnet() public {
        vm.chainId(10143);
        LocalBookRiskSmoke smoke = new LocalBookRiskSmoke();
        vm.expectRevert(bytes("local chain only: mock collateral and oracle"));
        smoke.run();
    }
}
