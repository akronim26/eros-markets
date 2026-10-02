# Block 1 — Contracts (O10–O19, gate OG1)

Plan §5, §6, §11.1, §12.4, §12.5, §12.11, §13 rows O10–O19, §14. Format and rules: header of
`docs_oracle/check_tasks.py`. All sources use `pragma solidity 0.8.30;`, depend only on Solady and engine
interfaces, and are not upgradeable (§6.1). Test doubles live in `oracle/test/mocks/` (ADJ-06).

## O10 · Libraries
Plan §13: owner OA · 3 PD · depends OG0 · acceptance: unit + fuzz; vectors identical to the TS evaluator.

### O10.1 · HostLib
- Owner: OA
- PD: 0.5
- Depends: OG0
- Plan: §6.3, §7.3, ADJ-12
- Cut: yes
- Status: done
- Files: oracle/src/libraries/HostLib.sol, oracle/test/unit/HostLib.t.sol
- Build: `https://` prefix; host = lowercase `[a-z0-9-]` labels joined by dots, at least two labels, no leading or trailing hyphen, label length ≤ 63 (same as the TS `HOST_RE`); no userinfo `@`, no port; `{id}` at most once and after the first `/` following the host; `urlParam` matches `[A-Za-z0-9._~-]{1,128}`; `{id}` substitution; host of the substituted URL.
- Done when: one passing test per rule (accept and reject) plus a fuzz test that a URL the library accepts always yields a host that passes its own host rule.
- Check: cd oracle && forge test --match-path test/unit/HostLib.t.sol
- Notes: "`{id}` after the first `/` following the host" is implemented literally: a `/` must exist at or after the end of the host and `{id}` must come after the first such `/` (so `https://h.com/v1?id={id}` is accepted and `https://h.com?e={id}` is not). Codes are returned in order, so `{id}` inside the host reports code 2. The exact rules are written into `vectors/feedspec.json` for the TypeScript side (O20.1).

### O10.2 · FeedSpecLib and the shared FeedSpec vectors
- Owner: OA
- PD: 0.75
- Depends: O10.1
- Plan: §6.3, §7.3, §11.2, C.7, ADJ-08, ADJ-12
- Cut: yes
- Status: done
- Files: oracle/src/libraries/FeedSpecLib.sol, oracle/test/unit/FeedSpecLib.t.sol, oracle/vectors/feedspec.json, oracle/vectors/spechash.json
- Build: Path grammar `seg(.seg)*`, `seg = [A-Za-z0-9_$-]+` followed by `[n]` indexes with `n = 0|[1-9][0-9]{0,5}`, at most 256 bytes; non-empty `finalValue`; op per type (STRING: EQ/NEQ; INT/DECIMAL: all six); `decimals > 0` only for DECIMAL and ≤ 18; target parse (INT `-?(0|[1-9]\d*)`, DECIMAL with at most `decimals` fractional digits and no exponent, STRING non-empty); `bufferSecs < l1TimeoutSecs` within the globals bounds passed in; all-zero spec check; `specHash = keccak256(abi.encode(spec))`. Create `vectors/feedspec.json` (valid and invalid specs with the expected error code) and add to `vectors/spechash.json` at least three more specHash vectors (with `authRef`, empty `urlParam`, long strings); read both with `vm.readFile`.
- Done when: every vector passes in Foundry, including the C.7 specHash `0x5066…80cd`; O20.2 asserts the same file in TypeScript.
- Check: cd oracle && forge test --match-path test/unit/FeedSpecLib.t.sol
- Notes: 71 validation cases (every code 0-12) with hand-assigned expected codes in `feedspec.json`; 5 specHash vectors computed with viem 2.57.2 in `spechash.json` (vector 0 is B.3 = C.7; moved there from `feedspec.json` on 2026-10-02 so each vector has one home). The TypeScript half of the parity check is O20.2. `validate` takes the allowed L1 host and whether `authRef` is known from the registry; code 13 uses `isZero`.

### O10.3 · ClaimRenderer
- Owner: OA
- PD: 0.75
- Depends: OG0
- Plan: §6.3, §6.4, D19
- Cut: yes
- Status: done
- Files: oracle/src/libraries/ClaimRenderer.sol, oracle/test/unit/ClaimRenderer.t.sol
- Build: Token check (each of the nine required tokens exactly once, `{{TAU_UNIX}}` at most once, no other `{{…}}`); one-pass renderer with Solady `LibString`/`DateTimeLib` (`{{MARKET_ID}}` 0x hex, `{{ORACLE}}` checksummed, `{{TAU_UTC}}` `YYYY-MM-DDTHH:MM:SSZ`, `{{OUTCOME}}` YES/NO/INVALID, `{{EVIDENCE}}` URI or the L1 text "Layer 1 CRE report, value <valueHash>, source <URL>"); worst-case length formula of §6.3 rule 6.
- Done when: the §6.4 default template renders the expected text for a fixed input; a fuzz test shows rendered length ≤ the worst-case bound; each token-rule violation is rejected.
- Check: cd oracle && forge test --match-path test/unit/ClaimRenderer.t.sol
- Notes: "No other `{{…}}` token" is enforced strictly: every double opening brace must start one of the ten tokens, so `{{foo}}`, lowercase names, spaces inside braces and stray double braces are rejected. The default-template expected text was built independently in TypeScript (viem 2.57.2, `Date.toISOString`). `worstCaseLength` is checked exactly at maximum inputs (only the plan's unix-time slack of 20 − 12 bytes remains); it assumes a chain id below 2^64 and tau before the year 10000.

### O10.4 · VoidBound and BondMath
- Owner: OA
- PD: 0.5
- Depends: OG0
- Plan: §6.5, §14.2, §14.3, D9, D11, D15, C.7
- Cut: yes
- Status: done
- Files: oracle/src/libraries/VoidBound.sol, oracle/src/libraries/BondMath.sol, oracle/test/unit/BondMath.t.sol
- Build: `T_void ≥ T_L1 + T_L2 + A_max·(T_live,max + (R_max + 2)·T_round) + (A_max − 1)·(T_r + T_retry) + T_slack` with `T_L1 = 0` without a feed; `B = max(minBond, venue minimum, ceil(oiHaltLots × 1000 × bondBps / 10 000))`; pure liveness selection (L1 → livenessL1, L2_AUTO → livenessAuto, both → livenessReviewed when the heartbeat is stale or the watchdog revoked; REVIEWED/PERMISSIONLESS → livenessReviewed).
- Done when: production inputs give 3,837,600 s, testnet demo inputs 6,000 s, 2,000,000 lots at 1,112 bps give 222,400,000 atoms (values read from `vectors/`); fuzz: ceil never under-sizes and the bound is monotone in each input.
- Check: cd oracle && forge test --match-path test/unit/BondMath.t.sol
- Notes: Watchdog freshness is a separate helper (`isWatchdogFresh`): not revoked and last heartbeat at most `heartbeatMaxAgeSecs` old; a watchdog that never sent one is stale. `liveness(Path.NONE)` reverts. Mutations (floor instead of ceil; `R_max + 1` rounds) are caught by the tests.

### O10.5 · SigLib
- Owner: OA
- PD: 0.5
- Depends: OG0
- Plan: §6.4, D7, C.7
- Cut: partial (committee part only)
- Status: done
- Files: oracle/src/libraries/SigLib.sol, oracle/test/unit/SigLib.t.sol
- Build: `PanelResult` and `ReviewedProposal` struct hashes with fixed arrays encoded as `keccak256(abi.encode(array))` (C.7); single-signature check for the panel attestor (65-byte r,s,v); m-of-k check: signers strictly ascending, unique, each a member and not revoked (passed in), count ≥ threshold, `SignatureCheckerLib.isValidSignatureNow` so a member may be ERC-1271.
- Done when: digests for P1 and R1 under the C.7 domain equal `0xc315…b5bc` and `0xc3e6…301b`; each m-of-k failure mode has a test.
- Check: cd oracle && forge test --match-path test/unit/SigLib.t.sol
- Notes: Panel signatures must be 65 bytes with `v ∈ {27, 28}` and low `s` (Solady does not reject malleable signatures, so SigLib does). Committee failures revert with the `IResolutionOracle` errors; a duplicate or zero signer is `SignersNotSorted`, and `threshold == 0` is refused. Mutations caught: no low-s check, equal signers allowed, wrong array hashed.

## O11 · MarketRegistry
Plan §13: owner OA · 3 PD · depends O10 · acceptance: every §6.3 rejection has a test.

### O11.1 · Registry test doubles
- Owner: OA
- PD: 0.5
- Depends: O10.2, O10.3, O10.4, O10.5, O19.1
- Plan: §3.4, §11.1, ADJ-06, ADJ-07
- Cut: yes
- Status: done
- Files: oracle/test/mocks/{MockResolutionEngine,MockMarketFactory,MockAssertionVenue,MockOracleView,MockBondTreasury}.sol, oracle/test/unit/Mocks.t.sol
- Build: `MockResolutionEngine` subclasses the testnet `ResolutionEngineStub` (O19.1) with knobs `revertOnSettle`, `setOiLots`, wrong `listingHash`, pre-halted, misbehaving halts. `MockMarketFactory` deploys it or a misbehaving one. `MockAssertionVenue` is scripted (assert, dispute, settle true/false, never answer, settled directly, `minimumBond`, `bondCurrency`). `MockOracleView` (active trust set, venue, `initResolution` recorder, `getResolution`, `watchdogOf`) and `MockBondTreasury` (`commitListing` ledger) stand in for the oracle and treasury in registry tests. Doubles script answers; they never re-implement the real contract's rules.
- Done when: each double has a smoke test of its knobs.
- Check: cd oracle && forge test --match-path test/unit/Mocks.t.sol
- Notes: `MockAssertionVenue` never settles on its own: each result is scripted (`setResult`, `markDisputed`, `settleDirectly`); unanswered is the default. With a token set, bonds move like the real venue (pulled at assert and dispute, returned to the asserter when true).

### O11.2 · Storage, globals and governance setters
- Owner: OA
- PD: 0.75
- Depends: O11.1
- Plan: §6.3, §7.4, §14.4, C.1, C.4, ADJ-14, ADJ-30
- Cut: partial (no categories)
- Status: done
- Files: oracle/src/MarketRegistry.sol, oracle/test/unit/RegistryGlobals.t.sol
- Build: Constructor `(oracle, treasury, factory, usdc, governance, lister)` (factory may be 0; `createMarket` then reverts `NoFactory`). Versioned `setGlobals` (append-only, `globalsAt(v)`) enforcing every §14.4 bound, including the extra chainId 143 rules. `setProvider`, `setAuthRef`, `setCategory` (stamp `validatedAt` on every validated call, clear it when not validated), `setLister`, `setFactory`. Events of C.4. SSTORE2 helpers for long text.
- Done when: one test per §14.4 bound on both sides, under `vm.chainId(143)` and another chain; old globals versions stay readable; setter access control tested.
- Check: cd oracle && forge test --match-path test/unit/RegistryGlobals.t.sol
- Notes: `BadGlobals` codes 0–17 per ADJ-30 (team decision). Categories are implemented in full despite the cut note (team decision: about 15 lines, nothing reads them before O14.5). The contract does not declare `is IMarketRegistry` yet, because `createMarket`, the market views and `minVoidSecs` arrive in O11.3/O11.4; until then it uses the C.4 errors and events by qualified name. `setProvider` keys hosts by `keccak256(bytes(host))` and does not validate them (createMarket rule 4 does). `_readText(0)` returns empty, because SSTORE2 cannot read a codeless address. Expected bounds come from the §14.4 table and the base globals from the §12.11 columns; 35 mutations (each bound moved by one, code swap, version, access, stamp) were all caught.

### O11.3 · `createMarket` validation rules 1–6
- Owner: OA
- PD: 1
- Depends: O11.2
- Plan: §6.3, §14.1, §14.2, D15, D19
- Cut: partial (no groups: `groupId != 0` reverts `EarlyCheckOrGroupsDisabled` in the cut)
- Status: todo
- Files: oracle/src/MarketRegistry.sol, oracle/test/unit/RegistryCreateRules.t.sol
- Build: Rule 1 identity (`DuplicateMarket`, `NoActiveTrustSet`, `GroupMismatch`); rule 2 times (`BadTimes` 1–6 including the void bound and the engine gate `voidSecs ≥ tau − now + 3600`); rule 3 feed (`BadFeed` 1–13 through HostLib/FeedSpecLib, L1 host = `allowList[0]`, known `authRef`); rule 4 allow-list (`BadAllowList` 1–3); rule 5 AIConfig (`BadAIConfig` 1–5); rule 6 UMAConfig (`BadUMAConfig` 1–6, venue minimum from the active trust set, claim length through ClaimRenderer).
- Done when: one test per error code asserts the exact code (C.4), plus a test that a fully valid input passes rules 1–6.
- Check: cd oracle && forge test --match-path test/unit/RegistryCreateRules.t.sol

### O11.4 · `createMarket` steps 7–9 and views
- Owner: OA
- PD: 0.75
- Depends: O11.3
- Plan: §6.3, §6.8, C.4, ADJ-14
- Cut: yes
- Status: todo
- Files: oracle/src/MarketRegistry.sol, oracle/test/unit/RegistryCreateMarket.t.sol
- Build: Step 7 `treasury.commitListing(id, BondMath.bond(oiCapLots, …))`; step 8 overwrite the listing fields (marketId, registry, resolutionAuthority, monitor, scheduledT, listedAt, rulesHash, `sourceHash = keccak256(abi.encode(specHash, keccak256(abi.encode(allowList))))`, invalidRule `{true, 3600, 5e17, voidSecs}`), `factory.deployMarket`, `ListingHashMismatch`, `EngineAlreadyHalted`; step 9 SSTORE2 writes, `gateHash`, `initResolution`, `MarketListed` (with `umaConfigHash`, ADJ-14). All C.4 views including `minVoidSecs`.
- Done when: tests cover a listing-hash mismatch from the factory, a pre-halted engine, treasury below the cap, a non-lister caller, `setFactory` affecting only later listings, and a full round trip of every view.
- Check: cd oracle && forge test --match-path test/unit/RegistryCreateMarket.t.sol

## O12 · BondTreasury
Plan §13: owner OA · 2 PD · depends O02 · acceptance: ledger isolation, ORC-10, ORC-14.

### O12.1 · Ledgers, deposits, listing commitments, withdraw and limits
- Owner: OA
- PD: 0.75
- Depends: O02.2
- Plan: §6.6, C.5, ORC-10, ORC-14
- Cut: yes
- Status: todo
- Files: oracle/src/BondTreasury.sol, oracle/test/unit/TreasuryLedgers.t.sol
- Build: Constructor `(usdc, oracle, registry, governance)`; three ledgers; `deposit`; `commitListing` (ASSERTION ≥ totalCommitted + bondAtCap, `AlreadyCommitted`); `releaseListing`; `withdraw` (ASSERTION never below `totalCommitted`, others down to 0); `setLimits` (both start at 0); views; events.
- Done when: isolation tests (moving one ledger never changes another) and every access rule pass with the repo `MockUSDC`.
- Check: cd oracle && forge test --match-path test/unit/TreasuryLedgers.t.sol

### O12.2 · Bond flows and proposer rewards
- Owner: OA
- PD: 0.75
- Depends: O12.1
- Plan: §5.4, §6.6, C.5, ADJ-27
- Cut: yes
- Status: todo
- Files: oracle/src/BondTreasury.sol, oracle/test/unit/TreasuryBonds.t.sol
- Build: `fundAssertion` (debit ASSERTION or `InsufficientLedger`, `outstanding[id][attempt]`, `fundedTotal ≤ maxPerMarket` or `PerMarketCapExceeded`, approve exactly `bond` to the venue passed by the oracle); `onBondReturned`, `onBondLost`, `markStuck` with `totalOutstanding`; `payProposerReward` (never reverts; IOU `owed` when short); `claimOwed`. Attempt indexing per ADJ-27.
- Done when: tests cover each flow, the per-market cap, the IOU path (no revert) and oracle-only access.
- Check: cd oracle && forge test --match-path test/unit/TreasuryBonds.t.sol

### O12.3 · Watchdog disputes, closeDispute and skim
- Owner: OA
- PD: 0.5
- Depends: O12.2
- Plan: §6.6, C.5, ORC-10, ORC-14
- Cut: no
- Status: todo
- Files: oracle/src/BondTreasury.sol, oracle/test/unit/TreasuryDisputes.t.sol
- Build: `disputeViaVenue` (caller = `oracle.watchdogOf(id)`, `NoLiveAssertion`, `maxOpenDisputes`, float debit, venue `disputeFor`, record keyed by assertionId, `openDisputeBonds`); `closeDispute` (recorded disputes only; closes when settled on the venue or when the market is Final with `VOID_DEADLINE`; second call false); `skim` (balance − ledgers − outstanding − open dispute bonds, credit only a positive remainder, never reverts).
- Done when: tests cover watchdog-only and capped disputes, close-once, close after a void write-off, and skim never crediting an in-flight bond twice.
- Check: cd oracle && forge test --match-path test/unit/TreasuryDisputes.t.sol

## O13 · UmaAdapter, ErosSandboxOracle and real-UMA tests
Plan §13: owner OA · 1.5 PD · depends O02 · acceptance: A2 suite + extended cases.

### O13.1 · Venue contracts from the prototypes
- Owner: OA
- PD: 0.5
- Depends: O02.2
- Plan: §6.7, D1, D14, B.4, B.5, C.1, ADJ-23
- Cut: yes
- Status: todo
- Files: oracle/src/venues/UmaAdapter.sol, oracle/src/venues/ErosSandboxOracle.sol, oracle/test/unit/ErosSandboxOracle.t.sol
- Build: Add B.4 and B.5 (forge-fmt clean as given), with the `arbitrary-send-erc20` lint comment and reason from C.1. ErosSandboxOracle says TESTNET ONLY in its NatSpec.
- Done when: sandbox unit tests pass (owner-only answer, one answer per request, non-requester ignored, `setRequester` one-shot).
- Check: cd oracle && forge test --match-path test/unit/ErosSandboxOracle.t.sol

### O13.2 · Real-UMA integration suite (A2)
- Owner: OA
- PD: 0.5
- Depends: O13.1
- Plan: §6.7, §11.1, B.8, V-U1, ADJ-05
- Cut: yes
- Status: todo
- Files: oracle/test/integration-uma/UmaVenue.t.sol
- Build: Port the B.8 test into `test/integration-uma/` (imports adjusted to `../../src/…`, ADJ-05): real Finder, Store, AddressWhitelist, IdentifierWhitelist and OOv3 from artifacts, MockUSDC from `@eros-test`.
- Done when: the six A2 cases pass (minimum bond = 2 × final fee; undisputed returns the bond to the asserter; only the team answers; unanswered never reverts; false pays the disputer 2B − 50% burn; stranger callbacks are no-ops; only the oracle asserts).
- Check: cd oracle && forge test --match-path test/integration-uma/UmaVenue.t.sol

### O13.3 · Extended real-UMA cases
- Owner: OA
- PD: 0.5
- Depends: O13.2
- Plan: §6.7, §11.1, V-U4
- Cut: yes
- Status: todo
- Files: oracle/test/integration-uma/UmaVenueExtended.t.sol
- Build: Permissionless asserter (asserter = payer = caller); treasury `disputeFor`; settlement done directly on OOv3 followed by `statusOf` (B.4 note); a deleted/never-answered request leaves `settleAssertion` reverting forever while `trySettle` returns false; a second final-fee setting changes `minimumBond`.
- Done when: all extended cases pass.
- Check: cd oracle && forge test --match-path test/integration-uma/UmaVenueExtended.t.sol

## O14 · ResolutionOracle state machine
Plan §13: owner OA · 5 PD · depends O10–O13 · acceptance: §11.1 unit tests.

### O14.1 · Skeleton, trust sets, guardian and heartbeat
- Owner: OA
- PD: 1
- Depends: O11.4, O12.3, O13.3
- Plan: §4.1, §4.2, §5.2, §6.4, §6.8, C.1, C.3, D8, D20
- Cut: yes
- Status: todo
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleTrustSets.t.sol, oracle/test/mocks/ResolutionOracleHarness.sol
- Build: Constructor `(registry, treasury, usdc, monadChainSelector, governance, guardian)`, `simModeAllowed = chainid != 143`; Solady `EIP712` domain ("ErosResolutionOracle", "1"), `ReentrancyGuard` on every state-changing function; `createTrustSet` with `BadTrustSet` codes 1–9, `activateTrustSet`; guardian `revokeWorkflowId`/`revokeAttestor`/`revokeCommitteeMember`/`revokeWatchdog` (immediate, also on pinned sets); `initResolution` (registry only); `watchdogHeartbeat` and `lastHeartbeat`; trust-set views; all C.3 events declared. No pause and no admin path that can move a market (D20). A test-only harness that can place a Resolution in any state.
- Done when: every trust-set rule, every revoke and every access check has a test.
- Check: cd oracle && forge test --match-path test/unit/OracleTrustSets.t.sol

### O14.2 · Halt, request, escalate and open
- Owner: OA
- PD: 0.75
- Depends: O14.1
- Plan: §5.3, §5.4, §6.4, §7.3, D3, D4, D16, ORC-11, ORC-12
- Cut: yes
- Status: todo
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleHalt.t.sol
- Build: `haltScheduled` (from None, EarlyCheck, EarlyReview at ≥ T; copy `haltedAt = economicHaltAt` and `oiHaltLots` from the engine; `voidDeadline = max(haltedAt, T) + voidSecs` set once; pin trust set and globals version; L1Pending or L2Pending with `l2StartedAt = haltedAt`; `HaltRecorded`); `requestResolution` (`NoFeed`, `TooEarly`, halts first, per-market `minRequestInterval`, `ResolutionRequested`); `escalateToL2`; `openAfterDeadline` (early-halted markets stay committee-only until T; `retryOpensAt`); `getL1Job`. No-op returns instead of reverts per §5.4.
- Done when: a late scheduled halt copies `economicHaltAt = T`; `voidDeadline` and pinning are correct; rate-limit and every no-op return are tested.
- Check: cd oracle && forge test --match-path test/unit/OracleHalt.t.sol

### O14.3 · Committee and permissionless proposals
- Owner: OA
- PD: 0.75
- Depends: O14.2
- Plan: §5.4, §6.4, D7, D17, ORC-6
- Cut: yes
- Status: todo
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleProposals.t.sol
- Build: `submitReviewedProposal` in Review/Open (pinned set, outcome ∉ `rejectedMask`, attempt and mask match, evidenceURI hash and length) and from EarlyReview (before T, within the TTL, `early == true`, calls `engine.halt()`, pins the active set, records the halt) using SigLib; `proposePermissionless` in Open (own bond via the venue, `rewardAtoms` from the pinned globals, `proposer`, attempts++). `ProposalRecorded`.
- Done when: each guard has an accepting and a rejecting test; an early committee proposal halts the engine with `haltedAt = block.timestamp`.
- Check: cd oracle && forge test --match-path test/unit/OracleProposals.t.sol

### O14.4 · Assertions, finalize, reject and void
- Owner: OA
- PD: 1.25
- Depends: O14.3
- Plan: §5.4, §6.4, §6.5, D1, D2, D9, D10, D11, ORC-2, ORC-3, ORC-5, ORC-8, ORC-9, ADJ-27
- Cut: yes
- Status: todo
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleAssertions.t.sol
- Build: `assertProposal` (attempts < 3, outcome not rejected, `now + liveness ≤ voidDeadline`, `TreasuryShort`, `fundAssertion`, venue `assertOutcome` with `renderClaim`, `Asserted`); `bondFor`, `livenessFor` (heartbeat fallback), `renderClaim`; `syncAssertion`; `finalizeMarket` (`trySettle`, then `statusOf`); `_final` (engine `settle(1)`/`settle(0)`/`settleInvalid()` in the same transaction, treasury booking per final reason, `releaseListing`); `_reject` (mask, Review with `retryOpensAt`, Voided → Final INVALID when YES and NO are both rejected); `voidMarket` (applies a settled or settleable assertion first, `markStuck` for a live team bond).
- Done when: the §11.1 "Assertion lifecycle", "Void", "Treasury bookkeeping per final reason" and "Liveness fallback" cases pass against `MockAssertionVenue` and `MockResolutionEngine`; an engine revert rolls the oracle transaction back.
- Check: cd oracle && forge test --match-path test/unit/OracleAssertions.t.sol

### O14.5 · Early check and the Layer 2 panel paths
- Owner: OA
- PD: 0.75
- Depends: O14.4
- Plan: §5.4, §6.4, §8.5, §8.6, D5, ORC-15
- Cut: no (in the cut `requestEarlyCheck` reverts `NotSupported`)
- Status: todo
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OraclePanel.t.sol
- Build: `requestEarlyCheck` (market monitor only, before T, engine `monitorRestricted`); `expireEarly`; `submitPanelResult` routing (EarlyCheck → EarlyReview or None; L2Pending → stay on ≥ 2 NOT_YET, Proposed on the auto gate, Review otherwise); `submitPanelProposal`; `_autoGate` (unanimous YES/NO, confidence floor, category validated with matching gateHash and `validatedAt ≤ haltedAt`, U95 and N limits, review limit, POST_T, `flags == 0`, evidence present) using the pinned globals version.
- Done when: every routing row of §5.4 is tested; a category validated after the halt does not open the gate; revoking one closes it at once; L2_AUTO never happens before T.
- Check: cd oracle && forge test --match-path test/unit/OraclePanel.t.sol

### O14.6 · Exclusive groups
- Owner: OA
- PD: 0.5
- Depends: O14.4
- Plan: §5.4, D6, ORC-7
- Cut: no
- Status: todo
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleGroups.t.sol
- Build: YES lock taken at assertion; another holder → `assertProposal` returns false; released on rejection or void; kept on Final YES (`finalYes`); a YES in a group with a Final YES → Review with `proposed = NONE` and `retryOpensAt = now + retryWindow` (no attempt used); `GroupLock`, `GroupConflict`; `groupState` view.
- Done when: the §11.1 "Groups" cases pass, including the conflict on a feed market where `l2StartedAt == 0`.
- Check: cd oracle && forge test --match-path test/unit/OracleGroups.t.sol

## O15 · CRE receiver
Plan §13: owner OA · 1.5 PD · depends O14 · acceptance: §11.1 onReport tests; 64-byte metadata through a header-faithful mock.

### O15.1 · `onReport` production path
- Owner: OA
- PD: 0.75
- Depends: O14.5, O14.6
- Plan: §6.4, §7.1, D12, ORC-4, V-C7, V-C8
- Cut: yes
- Status: todo
- Files: oracle/src/ResolutionOracle.sol, oracle/test/mocks/MockKeystoneForwarderLite.sol, oracle/test/unit/OracleReport.t.sol
- Build: `MockKeystoneForwarderLite` builds the 109-byte header exactly like `KeystoneForwarder` and passes `rawReport[45:109]` as metadata. `onReport`: production auth (pinned set is production, sender = its forwarder, metadata ≥ 62, workflow ID accepted and not revoked, owner, optional name), decode report v1, `BadReport` codes 1–6, effects, `ProposedL1`; `supportsInterface` true for `0x805f2132` and `0x01ffc9a7`.
- Done when: every §11.1 onReport revert case, replay after proposal/escalation/Final, and 64-byte metadata acceptance pass; `onReport` uses < 150k gas.
- Check: cd oracle && forge test --match-path test/unit/OracleReport.t.sol

### O15.2 · Sim mode and `lockProduction`
- Owner: OA
- PD: 0.75
- Depends: O15.1
- Plan: §6.4, §7.5, D13, ORC-13, V-C9
- Cut: yes
- Status: todo
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleSimMode.t.sol
- Build: `setSimForwarder` and `setSimRelayer` (Timelock, only while sim mode); sim path (sender = sim forwarder, `tx.origin` is a relayer, pinned set not production, metadata skipped); production-forwarder reports still accepted while sim mode is on; `lockProduction` (one-way, needs an active production set with forwarder, workflow ID and owner; clears the sim forwarder).
- Done when: the §11.1 "Sim mode" cases pass, including sim mode impossible under `vm.chainId(143)` and a mock-forwarder report reverting after the lock.
- Check: cd oracle && forge test --match-path test/unit/OracleSimMode.t.sol

## O16 · EIP-712 panel and committee
Plan §13: owner OA · 1.5 PD · depends O14 · acceptance: signature test vectors shared with oracle-sdk.

### O16.1 · EIP-712 views and shared vectors
- Owner: OA
- PD: 0.5
- Depends: O14.5, O14.6
- Plan: §6.4, D7, C.7, V-R4, ADJ-15
- Cut: no
- Status: todo
- Files: oracle/test/unit/OracleEip712.t.sol, oracle/vectors/eip712.json
- Build: `hashPanelResult`, `hashReviewedProposal`, `domainSeparator` views; deploy the oracle at `0x…AA` on chainId 10143 (`deployCodeTo`) and assert the P1 and R1 digests from `vectors/eip712.json`; add signed examples (fixed test keys) to the vector file for oracle-sdk.
- Done when: both digests match C.7 through the oracle's own views.
- Check: cd oracle && forge test --match-path test/unit/OracleEip712.t.sol

### O16.2 · Panel signature and payload rejections
- Owner: OA
- PD: 0.5
- Depends: O16.1
- Plan: §6.4, §11.1, ADJ-15
- Cut: no
- Status: todo
- Files: oracle/test/unit/OraclePanelSigs.t.sol
- Build: `submitPanelProposal` and `submitPanelResult` reject: split labels, confidence below θ_hi, unvalidated category, gateHash mismatch, OI above the review limit, `flags != 0`, wrong attempt, wrong trust set, expired deadline, wrong signer, revoked attestor, URI hash or length mismatch, wrong phase.
- Done when: each rejection asserts its exact error and code (C.3).
- Check: cd oracle && forge test --match-path test/unit/OraclePanelSigs.t.sol

### O16.3 · Committee signature rejections and ERC-1271
- Owner: OA
- PD: 0.5
- Depends: O16.1
- Plan: §6.4, §11.1, ADJ-15
- Cut: no (basic committee checks are already in O14.3)
- Status: todo
- Files: oracle/test/unit/OracleCommitteeSigs.t.sol, oracle/test/mocks/MockERC1271Wallet.sol
- Build: Below threshold, duplicate signer, non-member, revoked member, unsorted signatures, rejected outcome, wrong `rejectedMask`, wrong attempt, expired deadline, `early` flag mismatch, an ERC-1271 member accepted; after a rejected early proposal `openAfterDeadline` returns false until T.
- Done when: every case passes with its exact error.
- Check: cd oracle && forge test --match-path test/unit/OracleCommitteeSigs.t.sol

## O17 · Invariants and seam tests
Plan §13: owner OA · 3 PD · depends O14–O16 · acceptance: `FOUNDRY_PROFILE=ci forge test` green.

### O17.1 · Stateful handler
- Owner: OA
- PD: 1
- Depends: O15.2, O16.2, O16.3
- Plan: §5.5, §11.1
- Cut: no
- Status: todo
- Files: oracle/test/invariant/OracleHandler.sol, oracle/test/invariant/OracleInvariants.t.sol
- Build: A handler that calls every external function of the oracle, registry and treasury with bounded random inputs, time warps, venue outcomes (true, false, never answered, settled directly) and engine knobs, and keeps ghost variables for the invariants.
- Done when: a smoke invariant (`true`) runs at the default profile with no handler revert loops dominating the calls.
- Check: cd oracle && forge test --match-path test/invariant/OracleInvariants.t.sol

### O17.2 · Invariants ORC-1 to ORC-15
- Owner: OA
- PD: 1
- Depends: O17.1
- Plan: §5.5, D20, ORC-1, ORC-2, ORC-3, ORC-4, ORC-5, ORC-6, ORC-7, ORC-8, ORC-9, ORC-10, ORC-11, ORC-12, ORC-13, ORC-14, ORC-15
- Cut: no
- Status: todo
- Files: oracle/test/invariant/OracleInvariants.t.sol
- Build: One `invariant_` function per ORC row of §5.5.
- Done when: all fifteen hold at the `ci` profile (10,000 fuzz, 256×128 invariant).
- Check: cd oracle && FOUNDRY_PROFILE=ci forge test --match-path test/invariant/OracleInvariants.t.sol

### O17.3 · Seam with B's real settlement code
- Owner: OA
- PD: 1
- Depends: O15.2, O16.2, O16.3
- Plan: §3.2, §3.4, §11.1, B.6, V-R1
- Cut: no
- Status: todo
- Files: oracle/test/seam/EngineHarness.sol, oracle/test/seam/Seam.t.sol
- Build: Add B.6 `EngineHarness` (B's real `SettlementController` with B's `MockBookAdapter` and `MockAccountingPort`, imported through remappings; no `*.t.sol` import) with `resolutionAuthority = ResolutionOracle`, and drive it through the real oracle.
- Done when: early YES claimable before T; early INVALID pending until the T capture; a late scheduled halt gives `haltedAt = T`; a conflicting delivery reverts the oracle transaction so the oracle does not become Final; the full suite is green at the `ci` profile.
- Check: cd oracle && FOUNDRY_PROFILE=ci forge test

## O18 · Gas snapshots
Plan §13: owner OA · 0.5 PD · depends O17 · acceptance: budgets §6.9 met or justified.

### O18.1 · Gas snapshots and `gas.json`
- Owner: OA
- PD: 0.5
- Depends: O17.2, O17.3
- Plan: §6.9, §12.11
- Cut: no
- Status: todo
- Files: oracle/test/gas/OracleGas.t.sol, oracle/.gas-snapshot, oracle/deployments/gas.json
- Build: One gas test per call type of §6.9 (`onReport`, `haltScheduled`, `assertProposal` with a 16 KiB claim, `finalizeMarket`, `createMarket`); write measured limits with margin into `deployments/gas.json`; record contract sizes.
- Done when: every budget is met or the excess is justified in `gas.json`; every contract is < 128 KiB.
- Check: cd oracle && forge snapshot --check --match-path test/gas/OracleGas.t.sol && forge build --sizes

## O19 · Scripts, testnet stand-ins and KeeperRouter
Plan §13: owner OA · 2 PD · depends O17 · acceptance: dry-run on anvil and a fork of Monad testnet.

### O19.1 · ResolutionEngineStub and StubMarketFactory
- Owner: OA
- PD: 0.5
- Depends: O02.2
- Plan: §3.4, §6.10, ADJ-07
- Cut: yes
- Status: done
- Files: oracle/src/testnet/ResolutionEngineStub.sol, oracle/src/testnet/StubMarketFactory.sol, oracle/test/unit/StubEngine.t.sol
- Build: Exactly §6.10: TESTNET ONLY names and NatSpec; `initialize` once (factory only, void gate, `engineInit = abi.encode(oiLots)`); `halt`, `materializeScheduledHalt`, `settle`, `settleInvalid` with B034 semantics (`BadOutcome`, same outcome → false, `ConflictingFinalOutcome`); `getSettlementStatus`; `marketRiskView` with `setMonitorRestricted` by the monitor; `StubMarketFactory` `onlyRegistry`, reverts on a reused marketId. Pulled ahead of O17 because O11 and O14 tests need it (ADJ-07).
- Done when: the stub's behaviour matches B's `ResolutionIngress` on every case of `docs/counterpart-oracle-fixtures.json` that does not need accounting.
- Check: cd oracle && forge test --match-path test/unit/StubEngine.t.sol
- Notes: Errors reuse the engine's names; a test proves their selectors equal the real engine's (`LifecycleMath`, `RiskContextPort`, `ResolutionIngress`). For INVALID the stub reports the listing's fallback price (0.5) as ready from T, since it has no index to capture. Done together with O11.1 in one commit (team decision).

### O19.2 · KeeperRouter
- Owner: OA
- PD: 0.25
- Depends: O17.2, O17.3
- Plan: §6.11, C.6
- Cut: yes
- Status: todo
- Files: oracle/src/KeeperRouter.sol, oracle/test/unit/KeeperRouter.t.sol
- Build: `finalizeMany`, `assertMany`, `haltAndRequest`, each inner call in try/catch; no funds, no approvals.
- Done when: an engine revert on one market does not block the others; a `TooEarly` request never undoes the halt.
- Check: cd oracle && forge test --match-path test/unit/KeeperRouter.t.sol

### O19.3 · DeployUmaSandbox and DeployOracle
- Owner: OA
- PD: 0.75
- Depends: O19.1, O19.2
- Plan: §12.4, §12.5, §12.11, C.1
- Cut: yes
- Status: todo
- Files: oracle/script/DeployUmaSandbox.s.sol, oracle/script/DeployOracle.s.sol, oracle/deployments/params.monad-testnet.json, oracle/src/testnet/TestUSDC.sol
- Build: `TestUSDC` (TESTNET ONLY, 6 decimals, capped faucet mint, no other knobs; `seam-decisions.md` S-13), deployed first by the sandbox script when no bond token address is given. Sandbox script in the eight steps of §12.4 (USDC bond token, ErosSandboxOracle replacing MockOracleAncillary, final asserts on owner and requester). Oracle script: precompute every address, deploy in the §12.5 order (Timelock initialized in the same script), assert each address, refuse stubs on chainId 143, pass factory 0 on mainnet, write `deployments/<network>.json` in the §12.11 schema with code hashes and deploy blocks.
- Done when: both scripts run on anvil and on a fork of Monad testnet with every assertion passing.
- Check: cd oracle && forge script script/DeployOracle.s.sol --fork-url $MONAD_TESTNET_RPC

### O19.4 · Governance and listing scripts
- Owner: OA
- PD: 0.5
- Depends: O19.3
- Plan: §12.5, §12.9, §12.11, §14.1, V-R8, V-M3, ADJ-18
- Cut: yes
- Status: todo
- Files: oracle/script/{CreateTrustSet,ListMarket,LockProduction,FundTreasury}.s.sol, oracle/test/unit/TimelockRecipe.t.sol
- Build: Scripts read `params.<network>.json` and print `MODE`, `EXEC` and the operation `ID` for the Safe (never broadcast governance calls); the globals version-1 testnet column of §12.11; a Foundry test of the Timelock recipe (propose from the Safe, refuse before the delay, execute from an unrelated address after it).
- Done when: each script dry-runs on a fork; the Timelock test passes; V-M3 (Monad `createMarket` gas) is recorded from the first testnet listing in X04.
- Check: cd oracle && forge test --match-path test/unit/TimelockRecipe.t.sol
