// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {NativeOutcomeVault} from "@eros/native/NativeOutcomeVault.sol";
import {Globals, MarketInput, Outcome, RState} from "../../src/types/OracleTypes.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {SpotMarketFactory} from "../../src/native/SpotMarketFactory.sol";
import {ListNativeSpotMarket} from "../../script/native/ListNativeSpotMarket.s.sol";

interface IERC20Lite {
    function mint(address, uint256) external;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice NM-S06: the spot listing against a fork of the deployed Monad testnet stack (real registry,
///         oracle, treasury, sandbox UMA venue, template market). Runs the SpotMarketGovernance calls as
///         the Timelock, lists as the lister, binds a fresh vault and resolves YES through the sim path.
///         Skipped unless `NATIVE_FORK_RPC` is set. Nothing is broadcast.
contract NativeSpotForkTest is Test {
    using stdJson for string;

    string internal constant DIR = "listings/native/nba-gsw-mia-20261105-spot/";

    MarketRegistry internal reg;
    ResolutionOracle internal ro;
    address internal timelock;
    address internal usdc;
    address internal relayer = makeAddr("fork relayer");
    bytes32 internal id;
    uint64 internal t;
    string internal d;
    string internal listing;

    function test_fork_listAndResolveOnTestnetState() public {
        string memory rpc = vm.envOr("NATIVE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        d = vm.readFile("deployments/monad-testnet.json");
        listing = vm.readFile(string.concat(DIR, "listing.json"));
        reg = MarketRegistry(d.readAddress(".contracts.MarketRegistry.address"));
        ro = ResolutionOracle(d.readAddress(".contracts.ResolutionOracle.address"));
        timelock = d.readAddress(".roles.timelock");
        _enable();
        NativeOutcomeVault vault = _listAndBind();
        _resolveYes(vault);
        // OP=restore leaves the perp factory in place for future perp listings.
        vm.prank(timelock);
        reg.setFactory(d.readAddress(".contracts.MarketFactory.address"));
        assertEq(reg.factory(), d.readAddress(".contracts.MarketFactory.address"));
    }

    /// SpotMarketGovernance OP=enable, executed as the Timelock.
    function _enable() internal {
        SpotMarketFactory factory = new SpotMarketFactory(address(reg));
        string[] memory hosts = listing.readStringArray(".evidenceHosts");
        string memory f = vm.readFile(listing.readString(".feed"));
        vm.startPrank(timelock);
        for (uint256 i; i < hosts.length; ++i) {
            if (!reg.providerAllowed(hosts[i])) reg.setProvider(hosts[i], true);
        }
        reg.setAuthRef(f.readBytes32(".feed.authRef"), true);
        Globals memory g = reg.globals();
        g.bufferMaxSecs = 7_200;
        g.l1TimeoutMaxSecs = 21_600;
        reg.setGlobals(g);
        reg.setFactory(address(factory));
        ro.setSimRelayer(relayer, true);
        vm.stopPrank();
    }

    function _listAndBind() internal returns (NativeOutcomeVault vault) {
        string memory params = vm.readFile("deployments/native/nba-gsw-mia-20261105-spot.params.json");
        usdc = params.readAddress(".collateral");
        id = params.readBytes32(".marketId");
        t = uint64(params.readUint(".scheduledT"));
        string memory rules = params.readString(".rules");
        vault = new NativeOutcomeVault(address(reg), id, usdc, keccak256(bytes(rules)), t, params.readUint(".issuanceCap"),
            "Y", "N");
        string memory dep = string.concat("{\"registry\":\"", vm.toString(address(reg)), "\",\"marketId\":\"",
            vm.toString(id), "\",\"scheduledT\":", vm.toString(t), "}");
        ListNativeSpotMarket script = new ListNativeSpotMarket();
        MarketInput memory m = script.marketInput(reg, dep, listing, rules);
        vm.prank(reg.lister());
        address anchor = reg.createMarket(m, _listing(usdc), "");
        assertEq(vault.bindMarket(), anchor);
        address alice = makeAddr("fork alice");
        IERC20Lite(usdc).mint(alice, 10e6);
        vm.startPrank(alice);
        IERC20Lite(usdc).approve(address(vault), type(uint256).max);
        vault.split(10e6, alice);
        vm.stopPrank();
    }

    function _resolveYes(NativeOutcomeVault vault) internal {
        vm.warp(t);
        assertTrue(ro.haltScheduled(id));
        assertFalse(vault.issuanceOpen());
        vm.warp(t + 7_200);
        assertTrue(ro.requestResolution(id));
        bytes memory report = abi.encode(uint8(1), uint64(2183018362218727504), address(ro), id, uint8(Outcome.YES),
            uint64(block.timestamp), keccak256("fork evidence"), reg.getSpecHash(id));
        vm.prank(ro.simForwarder(), relayer);
        ro.onReport("", report);
        assertTrue(ro.assertProposal(id));
        assertEq(uint8(ro.getResolution(id).state), uint8(RState.Proposed));
        assertEq(ro.bondFor(id), 2e6);
    }

    function _listing(address usdc) internal pure returns (IMarketConfig.Listing memory l) {
        l.token = usdc;
    }
}
