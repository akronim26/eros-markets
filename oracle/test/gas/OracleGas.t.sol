// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {IAccountingPort} from "@eros-provisional/IAccountingPort.sol";
import {
    Ledger,
    MarketInput,
    Outcome,
    Phase,
    PanelLabel,
    PanelResult,
    Resolution,
    ReviewedProposal,
    RState,
    Sig,
    TrustSetInput
} from "../../src/types/OracleTypes.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";
import {IOptimisticOracleV3} from "../../src/interfaces/IOptimisticOracleV3.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {UmaAdapter} from "../../src/venues/UmaAdapter.sol";
import {ErosSandboxOracle} from "../../src/venues/ErosSandboxOracle.sol";
import {StubMarketFactory} from "../../src/testnet/StubMarketFactory.sol";
import {ClaimRenderer} from "../../src/libraries/ClaimRenderer.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RegistryFixture} from "../unit/RegistryFixture.sol";
import {MockKeystoneForwarderLite} from "../mocks/MockKeystoneForwarderLite.sol";
import {EngineHarness, SeamFactory, SeamFixture} from "../seam/EngineHarness.sol";

/// @dev Accepts any call and does nothing: the baseline a transaction pays before any execution.
contract Noop {
    fallback() external payable {}
}

interface IUmaFinder {
    function changeImplementationAddress(bytes32, address) external;
}

struct UmaUnsigned {
    uint256 rawValue;
}

interface IUmaStore {
    function setFinalFee(address, UmaUnsigned calldata) external;
}

interface IUmaAddressWhitelist {
    function addToWhitelist(address) external;
}

interface IUmaIdentifierWhitelist {
    function addSupportedIdentifier(bytes32) external;
}

/// @notice Task O18.1: one gas test per §6.9 call type, on the deployed stack: the real ResolutionOracle,
///         MarketRegistry and BondTreasury, the real UMA OOv3 (from artifacts) behind `UmaAdapter`, the
///         testnet `StubMarketFactory` engine and B's real `SettlementController` (O17.3 seam harness).
///         Each test makes one call on a state prepared in setUp and checks it against
///         `deployments/gas.json`: the transaction stays within the recorded `limit` (what every service sends,
///         plan §9), and its execution meets the §6.9 budget or stays within the excess recorded there with
///         its justification. `.gas-snapshot` records the tests.
/// @dev Monad charges the gas limit, so a call is measured as its own transaction would be: storage cold
///      (`vm.cool` on every contract it touches). Under the CI toolchain (Foundry 1.8.3, `isolate = true`)
///      the figure also includes the 21,000 intrinsic gas and the calldata of the call, which is what a
///      limit must cover. Execution is that figure minus the same call to an empty contract (`Noop`): the
///      §6.9 budgets are execution estimates. One timeline serves both engines: T is listing + 25 h and voidSecs 26 h (the real
///      engine needs T at least a day out and `T + 1 h <= listedAt + voidSecs`).
contract OracleGasTest is RegistryFixture {
    uint64 internal constant SELECTOR = 2183018362218727504; // Monad testnet
    uint64 internal constant T = NOW + 25 hours;
    uint32 internal constant VOID_SECS = 26 hours;
    uint256 internal constant OI = 100_000;
    uint256 internal constant MAX_CLAIM = 16_384; // maxClaimBytes (§12.11)
    bytes32 internal constant WF = keccak256("eros-resolution-workflow");
    address internal constant ORG = address(0x0C4E);
    string internal constant URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    // §6.9 budgets
    uint256 internal constant ON_REPORT_BUDGET = 150_000;
    uint256 internal constant HALT_BUDGET = 200_000; // + the engine's halt()
    uint256 internal constant ENGINE_HALT = 72_000; // A's measurement with 1,024 accounts (§6.9)
    uint256 internal constant ASSERT_BUDGET = 600_000; // + claim bytes x 16
    uint256 internal constant FINALIZE_BUDGET = 250_000; // + the engine's settle (~50k)
    uint256 internal constant ENGINE_SETTLE = 50_000;
    uint256 internal constant TX_LIMIT = 30_000_000; // createMarket must stay below it

    MockUSDC internal token;
    StubMarketFactory internal stubFactory;
    SeamFactory internal seamFactory;
    BondTreasury internal treasury;
    ResolutionOracle internal ro;
    MarketRegistry internal reg;
    UmaAdapter internal adapter;
    IOptimisticOracleV3 internal oov3;
    MockKeystoneForwarderLite internal keystone;
    Noop internal noop;
    string internal gasJson;

    address internal guardian = makeAddr("guardian");
    address internal lister = makeAddr("lister");
    address internal attestor;
    uint256 internal attestorKey;
    address[] internal members;
    uint256[] internal memberKeys;

    bytes32 internal mReport; // feed, stub engine, L1Pending
    bytes32 internal mHalt; // feed, stub engine, listed, past T
    bytes32 internal mHaltReal; // feed, real engine, listed, past T
    bytes32 internal mAssert; // no feed, stub engine, 16 KiB claim, Proposed (not asserted)
    bytes32 internal mAssertSmall; // no feed, stub engine, default texts, Proposed (not asserted)
    bytes32 internal mFinalize; // no feed, stub engine, asserted on OOv3, liveness over
    bytes32 internal mFinalizeReal; // no feed, real engine, asserted on OOv3, liveness over

    function setUp() public {
        vm.chainId(10143);
        vm.warp(NOW);
        token = new MockUSDC();
        usdc = address(token);
        keystone = new MockKeystoneForwarderLite();
        noop = new Noop();
        gasJson = vm.readFile("deployments/gas.json");
        seamFactory = new SeamFactory();
        oov3 = _deployUma();
        address me = address(this);
        uint256 n = vm.getNonce(me);
        address treasuryAddr = vm.computeCreateAddress(me, n);
        address oracleAddr = vm.computeCreateAddress(me, n + 1);
        address registryAddr = vm.computeCreateAddress(me, n + 3); // after the stub factory (n + 2)
        treasury = new BondTreasury(usdc, oracleAddr, registryAddr, gov);
        ro = new ResolutionOracle(registryAddr, treasuryAddr, usdc, SELECTOR, gov, guardian);
        stubFactory = new StubMarketFactory(registryAddr);
        reg = new MarketRegistry(oracleAddr, treasuryAddr, address(stubFactory), usdc, gov, lister);
        require(address(treasury) == treasuryAddr && address(ro) == oracleAddr && address(reg) == registryAddr);
        seamFactory.setRegistry(address(reg));
        adapter = new UmaAdapter(oov3, usdc, address(ro), address(treasury));

        _committee();
        vm.startPrank(gov);
        ro.createTrustSet(_productionSet());
        ro.activateTrustSet(1);
        reg.setGlobals(_globals());
        reg.setProvider(HOST, true);
        reg.setProvider(OTHER, true);
        treasury.setLimits(1_000e6, 20);
        vm.stopPrank();
        token.mint(me, 100_000e6);
        token.approve(address(treasury), type(uint256).max);
        treasury.deposit(Ledger.ASSERTION, 10_000e6);

        mReport = _list("report", true, false, 0);
        mHalt = _list("halt", true, false, 0);
        mAssert = _list("assert", false, false, _maxRulesLen(false));
        mAssertSmall = _list("assert-small", false, false, 0);
        mFinalize = _list("finalize", false, false, 0);
        mHaltReal = _list("halt-real", true, true, 0);
        mFinalizeReal = _list("finalize-real", false, true, 0);

        vm.warp(T);
        ro.haltScheduled(mReport);
        _toProposed(mAssert);
        _toProposed(mAssertSmall);
        _toProposed(mFinalize);
        _toProposed(mFinalizeReal);
        assertTrue(ro.assertProposal(mFinalize));
        assertTrue(ro.assertProposal(mFinalizeReal));
        vm.warp(T + 400); // past the reviewed liveness (300 s); the report observes from T + 60
    }

    // ------------------------------------------------------------------ §6.9 call types

    /// `onReport` alone, from the production KeystoneForwarder (budget 150k).
    function test_gas_onReport() public {
        bytes memory data = abi.encodeCall(IReceiver.onReport, (_meta(), _report(mReport)));
        _check("onReport", address(keystone), address(ro), data, ON_REPORT_BUDGET);
        assertEq(uint8(ro.getResolution(mReport).state), uint8(RState.Proposed));
    }

    /// The forwarder's whole `report` (ERC-165 check, routing, transmission state) around `onReport`.
    /// The real KeystoneForwarder adds f + 1 ecrecovers (plan §6.9: forwarder overhead <= 90k).
    function test_gas_onReport_viaForwarder() public {
        MockKeystoneForwarderLite.Header memory h;
        h.executionId = keccak256("execution");
        h.workflowId = WF;
        h.workflowOwner = ORG;
        h.reportId = 0x0001;
        bytes memory data = abi.encodeCall(keystone.report, (address(ro), keystone.rawReport(h, _report(mReport))));
        _check("onReportViaForwarder", address(this), address(keystone), data, ON_REPORT_BUDGET + 90_000);
        assertEq(uint8(ro.getResolution(mReport).state), uint8(RState.Proposed));
    }

    /// `haltScheduled` on the testnet stub engine (budget 200k + the engine's own `halt()`).
    function test_gas_haltScheduled() public {
        uint256 engineHalt = _engineCallGas(mHalt, abi.encodeWithSignature("halt()"));
        emit log_named_uint("engine halt() alone (execution)", engineHalt);
        _check(
            "haltScheduled",
            address(this),
            address(ro),
            abi.encodeCall(ro.haltScheduled, (mHalt)),
            HALT_BUDGET + engineHalt
        );
        assertEq(uint8(ro.getResolution(mHalt).state), uint8(RState.L1Pending));
    }

    /// `haltScheduled` on B's real engine. Its `halt()` freezes the accounting through B's
    /// `MockAccountingPort` (3 scripted accounts, every call logged to storage), not A's accounting.
    function test_gas_haltScheduled_realEngine() public {
        uint256 engineHalt = _engineCallGas(mHaltReal, abi.encodeWithSignature("halt()"));
        emit log_named_uint("engine halt() alone (execution)", engineHalt);
        _check(
            "haltScheduledRealEngine",
            address(this),
            address(ro),
            abi.encodeCall(ro.haltScheduled, (mHaltReal)),
            HALT_BUDGET + engineHalt
        );
        assertEq(uint8(ro.getResolution(mHaltReal).state), uint8(RState.L1Pending));
    }

    /// `assertProposal` on the real OOv3 with the default texts (budget 600k + claim bytes x 16).
    function test_gas_assertProposal() public {
        uint256 claimBytes = ro.renderClaim(mAssertSmall).length;
        emit log_named_uint("claim bytes", claimBytes);
        _check(
            "assertProposal",
            address(this),
            address(ro),
            abi.encodeCall(ro.assertProposal, (mAssertSmall)),
            ASSERT_BUDGET + claimBytes * 16
        );
        assertTrue(ro.getResolution(mAssertSmall).assertionId != 0);
    }

    /// `assertProposal` on the real OOv3 with a claim at the 16 KiB maximum.
    function test_gas_assertProposal_maxClaim() public {
        uint256 claimBytes = ro.renderClaim(mAssert).length;
        assertGt(claimBytes, MAX_CLAIM - 512, "near the maximum (the bound assumes maximum-width fields)");
        assertLe(claimBytes, MAX_CLAIM);
        emit log_named_uint("claim bytes", claimBytes);
        _check(
            "assertProposalMaxClaim",
            address(this),
            address(ro),
            abi.encodeCall(ro.assertProposal, (mAssert)),
            ASSERT_BUDGET + claimBytes * 16
        );
        assertTrue(ro.getResolution(mAssert).assertionId != 0);
    }

    /// `finalizeMarket` settling on the real OOv3 and the stub engine (budget 250k + engine settle).
    function test_gas_finalizeMarket() public {
        _check(
            "finalizeMarket",
            address(this),
            address(ro),
            abi.encodeCall(ro.finalizeMarket, (mFinalize)),
            FINALIZE_BUDGET + ENGINE_SETTLE
        );
        assertEq(uint8(ro.getResolution(mFinalize).state), uint8(RState.Final));
    }

    /// `finalizeMarket` settling on the real OOv3 and B's real engine.
    function test_gas_finalizeMarket_realEngine() public {
        _check(
            "finalizeMarketRealEngine",
            address(this),
            address(ro),
            abi.encodeCall(ro.finalizeMarket, (mFinalizeReal)),
            FINALIZE_BUDGET + ENGINE_SETTLE
        );
        assertEq(uint8(ro.getResolution(mFinalizeReal).state), uint8(RState.Final));
    }

    /// `createMarket` with the testnet stub factory and the largest texts (budget: measure, < 30M per tx).
    function test_gas_createMarket() public {
        MarketInput memory m = _input("create", true, _maxRulesLen(true));
        bytes memory data = abi.encodeCall(reg.createMarket, (m, SeamFixture.pack(usdc, gov), abi.encode(OI)));
        _check("createMarket", lister, address(reg), data, TX_LIMIT);
    }

    /// `createMarket` deploying B's real engine (the mainnet factory deploys the real engine too).
    function test_gas_createMarket_realEngine() public {
        vm.prank(gov);
        reg.setFactory(address(seamFactory));
        MarketInput memory m = _input("create-real", true, _maxRulesLen(true));
        bytes memory data = abi.encodeCall(reg.createMarket, (m, SeamFixture.pack(usdc, gov), ""));
        _check("createMarketRealEngine", lister, address(reg), data, TX_LIMIT);
    }

    // ------------------------------------------------------------------ measurement

    /// Measures the call, then checks it against `deployments/gas.json` (`.calls.<key>`): the transaction
    /// within `limit`, and its execution within the §6.9 `budget` plus the `excessAllowed` recorded there
    /// (0 when absent) with its justification.
    function _check(string memory key, address from, address to, bytes memory data, uint256 budget) internal {
        uint256 used = _measure(from, to, data);
        uint256 base = _measure(from, address(noop), data);
        uint256 execution = used - base;
        string memory k = string.concat(".calls.", key);
        uint256 limit = stdJson.readUint(gasJson, string.concat(k, ".limit"));
        uint256 excess = vm.keyExistsJson(gasJson, string.concat(k, ".excessAllowed"))
            ? stdJson.readUint(gasJson, string.concat(k, ".excessAllowed"))
            : 0;
        emit log_named_uint(string.concat(key, " transaction"), used);
        emit log_named_uint(string.concat(key, " execution"), execution);
        emit log_named_uint(string.concat(key, " budget"), budget);
        emit log_named_uint(string.concat(key, " limit"), limit);
        assertLe(used, limit, string.concat(key, ": above its gas.json limit"));
        assertLe(execution, budget + excess, string.concat(key, ": above its section 6.9 budget"));
    }

    /// Execution gas of one engine call made by the oracle (its only authorized caller), on a snapshot
    /// that is then reverted (the engine's part of a "N + engine call" budget).
    function _engineCallGas(bytes32 id, bytes memory data) internal returns (uint256 used) {
        address engine = reg.getMarketCore(id).engine;
        uint256 snap = vm.snapshotState();
        vm.cool(engine);
        used = _measure(address(ro), engine, data) - _measure(address(ro), address(noop), data);
        vm.revertToState(snap);
        vm.cool(engine);
    }

    /// Gas of one call from `from` with every contract's storage cold; the calldata is built before.
    function _measure(address from, address to, bytes memory data) internal returns (uint256 used) {
        vm.cool(address(ro));
        vm.cool(address(reg));
        vm.cool(address(treasury));
        vm.cool(address(adapter));
        vm.cool(address(oov3));
        vm.cool(address(token));
        vm.cool(address(keystone));
        vm.cool(address(noop));
        if (from != address(this)) vm.prank(from);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = to.call(data);
        used = before - gasleft();
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    // ------------------------------------------------------------------ setup flows

    function _list(string memory name, bool feed, bool realEngine, uint256 rulesLen) internal returns (bytes32 id) {
        if (realEngine) {
            vm.prank(gov);
            reg.setFactory(address(seamFactory));
        }
        MarketInput memory m = _input(name, feed, rulesLen);
        id = m.marketId;
        vm.prank(lister);
        address engine = reg.createMarket(m, SeamFixture.pack(usdc, gov), abi.encode(OI));
        if (realEngine) {
            EngineHarness e = EngineHarness(engine);
            for (uint32 t = 1; t <= 3; ++t) {
                e.mockSetAccount(t, 1e24, 0);
            }
            e.mockScriptFreeze(IAccountingPort.FreezeResult(0, 0, OI, 0, 3, 0, keccak256("tariff"), keccak256("state")));
            e.mockScriptFinish(IAccountingPort.FinishResult(true, false, 1_220_000_000, 480_000_000));
            vm.prank(gov);
            reg.setFactory(address(stubFactory));
        }
    }

    function _input(string memory name, bool feed, uint256 rulesLen) internal view returns (MarketInput memory m) {
        m = feed ? _market() : _noFeed();
        m.marketId = keccak256(bytes(name));
        m.tau = uint64(block.timestamp) + 25 hours;
        m.windowStart = uint64(block.timestamp);
        m.windowEnd = m.tau;
        m.voidSecs = VOID_SECS;
        m.uma.bondCurrency = usdc;
        if (rulesLen != 0) m.rules = string(_filled(rulesLen));
    }

    /// The rules length that brings the market's worst-case rendered claim to exactly 16 KiB (a feed
    /// market's bound includes its substituted Layer 1 URL).
    function _maxRulesLen(bool feed) internal view returns (uint256) {
        MarketInput memory m = _market();
        uint256 urlLen = feed ? bytes("https://api.example-sports.com/v1/events/evt_1").length : 0;
        uint256 base = ClaimRenderer.worstCaseLength(m.claimTemplate, bytes(m.question).length, 0, urlLen);
        return MAX_CLAIM - base;
    }

    /// Halted at T; the panel finds no validated category (Review); the committee proposes NO.
    function _toProposed(bytes32 id) internal {
        ro.haltScheduled(id);
        Resolution memory r = ro.getResolution(id);
        PanelResult memory p;
        p.marketId = id;
        p.phase = uint8(Phase.POST_T);
        p.labels = [uint8(PanelLabel.NO), uint8(PanelLabel.NO), uint8(PanelLabel.NO)];
        p.calibratedBps = [uint16(9_500), uint16(9_500), uint16(9_500)];
        p.evidenceHash = keccak256("snapshot");
        p.evidenceURIHash = keccak256(bytes(URI));
        p.gateHash = reg.getMarketCore(id).gateHash;
        p.trustSetId = r.trustSetId;
        p.deadline = uint64(block.timestamp + 1 hours);
        ro.submitPanelResult(id, p, URI, _sign(attestorKey, ro.hashPanelResult(p)));
        ReviewedProposal memory q;
        q.marketId = id;
        q.outcome = uint8(Outcome.NO);
        q.evidenceHash = keccak256("snapshot");
        q.evidenceURIHash = keccak256(bytes(URI));
        q.noteHash = keccak256("note");
        q.trustSetId = r.trustSetId;
        q.deadline = uint64(block.timestamp + 1 hours);
        bytes32 d = ro.hashReviewedProposal(q);
        Sig[] memory s = new Sig[](2);
        s[0] = Sig(members[0], _sign(memberKeys[0], d));
        s[1] = Sig(members[1], _sign(memberKeys[1], d));
        ro.submitReviewedProposal(id, q, URI, s);
    }

    function _report(bytes32 id) internal view returns (bytes memory) {
        return abi.encode(uint8(1), SELECTOR, address(ro), id, uint8(1), T + 60, keccak256("3"), reg.getSpecHash(id));
    }

    function _meta() internal pure returns (bytes memory) {
        return abi.encodePacked(WF, bytes10(0), ORG, bytes2(0x0001));
    }

    // ------------------------------------------------------------------ fixtures

    /// Real UMA: Finder, Store (final fee 1 USDC), whitelists, OOv3 with the team-gated sandbox DVM. The
    /// 0.8.16 contracts are loaded from their artifact files: a run filtered to this file (the O18.1
    /// check) does not compile `test/uma/UmaImports.sol`, so `deployCode("Finder.sol:Finder")` would not
    /// find them. They exist after any full `forge build` (CI builds before it tests).
    function _deployUma() internal returns (IOptimisticOracleV3 o) {
        address finder = deployCode("out/Finder.sol/Finder.json");
        address store = deployCode("out/Store.sol/Store.json", abi.encode(uint256(0), uint256(0), address(0)));
        address awl = deployCode("out/AddressWhitelist.sol/AddressWhitelist.json");
        address iwl = deployCode("out/IdentifierWhitelist.sol/IdentifierWhitelist.json");
        ErosSandboxOracle dvm = new ErosSandboxOracle(address(0x7EA));
        IUmaFinder(finder).changeImplementationAddress("Store", store);
        IUmaFinder(finder).changeImplementationAddress("CollateralWhitelist", awl);
        IUmaFinder(finder).changeImplementationAddress("IdentifierWhitelist", iwl);
        IUmaFinder(finder).changeImplementationAddress("Oracle", address(dvm));
        IUmaAddressWhitelist(awl).addToWhitelist(usdc);
        IUmaIdentifierWhitelist(iwl).addSupportedIdentifier("ASSERT_TRUTH");
        IUmaStore(store).setFinalFee(usdc, UmaUnsigned(1e6));
        o = IOptimisticOracleV3(
            deployCode("out/OptimisticOracleV3.sol/OptimisticOracleV3.json", abi.encode(finder, usdc, uint64(7200)))
        );
        vm.prank(address(0x7EA));
        dvm.setRequester(address(o));
    }

    function _productionSet() internal view returns (TrustSetInput memory t) {
        t.forwarder = address(keystone);
        t.production = true;
        t.workflowIds = [WF, bytes32(0)];
        t.workflowOwner = ORG;
        t.runnerAttestor = attestor;
        t.committee = members;
        t.threshold = 2;
        t.watchdog = address(0x3D06); // the watchdog EOA
        t.venue = address(adapter);
    }

    function _committee() internal {
        (attestor, attestorKey) = makeAddrAndKey("attestor");
        string[3] memory names = ["member-a", "member-b", "member-c"];
        for (uint256 i; i < 3; ++i) {
            (address a, uint256 k) = makeAddrAndKey(names[i]);
            members.push(a);
            memberKeys.push(k);
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (members[j] < members[i]) {
                    (members[i], members[j]) = (members[j], members[i]);
                    (memberKeys[i], memberKeys[j]) = (memberKeys[j], memberKeys[i]);
                }
            }
        }
    }

    function _filled(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = "r";
        }
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
