pragma solidity ^0.8.30;

import {Timelock} from "solady/accounts/Timelock.sol";
import {Book} from "@eros/Book.sol";
import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {MarketFactory} from "@eros/factory/MarketFactory.sol";
import {EngineCodeStore} from "@eros/factory/EngineCodeStore.sol";
import {EngineCodeParts} from "@eros/factory/EngineCodeParts.sol";
import {CollateralVault} from "@eros/vaults/CollateralVault.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IBookRiskHooks} from "@eros/interfaces/IBookRiskHooks.sol";
import {MarginMath} from "@eros/math/MarginMath.sol";
import {RiskFixture} from "@eros-test/math/B/B011.t.sol";
import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {ListingFixture} from "@eros-test/risk/B/B019.t.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {KeeperRouter} from "../../src/KeeperRouter.sol";
import {RolloverBatcher} from "../../src/integration/RolloverBatcher.sol";
import {RegistryFixture} from "../../test/unit/RegistryFixture.sol";
import {MockAssertionVenue} from "../../test/mocks/MockAssertionVenue.sol";
import {
    Ledger,
    MarketInput,
    Outcome,
    Phase,
    PanelResult,
    ReviewedProposal,
    Resolution,
    RState,
    Sig,
    TrustSetInput,
    Globals
} from "../../src/types/OracleTypes.sol";

contract LocalIntegration is RegistryFixture {
    error LocalChainOnly();
    error InvalidLocalConfiguration();
    error UnexpectedLifecycle();

    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    string internal constant EVIDENCE_URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    bytes32 internal constant MODE = 0x0100000000007821000100000000000000000000000000000000000000000000;
    bytes32 internal constant DEMO_ID = keccak256("EROS_LOCAL_FACTORY_DEMO_V1");
    bytes32 internal constant TERMINAL_ID = keccak256("EROS_LOCAL_FACTORY_TERMINAL_V1");
    bytes32 internal constant SOURCE_ID = keccak256("EROS_LOCAL_FIXTURE_INDEX_V1");
    address internal constant INDEX_SIGNER = 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A;
    bool internal leveragedFixture;

    struct LiveSource {
        bytes32 marketId;
        bytes32 sourceId;
        bytes32 rulesHash;
        uint256 depthNLots;
        uint256 maxSpreadWad;
        string question;
        string description;
    }
    LiveSource internal liveSource;

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    struct Stack {
        MockUSDC token;
        MockAssertionVenue assertionVenue;
        Timelock timelock;
        BondTreasury treasury;
        ResolutionOracle resolutionOracle;
        MarketRegistry registry;
        KeeperRouter router;
        RolloverBatcher rolloverBatcher;
        EngineCodeStore codeStore;
        EngineCodeStore codeStoreTail;
        MarketFactory factory;
        BookRiskEngine demo;
        BookRiskEngine terminal;
        uint256 startBlock;
    }

    modifier localOnly() {
        if (block.chainid != 31337) revert LocalChainOnly();
        _;
    }

    function run(bytes32 demoRulesHash, bytes32 terminalRulesHash, uint64 scheduledT) external localOnly {
        _run(demoRulesHash, terminalRulesHash, scheduledT);
    }

    function runLeveraged(bytes32 demoRulesHash, bytes32 terminalRulesHash, uint64 scheduledT) external localOnly {
        leveragedFixture = true;
        _run(demoRulesHash, terminalRulesHash, scheduledT);
    }

    /// @notice Real external prices with disposable local collateral, roles and risk calibration.
    /// Source metadata is pinned before deploying the immutable engine. No public chain is allowed.
    function runLive(string calldata sourcePath, bytes32 terminalRulesHash) external localOnly {
        string memory source = vm.readFile(sourcePath);
        liveSource.marketId = vm.parseJsonBytes32(source, ".marketId");
        liveSource.sourceId = vm.parseJsonBytes32(source, ".sourceId");
        liveSource.rulesHash = vm.parseJsonBytes32(source, ".sourceRulesHash");
        liveSource.depthNLots = vm.parseJsonUint(source, ".depthNLots");
        liveSource.maxSpreadWad = vm.parseJsonUint(source, ".maxSpreadWad");
        liveSource.question = vm.parseJsonString(source, ".question");
        liveSource.description = vm.parseJsonString(source, ".description");
        uint256 end = vm.parseJsonUint(source, ".scheduledT");
        if (
            liveSource.marketId == bytes32(0) || liveSource.marketId == TERMINAL_ID || liveSource.sourceId == bytes32(0)
                || liveSource.rulesHash == bytes32(0) || liveSource.depthNLots == 0 || liveSource.depthNLots > 1_000_000
                || liveSource.maxSpreadWad == 0 || liveSource.maxSpreadWad > 5e16 || end > type(uint64).max
                || bytes(liveSource.question).length == 0 || bytes(liveSource.description).length == 0
        ) revert InvalidLocalConfiguration();
        leveragedFixture = true;
        _run(liveSource.rulesHash, terminalRulesHash, uint64(end));
    }

    function _demoId() internal view returns (bytes32) {
        return liveSource.marketId == bytes32(0) ? DEMO_ID : liveSource.marketId;
    }

    function _run(bytes32 demoRulesHash, bytes32 terminalRulesHash, uint64 scheduledT) internal {
        if (
            demoRulesHash == bytes32(0) || terminalRulesHash == bytes32(0) || scheduledT < block.timestamp + 25 hours
                || scheduledT > block.timestamp + (leveragedFixture ? 29 days + 12 hours : 6 days)
        ) revert InvalidLocalConfiguration();
        Stack memory stack;
        stack.startBlock = block.number;
        address deployer = _actor(0);
        vm.startBroadcast(deployer);
        stack.token = new MockUSDC();
        usdc = address(stack.token);
        stack.assertionVenue = new MockAssertionVenue(usdc, 2e6);
        stack.timelock = new Timelock();
        {
            address[] memory controllers = new address[](1);
            controllers[0] = deployer;
            address[] memory executors = new address[](1);
            executors[0] = stack.timelock.OPEN_ROLE_HOLDER();
            stack.timelock.initialize(0, address(0), controllers, executors, controllers);
        }
        gov = address(stack.timelock);
        {
            uint256 nonce = vm.getNonce(deployer);
            address treasuryAt = vm.computeCreateAddress(deployer, nonce);
            address oracleAt = vm.computeCreateAddress(deployer, nonce + 1);
            address registryAt = vm.computeCreateAddress(deployer, nonce + 2);
            stack.treasury = new BondTreasury(usdc, oracleAt, registryAt, gov);
            stack.resolutionOracle = new ResolutionOracle(registryAt, treasuryAt, usdc, 31337, gov, deployer);
            stack.registry = new MarketRegistry(oracleAt, treasuryAt, address(0), usdc, gov, deployer);
            stack.router = new KeeperRouter(oracleAt);
        }
        {
            bytes memory creationCode = vm.getCode("RegistryBookRiskEngine.sol:RegistryBookRiskEngine");
            (bytes memory first, bytes memory second) = EngineCodeParts.split(creationCode);
            stack.codeStore = new EngineCodeStore(first);
            stack.codeStoreTail = new EngineCodeStore(second);
            stack.factory = new MarketFactory(
                address(stack.registry),
                usdc,
                deployer,
                address(stack.codeStore),
                address(stack.codeStoreTail),
                keccak256(creationCode)
            );
        }
        stack.rolloverBatcher = new RolloverBatcher();
        _configure(stack);
        stack.token.mint(deployer, 10_000e6);
        stack.token.approve(address(stack.treasury), type(uint256).max);
        stack.treasury.deposit(Ledger.ASSERTION, 1_000e6);
        stack.treasury.deposit(Ledger.WATCHDOG_FLOAT, 100e6);
        stack.demo = _create(stack, _demoId(), demoRulesHash, scheduledT);
        stack.terminal = _create(stack, TERMINAL_ID, terminalRulesHash, scheduledT);
        if (leveragedFixture) {
            CollateralVault vault = stack.factory.collateralVault();
            stack.token.mint(deployer, 100_000e6);
            stack.token.approve(address(vault), 100_000e6);
            vault.deposit(100_000e6);
            vault.allocate(address(stack.demo), 100_000e6, true);
            MarginMath.RiskParams memory p = RiskFixture.profile(5, true);
            p.realized.hSecs[0] = 30 days;
            p.templateEnv.hSecs[0] = 30 days;
            p.realized.validFrom = uint64(block.timestamp);
            p.templateEnv.validFrom = uint64(block.timestamp);
            p.realized.validUntil = scheduledT;
            p.templateEnv.validUntil = scheduledT;
            _govern(stack.timelock, address(stack.demo), abi.encodeCall(stack.demo.stageRiskParams, (p)));
        }
        _govern(stack.timelock, address(stack.demo), abi.encodeWithSignature("activateMarket()"));
        _govern(stack.timelock, address(stack.terminal), abi.encodeWithSignature("activateMarket()"));
        vm.stopBroadcast();
        _fund(stack, _actor(1));
        _fund(stack, _actor(2));
        _write(stack);
    }

    /// @notice Fund before warming pricing so allocation mutations cannot interrupt the later trade.
    function fundLeveraged(address engineAddress) external localOnly {
        BookRiskEngine engine = _checkedEngine(engineAddress);
        require(
            engine.listing().marketId == DEMO_ID && engine.reserveCapBaseQ() == 100_000e24, "wrong leverage fixture"
        );
        CollateralVault vault = engine.collateralVault();
        MockUSDC token = MockUSDC(engine.listing().token);
        for (uint32 actor = 13; actor <= 14; ++actor) {
            require(engine.participantId(_actor(actor)) == 0, "leverage fixture already used");
            vm.startBroadcast(_actor(0));
            token.mint(_actor(actor), 10e6);
            vm.stopBroadcast();
            vm.startBroadcast(_actor(actor));
            token.approve(address(vault), 10e6);
            vault.deposit(10e6);
            vault.allocate(address(engine), 10e6, false);
            vm.stopBroadcast();
        }
    }

    /// @notice A separate pair of disposable owners opens the direct 5x fixture after real mark maturity.
    function tradeLeveraged(address engineAddress) external localOnly {
        BookRiskEngine engine = _checkedEngine(engineAddress);
        (uint256 longCap, uint256 shortCap) = engine.leverageCaps();
        require(longCap == 5 && shortCap == 5 && engine.riskContext().markWad == 5e17, "leverage not ready");
        require(
            engine.listing().marketId == DEMO_ID && engine.reserveCapBaseQ() == 100_000e24, "wrong leverage fixture"
        );
        for (uint32 actor = 13; actor <= 14; ++actor) {
            require(
                engine.account(_actor(actor)).value.lots == 0 && engine.account(_actor(actor)).value.cashQ == 10e24,
                "fund leverage fixture first"
            );
        }
        vm.startBroadcast(_actor(14));
        uint32 orderId = engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 500, 100_000, 8, 0));
        vm.stopBroadcast();
        vm.startBroadcast(_actor(13));
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 100_000, 8, 0));
        vm.stopBroadcast();
        require(
            engine.getOrder(orderId).size == 0 && engine.account(_actor(13)).value.lots == 100_000,
            "leveraged fill failed"
        );
        require(engine.account(_actor(13)).value.cashQ == -40e24, "leveraged collateral mismatch");
        require(!engine.fundingFeatureEnabled() && !engine.recoveryEnabled(), "unsupported feature");
    }

    function trade(address engineAddress) external localOnly {
        BookRiskEngine engine = _checkedEngine(engineAddress);
        if (engine.oiAllLots() != 0 || !engine.riskContext().indexOk) revert UnexpectedLifecycle();
        vm.startBroadcast(_actor(2));
        uint32 orderId = engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 500, 15_000, 8, 0));
        vm.stopBroadcast();
        vm.startBroadcast(_actor(1));
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 10_000, 8, 0));
        vm.stopBroadcast();
        require(engine.getOrder(orderId).size == 5_000 && engine.oiAllLots() == 10_000, "local partial fill mismatch");
        vm.startBroadcast(_actor(2));
        engine.cancel(orderId);
        require(engine.getOrder(orderId).size == 0, "local cancellation mismatch");
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 520, 1_000, 8, 0));
        engine.cancelAll();
        vm.stopBroadcast();
        _releaseRoundTrip(engine, _actor(1));
        _releaseRoundTrip(engine, _actor(2));
        vm.startBroadcast(_actor(1));
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, true, false, 490, 1_000, 8, 0));
        vm.stopBroadcast();
        vm.startBroadcast(_actor(2));
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 510, 1_000, 8, 0));
        vm.stopBroadcast();
        require(
            engine.bookDepth().bidDepthLots == 1_000 && engine.bookDepth().askDepthLots == 1_000, "local depth mismatch"
        );
    }

    function beginSettlement(address engineAddress) external localOnly {
        BookRiskEngine engine = _checkedEngine(engineAddress);
        IMarketConfig.Listing memory configuration = engine.listing();
        if (configuration.marketId != TERMINAL_ID || engine.oiAllLots() != 10_000) revert UnexpectedLifecycle();
        _beginSettlement(engine, Outcome.YES);
    }

    /// @notice Close the deterministic 5x pair at NO to demonstrate funded bad-debt absorption.
    /// This fixture is deliberately unavailable for live-source markets or public chains.
    function beginLeveragedSettlement(address engineAddress) external localOnly {
        BookRiskEngine engine = _checkedLeveragedEngine(engineAddress);
        if (engine.oiAllLots() != 110_000 || engine.participantCount() != 4) revert UnexpectedLifecycle();
        require(
            engine.account(_actor(13)).value.lots == 100_000 && engine.account(_actor(13)).value.cashQ <= -40e24
                && engine.account(_actor(14)).value.lots == -100_000 && engine.account(_actor(14)).value.cashQ <= 60e24
                && engine.account(_actor(14)).value.cashQ > 0,
            "expected leveraged positions"
        );
        _beginSettlement(engine, Outcome.NO);
    }

    function _beginSettlement(BookRiskEngine engine, Outcome outcome) internal {
        IMarketConfig.Listing memory configuration = engine.listing();
        bytes32 marketId = configuration.marketId;
        if (engine.getHaltSnapshot().halted || block.timestamp >= configuration.scheduledT) {
            revert UnexpectedLifecycle();
        }
        ResolutionOracle resolutionOracle = ResolutionOracle(configuration.resolutionAuthority);
        vm.startBroadcast(_actor(0));
        engine.requestReduceOnly(keccak256("LOCAL_CONTROLLED_TERMINAL_SCENARIO"));
        resolutionOracle.requestEarlyCheck(marketId);
        PanelResult memory panel;
        panel.marketId = marketId;
        panel.phase = uint8(Phase.EARLY);
        panel.attempt = resolutionOracle.getResolution(marketId).attempts;
        panel.labels = [uint8(outcome), uint8(outcome), uint8(outcome)];
        panel.calibratedBps = [uint16(9500), uint16(9500), uint16(9500)];
        panel.evidenceHash = keccak256("LOCAL_SCRIPTED_EVIDENCE_NOT_MODEL_OUTPUT");
        panel.evidenceURIHash = keccak256(bytes(EVIDENCE_URI));
        panel.gateHash = MarketRegistry(configuration.registry).getMarketCore(marketId).gateHash;
        panel.trustSetId = resolutionOracle.activeTrustSetId();
        panel.deadline = uint64(block.timestamp + 1 hours);
        resolutionOracle.submitPanelResult(
            marketId, panel, EVIDENCE_URI, _sign(5, resolutionOracle.hashPanelResult(panel))
        );
        Resolution memory resolution = resolutionOracle.getResolution(marketId);
        require(resolution.state == RState.EarlyReview, "controlled review required");
        ReviewedProposal memory proposal;
        proposal.marketId = marketId;
        proposal.outcome = uint8(outcome);
        proposal.evidenceHash = panel.evidenceHash;
        proposal.evidenceURIHash = panel.evidenceURIHash;
        proposal.noteHash = keccak256("LOCAL_SCRIPTED_COMMITTEE_NOT_INDEPENDENT_REVIEW");
        proposal.attempt = resolution.attempts;
        proposal.rejectedMask = resolution.rejectedMask;
        proposal.early = true;
        proposal.trustSetId = panel.trustSetId;
        proposal.deadline = panel.deadline;
        (, uint32[] memory committeeIndices) = _committee();
        Sig[] memory signatures = new Sig[](2);
        for (uint256 member = 0; member < 2; ++member) {
            uint32 actorIndex = committeeIndices[member];
            signatures[member] =
                Sig(_actor(actorIndex), _sign(actorIndex, resolutionOracle.hashReviewedProposal(proposal)));
        }
        resolutionOracle.submitReviewedProposal(marketId, proposal, EVIDENCE_URI, signatures);
        resolutionOracle.assertProposal(marketId);
        vm.stopBroadcast();
    }

    function finishSettlement(address engineAddress) external localOnly {
        BookRiskEngine engine = _checkedEngine(engineAddress);
        IMarketConfig.Listing memory configuration = engine.listing();
        if (configuration.marketId != TERMINAL_ID) revert UnexpectedLifecycle();
        ResolutionOracle resolutionOracle = ResolutionOracle(configuration.resolutionAuthority);
        Resolution memory resolution = resolutionOracle.getResolution(TERMINAL_ID);
        address assertionVenue = resolutionOracle.trustSet(resolution.trustSetId).cfg.venue;
        if (block.timestamp < MockAssertionVenue(assertionVenue).statusOf(resolution.assertionId).expiresAt) {
            revert UnexpectedLifecycle();
        }
        vm.startBroadcast(_actor(0));
        MockAssertionVenue(assertionVenue).setResult(resolution.assertionId, true);
        resolutionOracle.finalizeMarket(TERMINAL_ID);
        require(resolutionOracle.getResolution(TERMINAL_ID).state == RState.Final, "oracle not final");
        for (uint256 page = 0; page < 32; ++page) {
            if (engine.prepareSnapshotChunk(32).done) break;
        }
        for (uint256 page = 0; page < 64; ++page) {
            if (engine.preparePayoutChunk(32).done) break;
        }
        require(engine.finishPreparation() && engine.claimsEnabled(), "claims not enabled");
        vm.stopBroadcast();
        _claim(engine);
    }

    function resolveAssertion(address engineAddress) external localOnly {
        BookRiskEngine engine = _checkedEngine(engineAddress);
        IMarketConfig.Listing memory configuration = engine.listing();
        if (configuration.marketId != TERMINAL_ID) revert UnexpectedLifecycle();
        _resolveAssertion(engine, Outcome.YES);
    }

    function resolveLeveragedAssertion(address engineAddress) external localOnly {
        _resolveAssertion(_checkedLeveragedEngine(engineAddress), Outcome.NO);
    }

    function _resolveAssertion(BookRiskEngine engine, Outcome expectedOutcome) internal {
        IMarketConfig.Listing memory configuration = engine.listing();
        ResolutionOracle resolutionOracle = ResolutionOracle(configuration.resolutionAuthority);
        Resolution memory resolution = resolutionOracle.getResolution(configuration.marketId);
        if (
            resolution.state != RState.Proposed || resolution.proposed != expectedOutcome
                || resolution.assertionId == bytes32(0)
        ) revert UnexpectedLifecycle();
        MockAssertionVenue assertionVenue =
            MockAssertionVenue(resolutionOracle.trustSet(resolution.trustSetId).cfg.venue);
        if (block.timestamp < assertionVenue.statusOf(resolution.assertionId).expiresAt) revert UnexpectedLifecycle();
        vm.startBroadcast(_actor(0));
        assertionVenue.setResult(resolution.assertionId, true);
        vm.stopBroadcast();
    }

    function claim(address engineAddress) external localOnly {
        _claim(_checkedEngine(engineAddress));
    }

    /// @notice Each funded owner signs its own claim transaction, including the 5x winner.
    function claimLeveraged(address engineAddress) external localOnly {
        BookRiskEngine engine = _checkedLeveragedEngine(engineAddress);
        IMarketConfig.Listing memory configuration = engine.listing();
        Resolution memory resolution =
            ResolutionOracle(configuration.resolutionAuthority).getResolution(configuration.marketId);
        if (
            resolution.state != RState.Final || resolution.outcome != Outcome.NO || !engine.claimsEnabled()
                || engine.settlementPriceWad() != 0 || engine.participantCount() != 4
        ) revert UnexpectedLifecycle();
        require(!engine.useRecovery() && !engine.recoveryRequired(), "full payouts required");
        MockUSDC token = MockUSDC(configuration.token);
        CollateralVault vault = engine.collateralVault();
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 callerBefore = token.balanceOf(_actor(0));
        uint32[4] memory owners = [uint32(1), uint32(2), uint32(13), uint32(14)];
        uint256[4] memory expected = _checkLeveragedPayouts(engine, owners);
        uint256 paid;
        for (uint256 index = 0; index < owners.length; ++index) {
            paid += _claimFullOwner(engine, token, _actor(owners[index]), expected[index]);
        }
        require(paid == engine.totalTraderAtoms() && engine.allTraderClaimsPaid(), "trader claims incomplete");
        require(token.balanceOf(_actor(0)) == callerBefore, "claim caller received trader funds");
        require(vaultBefore - token.balanceOf(address(vault)) == paid, "vault payout mismatch");
        require(vault.recognizedAtoms() == token.balanceOf(address(vault)), "vault custody mismatch");
        require(vault.marketAtoms(address(engine)) * 1e18 == engine.reserveResidualQ(), "only reserve may remain");
        require(vault.marketDebitQ(address(engine)) == 0, "unexpected fixture fee debit");
    }

    function _checkLeveragedPayouts(BookRiskEngine engine, uint32[4] memory owners)
        internal
        view
        returns (uint256[4] memory expected)
    {
        uint256 deficitQ;
        uint256 roundingQ;
        for (uint256 index = 0; index < owners.length; ++index) {
            address owner = _actor(owners[index]);
            (, int256 cashQ) = engine.frozen(owner);
            // NO has zero position payoff. Premiums through the economic halt remain charged,
            // so derive full entitlements from frozen cash rather than assuming zero elapsed time.
            uint256 rawQ = cashQ > 0 ? uint256(cashQ) : 0;
            if (cashQ < 0) deficitQ += uint256(-cashQ);
            require(engine.rawClaimQ(owner) == rawQ, "frozen entitlement mismatch");
            expected[index] = rawQ / 1e18;
            roundingQ += rawQ % 1e18;
        }
        require(
            expected[0] == 95e6 && expected[1] == 105e6 && expected[2] == 0 && expected[3] > 0 && expected[3] <= 60e6,
            "unexpected fixture entitlements"
        );
        require(deficitQ >= 40e24 && engine.getSettlementStatus().totalDeficitQ == deficitQ, "deficit mismatch");
        (int128 reserveLots, int256 reserveCashQ) = engine.frozenReserve();
        require(reserveLots == 0 && reserveCashQ > 0 && engine.frozenFeeQ() == 0, "unexpected reserve or fees");
        require(
            engine.reserveResidualQ() + deficitQ == uint256(reserveCashQ) + roundingQ, "reserve absorption mismatch"
        );
        require(engine.reserveResidualQ() < engine.reserveCapBaseQ(), "reserve seed must absorb bad debt");
    }

    function _claimFullOwner(BookRiskEngine engine, MockUSDC token, address owner, uint256 expected)
        internal
        returns (uint256 atoms)
    {
        atoms = engine.claimableAtoms(owner);
        require(atoms == expected && atoms == engine.rawClaimQ(owner) / 1e18, "full claim mismatch");
        uint256 beforeBalance = token.balanceOf(owner);
        if (atoms != 0) {
            vm.startBroadcast(owner);
            require(engine.claimTrader(owner) == atoms, "claim return mismatch");
            vm.stopBroadcast();
        }
        require(token.balanceOf(owner) - beforeBalance == atoms, "owner payout mismatch");
        require(engine.claimableAtoms(owner) == 0, "claim not consumed");
    }

    function _claim(BookRiskEngine engine) internal {
        IMarketConfig.Listing memory configuration = engine.listing();
        if (configuration.marketId != TERMINAL_ID || !engine.claimsEnabled()) revert UnexpectedLifecycle();
        MockUSDC token = MockUSDC(configuration.token);
        uint256 buyerBefore = token.balanceOf(_actor(1));
        uint256 sellerBefore = token.balanceOf(_actor(2));
        vm.startBroadcast(_actor(0));
        engine.claimTrader(_actor(1));
        engine.claimTrader(_actor(2));
        vm.stopBroadcast();
        require(token.balanceOf(_actor(1)) - buyerBefore == 105e6, "buyer payout mismatch");
        require(token.balanceOf(_actor(2)) - sellerBefore == 95e6, "seller payout mismatch");
        require(engine.collateralVault().marketAtoms(address(engine)) == 0, "market custody not cleared");
    }

    function _configure(Stack memory stack) internal {
        (address[] memory committee,) = _committee();
        TrustSetInput memory trust;
        trust.forwarder = _actor(4);
        trust.runnerAttestor = _actor(5);
        trust.committee = committee;
        trust.threshold = 2;
        trust.watchdog = _actor(9);
        trust.venue = address(stack.assertionVenue);
        _govern(
            stack.timelock, address(stack.resolutionOracle), abi.encodeCall(ResolutionOracle.createTrustSet, (trust))
        );
        _govern(stack.timelock, address(stack.resolutionOracle), abi.encodeCall(ResolutionOracle.activateTrustSet, (1)));
        Globals memory globals = _globals();
        if (leveragedFixture) globals.maxVoidSecs = 30 days;
        _govern(stack.timelock, address(stack.registry), abi.encodeCall(MarketRegistry.setGlobals, (globals)));
        _govern(stack.timelock, address(stack.registry), abi.encodeCall(MarketRegistry.setProvider, (HOST, true)));
        _govern(stack.timelock, address(stack.registry), abi.encodeCall(MarketRegistry.setProvider, (OTHER, true)));
        _govern(
            stack.timelock, address(stack.registry), abi.encodeCall(MarketRegistry.setFactory, (address(stack.factory)))
        );
        _govern(
            stack.timelock,
            address(stack.treasury),
            abi.encodeCall(BondTreasury.setLimits, (leveragedFixture ? 1000e6 : 100e6, 20))
        );
    }

    function _create(Stack memory stack, bytes32 marketId, bytes32 sourceRulesHash, uint64 scheduledT)
        internal
        returns (BookRiskEngine engine)
    {
        MarketInput memory market = _noFeed();
        market.marketId = marketId;
        market.question = "Local fixture: does the controlled terminal scenario resolve YES?";
        market.rules = "LOCAL FIXTURE ONLY: scripted committee YES; no external-world factual claim.";
        if (leveragedFixture && marketId == DEMO_ID) {
            market.question = "Local fixture: does the controlled leveraged scenario resolve YES?";
            market.rules =
                "LOCAL FIXTURE ONLY: scripted committee NO tests reserve-funded bad debt; no external-world factual claim.";
        }
        market.tau = scheduledT;
        market.windowStart = uint64(block.timestamp);
        market.windowEnd = scheduledT;
        market.voidSecs = leveragedFixture ? 30 days : 7 days;
        market.monitor = _actor(0);
        market.oiCapLots = leveragedFixture && marketId == _demoId() ? 1_000_000 : 100_000;
        IMarketConfig.Listing memory configuration =
            ListingFixture.make(uint64(block.timestamp), address(stack.resolutionOracle), _actor(0), gov, INDEX_SIGNER);
        configuration.token = usdc;
        configuration.registry = address(stack.registry);
        configuration.deploymentCapX = leveragedFixture && marketId == _demoId() ? 5 : 1;
        configuration.maxLiqLotsPerBlock = configuration.deploymentCapX > 1 ? 100_000 : 0;
        configuration.fundingEnabled = false;
        configuration.depthNLots = 1_000;
        configuration.indexSourceId = SOURCE_ID;
        configuration.indexRulesHash = sourceRulesHash;
        if (liveSource.marketId != bytes32(0) && marketId == liveSource.marketId) {
            market.question = liveSource.question;
            market.rules = string.concat(
                "LOCAL DIAGNOSTIC: external price mapping only; adjudication is a controlled fixture. ",
                liveSource.description
            );
            configuration.depthNLots = liveSource.depthNLots;
            configuration.maxSpreadWad = liveSource.maxSpreadWad;
            configuration.indexSourceId = liveSource.sourceId;
        }
        // Measured cold factory creation fits this budget. Pin it explicitly so Forge's
        // estimator padding cannot manufacture a transaction above the 30M chain cap.
        engine = BookRiskEngine(stack.registry.createMarket{gas: 29_000_000}(market, configuration, ""));
    }

    function _fund(Stack memory stack, address owner) internal {
        CollateralVault vault = stack.factory.collateralVault();
        vm.startBroadcast(_actor(0));
        stack.token.mint(owner, 200e6);
        vm.stopBroadcast();
        vm.startBroadcast(owner);
        stack.token.approve(address(vault), 200e6);
        vault.deposit(200e6);
        vault.allocate(address(stack.demo), 100e6, false);
        vault.allocate(address(stack.terminal), 100e6, false);
        vm.stopBroadcast();
    }

    function _releaseRoundTrip(BookRiskEngine engine, address owner) internal {
        CollateralVault vault = engine.collateralVault();
        MockUSDC token = MockUSDC(engine.listing().token);
        uint256 balanceBefore = token.balanceOf(owner);
        vm.startBroadcast(owner);
        engine.release(1e6);
        require(vault.freeAtoms(owner) == 1e6, "local release mismatch");
        vault.withdraw(1e6);
        require(token.balanceOf(owner) == balanceBefore + 1e6, "local withdrawal mismatch");
        token.approve(address(vault), 1e6);
        vault.deposit(1e6);
        vault.allocate(address(engine), 1e6, false);
        vm.stopBroadcast();
        require(token.balanceOf(owner) == balanceBefore && vault.freeAtoms(owner) == 0, "local refund mismatch");
    }

    function _govern(Timelock timelock, address target, bytes memory data) internal {
        Call[] memory calls = new Call[](1);
        calls[0] = Call(target, 0, data);
        bytes memory execution = abi.encode(calls, abi.encode(bytes32(0), keccak256(abi.encode(target, data))));
        timelock.propose(MODE, execution, 0);
        timelock.execute(MODE, execution);
    }

    function _actor(uint32 index) internal pure returns (address) {
        return vm.addr(vm.deriveKey(MNEMONIC, index));
    }

    function _committee() internal pure returns (address[] memory members, uint32[] memory indices) {
        members = new address[](3);
        indices = new uint32[](3);
        for (uint32 member = 0; member < 3; ++member) {
            indices[member] = member + 6;
            members[member] = _actor(member + 6);
        }
        for (uint256 first = 0; first < 3; ++first) {
            for (uint256 second = first + 1; second < 3; ++second) {
                if (members[first] > members[second]) {
                    (members[first], members[second]) = (members[second], members[first]);
                    (indices[first], indices[second]) = (indices[second], indices[first]);
                }
            }
        }
    }

    function _sign(uint32 actorIndex, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 recovery, bytes32 signatureR, bytes32 signatureS) = vm.sign(vm.deriveKey(MNEMONIC, actorIndex), digest);
        return abi.encodePacked(signatureR, signatureS, recovery);
    }

    function _checkedEngine(address engineAddress) internal view returns (BookRiskEngine engine) {
        engine = BookRiskEngine(engineAddress);
        IMarketConfig.Listing memory configuration = engine.listing();
        if (
            configuration.marketId != DEMO_ID && configuration.marketId != TERMINAL_ID
                || configuration.indexSigner != INDEX_SIGNER || configuration.monitor != _actor(0)
                || configuration.indexSourceId != SOURCE_ID
                || MarketRegistry(configuration.registry).getMarketCore(configuration.marketId).engine != engineAddress
        ) revert InvalidLocalConfiguration();
    }

    function _checkedLeveragedEngine(address engineAddress) internal view returns (BookRiskEngine engine) {
        engine = _checkedEngine(engineAddress);
        if (
            engine.listing().marketId != DEMO_ID || engine.reserveCapBaseQ() != 100_000e24
                || engine.fundingFeatureEnabled() || engine.recoveryEnabled()
        ) revert InvalidLocalConfiguration();
    }

    function _entry(string memory name, address target, uint256 startBlock) internal returns (string memory) {
        vm.serializeAddress(name, "address", target);
        vm.serializeBytes32(name, "codehash", target.codehash);
        return vm.serializeUint(name, "deployBlock", startBlock);
    }

    function _marketEntry(string memory name, BookRiskEngine engine) internal returns (string memory) {
        IMarketConfig.Listing memory configuration = engine.listing();
        vm.serializeAddress(name, "engine", address(engine));
        vm.serializeBytes32(name, "marketId", configuration.marketId);
        vm.serializeBytes32(name, "sourceId", configuration.indexSourceId);
        vm.serializeBytes32(name, "sourceRulesHash", configuration.indexRulesHash);
        vm.serializeBytes32(name, "erosRulesHash", configuration.rulesHash);
        vm.serializeBytes32(name, "listingHash", engine.listingHash());
        vm.serializeAddress(name, "indexSigner", configuration.indexSigner);
        vm.serializeAddress(name, "reserveVault", address(engine.reserveVault()));
        vm.serializeUint(name, "scheduledT", configuration.scheduledT);
        vm.serializeUint(name, "depthNLots", configuration.depthNLots);
        vm.serializeUint(name, "deploymentCapX", configuration.deploymentCapX);
        vm.serializeUint(name, "template", uint256(configuration.template));
        vm.serializeUint(name, "maxLiqLotsPerBlock", configuration.maxLiqLotsPerBlock);
        vm.serializeBool(name, "fundingEnabled", configuration.fundingEnabled);
        return vm.serializeUint(name, "maxSpreadWad", configuration.maxSpreadWad);
    }

    function _write(Stack memory stack) internal {
        string memory contractsKey = "contracts";
        vm.serializeString(contractsKey, "Timelock", _entry("timelock", address(stack.timelock), stack.startBlock));
        vm.serializeString(contractsKey, "MockUSDC", _entry("token", address(stack.token), stack.startBlock));
        vm.serializeString(
            contractsKey, "MockAssertionVenue", _entry("venue", address(stack.assertionVenue), stack.startBlock)
        );
        vm.serializeString(contractsKey, "BondTreasury", _entry("treasury", address(stack.treasury), stack.startBlock));
        vm.serializeString(
            contractsKey, "ResolutionOracle", _entry("oracle", address(stack.resolutionOracle), stack.startBlock)
        );
        vm.serializeString(
            contractsKey, "MarketRegistry", _entry("registry", address(stack.registry), stack.startBlock)
        );
        vm.serializeString(contractsKey, "KeeperRouter", _entry("router", address(stack.router), stack.startBlock));
        vm.serializeString(
            contractsKey, "RolloverBatcher", _entry("rolloverBatcher", address(stack.rolloverBatcher), stack.startBlock)
        );
        vm.serializeString(contractsKey, "EngineCodeStore", _entry("store", address(stack.codeStore), stack.startBlock));
        vm.serializeString(
            contractsKey, "EngineCodeStoreTail", _entry("storeTail", address(stack.codeStoreTail), stack.startBlock)
        );
        vm.serializeString(contractsKey, "MarketFactory", _entry("factory", address(stack.factory), stack.startBlock));
        string memory contractsJson = vm.serializeString(
            contractsKey, "CollateralVault", _entry("vault", address(stack.factory.collateralVault()), stack.startBlock)
        );
        vm.serializeString("markets", "demo", _marketEntry("demo", stack.demo));
        string memory marketsJson = vm.serializeString("markets", "terminal", _marketEntry("terminal", stack.terminal));
        vm.serializeAddress("accounts", "deployer", _actor(0));
        vm.serializeAddress("accounts", "buyer", _actor(1));
        vm.serializeAddress("accounts", "seller", _actor(2));
        vm.serializeAddress("accounts", "attestor", _actor(5));
        if (leveragedFixture) {
            vm.serializeAddress("accounts", "leveragedLong", _actor(13));
            vm.serializeAddress("accounts", "leveragedShort", _actor(14));
            if (liveSource.marketId != bytes32(0)) {
                vm.serializeAddress("accounts", "bidMaker", _actor(16));
                vm.serializeAddress("accounts", "askMaker", _actor(17));
            }
        }
        string memory accountsJson = vm.serializeAddress("accounts", "watchdog", _actor(9));
        vm.serializeString("assertionVenue", "kind", "mock");
        string memory assertionJson = vm.serializeAddress("assertionVenue", "address", address(stack.assertionVenue));
        vm.serializeString("manifest", "scope", "local-only");
        vm.serializeString("manifest", "riskScenario", leveragedFixture ? "leveraged-fixture" : "fully-backed");
        vm.serializeString(
            "manifest", "calibrationEvidence", "controlled local fixture only; not empirical production calibration"
        );
        vm.serializeString(
            "manifest", "manifestOrigin", "forge-simulation-candidate; verify mined listing fields before enrollment"
        );
        vm.serializeString("manifest", "network", "local-integration");
        vm.serializeUint("manifest", "chainId", 31337);
        vm.serializeString("manifest", "sourceMode", liveSource.marketId == bytes32(0) ? "fixture" : "polymarket");
        vm.serializeUint("manifest", "startBlock", stack.startBlock);
        vm.serializeAddress("manifest", "usdc", address(stack.token));
        vm.serializeString("manifest", "contracts", contractsJson);
        vm.serializeString("manifest", "markets", marketsJson);
        vm.serializeString("manifest", "accounts", accountsJson);
        string memory json = vm.serializeString("manifest", "assertionVenue", assertionJson);
        vm.writeJson(json, "deployments/local-integration.json");
    }
}
