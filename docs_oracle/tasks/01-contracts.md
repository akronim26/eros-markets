# Block 1 — Contracts (O10–O19, gate OG1)

Plan §5, §6, §11.1, §12.4, §12.5, §12.11, §13 rows O10–O19, §14. Format and rules: header of
`docs_oracle/check_tasks.py`. All sources use `pragma solidity ^0.8.30;` (ADJ-33), depend only on Solady and engine
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
- Notes: "No other `{{…}}` token" is enforced strictly: every double opening brace must start one of the ten tokens, so `{{foo}}`, lowercase names, spaces inside braces and stray double braces are rejected. The default-template expected text was built independently in TypeScript (viem 2.57.2, `Date.toISOString`). `worstCaseLength` is checked exactly at maximum inputs (only the plan's unix-time slack of 20 − 12 bytes remains); it assumes a chain id below 2^64 and tau before the year 10000. Rewritten for gas in O18.1 (one pass, `indexOf` scan, word-compared tokens) with byte-identical output, checked against a frozen copy of this version by `test/parity/ClaimRendererParity.t.sol`.

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
- Status: done
- Files: oracle/src/MarketRegistry.sol, oracle/test/unit/RegistryCreateRules.t.sol
- Build: Rule 1 identity (`DuplicateMarket`, `NoActiveTrustSet`, `GroupMismatch`); rule 2 times (`BadTimes` 1–6 including the void bound and the engine gate `voidSecs ≥ tau − now + 3600`); rule 3 feed (`BadFeed` 1–13 through HostLib/FeedSpecLib, L1 host = `allowList[0]`, known `authRef`); rule 4 allow-list (`BadAllowList` 1–3); rule 5 AIConfig (`BadAIConfig` 1–5); rule 6 UMAConfig (`BadUMAConfig` 1–6, venue minimum from the active trust set, claim length through ClaimRenderer).
- Done when: one test per error code asserts the exact code (C.4), plus a test that a fully valid input passes rules 1–6.
- Check: cd oracle && forge test --match-path test/unit/RegistryCreateRules.t.sol
- Notes: Rules 1-6 live in the internal `_validateMarket` (plus the C.4 view `minVoidSecs`), exercised through a test harness; O11.4 wires them into `createMarket`. Groups (team decision): the full GroupMismatch rule is coded behind `_groupsEnabled()`, which returns false until O14.6, so every grouped listing reverts `EarlyCheckOrGroupsDisabled` as the cut requires; the harness turns it on to test GroupMismatch. A zero `marketId` reverts `DuplicateMarket` (rule 1 lists both under that error). With no globals set, `BadGlobals(0)` (ADJ-30). A feed market with an empty allow-list fails `BadFeed(5)` (rule 3 runs before rule 4). `BadAllowList` checks every host for code 2 before any for code 3. Expected values: §14.1/§12.11 testnet demo inputs, the §14.2 void bound of 6,000 s, and the claim bound recomputed from the §6.3 rule 6 text. 41 mutations caught (three needed stronger tests: non-exclusive group, T_L1 ignored without a feed, reviewed liveness below L1 only).

### O11.4 · `createMarket` steps 7–9 and views
- Owner: OA
- PD: 0.75
- Depends: O11.3
- Plan: §6.3, §6.8, C.4, ADJ-14
- Cut: yes
- Status: done
- Files: oracle/src/MarketRegistry.sol, oracle/test/unit/RegistryCreateMarket.t.sol, oracle/test/unit/RegistryFixture.sol
- Build: Step 7 `treasury.commitListing(id, BondMath.bond(oiCapLots, …))`; step 8 overwrite the listing fields (marketId, registry, resolutionAuthority, monitor, scheduledT, listedAt, rulesHash, `sourceHash = keccak256(abi.encode(specHash, keccak256(abi.encode(allowList))))`, invalidRule `{true, 3600, 5e17, voidSecs}`), `factory.deployMarket`, `ListingHashMismatch`, `EngineAlreadyHalted`; step 9 SSTORE2 writes, `gateHash`, `initResolution`, `MarketListed` (with `umaConfigHash`, ADJ-14). All C.4 views including `minVoidSecs`.
- Done when: tests cover a listing-hash mismatch from the factory, a pre-halted engine, treasury below the cap, a non-lister caller, `setFactory` affecting only later listings, and a full round trip of every view.
- Check: cd oracle && forge test --match-path test/unit/RegistryCreateMarket.t.sol
- Notes: Team decisions: `specHash = keccak256(abi.encode(feed))` for every market, so a no-feed market stores the hash of the all-zero FeedSpec; market views return empty values for an unlisted id (`isListed` tells them apart; C.4 unchanged). The registry now declares `is IMarketRegistry` (C.4 unchanged, ABI snapshot still verifies). Order inside `createMarket`: lister, `NoFactory`, rules 1-6, step 7 commitment, step 8 handshake, step 9 writes, `initResolution`, `MarketListed`; every external call is to a governance-set contract and only the lister can enter, so the state writes after them are safe and atomic. The shared listing fixture moved to `test/unit/RegistryFixture.sol` (used by the O11.3 and O11.4 tests). Expected values: bond at cap 11,120,000 atoms (§12.5), the B.3 specHash from `vectors/spechash.json` (C.7), overwritten fields from §6.3 step 8; the real `StubMarketFactory` path is also listed end to end. MarketRegistry is 28,776 B of runtime code: above the Ethereum 24 KiB limit, within Monad's 128 KiB (§6.9, `code_size_limit`). 40 mutations (each overwritten field, each stored field, each check, the bond and the event hash) caught.

## O12 · BondTreasury
Plan §13: owner OA · 2 PD · depends O02 · acceptance: ledger isolation, ORC-10, ORC-14.

### O12.1 · Ledgers, deposits, listing commitments, withdraw and limits
- Owner: OA
- PD: 0.75
- Depends: O02.2
- Plan: §6.6, C.5, ORC-10, ORC-14
- Cut: yes
- Status: done
- Files: oracle/src/BondTreasury.sol, oracle/test/unit/TreasuryLedgers.t.sol
- Build: Constructor `(usdc, oracle, registry, governance)`; three ledgers; `deposit`; `commitListing` (ASSERTION ≥ totalCommitted + bondAtCap, `AlreadyCommitted`); `releaseListing`; `withdraw` (ASSERTION never below `totalCommitted`, others down to 0); `setLimits` (both start at 0); views; events.
- Done when: isolation tests (moving one ledger never changes another) and every access rule pass with the repo `MockUSDC`.
- Check: cd oracle && forge test --match-path test/unit/TreasuryLedgers.t.sol
- Notes: Team decisions: `deposit` credits the balance increase actually received (ORC-14 holds even for a short-delivering token; tested with MockUSDC taxed mode); `releaseListing` is a no-op (no event, no revert) for an id without an open commitment, so the treasury can never block `_final` (ORC-9). A commitment is tracked as NONE/OPEN/RELEASED, so a zero-sized commitment still blocks a second one and a released id cannot commit again. `withdraw` reverts `InsufficientLedger` above the ledger, then `BelowCommitments(totalCommitted + amount, balance)` when ASSERTION would drop below `totalCommitted`. The contract declares `is IBondTreasury` in O12.3, when every C.5 function exists; until then it uses the C.5 errors and events by qualified name. 20 mutations caught; the isolation fuzz reaches its assertions on every run (no assume).

### O12.2 · Bond flows and proposer rewards
- Owner: OA
- PD: 0.75
- Depends: O12.1
- Plan: §5.4, §6.6, C.5, ADJ-27
- Cut: yes
- Status: done
- Files: oracle/src/BondTreasury.sol, oracle/test/unit/TreasuryBonds.t.sol
- Build: `fundAssertion` (debit ASSERTION or `InsufficientLedger`, `outstanding[id][attempt]`, `fundedTotal ≤ maxPerMarket` or `PerMarketCapExceeded`, approve exactly `bond` to the venue passed by the oracle); `onBondReturned`, `onBondLost`, `markStuck` with `totalOutstanding`; `payProposerReward` (never reverts; IOU `owed` when short); `claimOwed`. Attempt indexing per ADJ-27.
- Done when: tests cover each flow, the per-market cap, the IOU path (no revert) and oracle-only access.
- Check: cd oracle && forge test --match-path test/unit/TreasuryBonds.t.sol
- Notes: Team decisions: funding the same `(id, attempt)` again adds to `outstanding` (books stay exact, no new error); `onBondReturned`/`onBondLost`/`markStuck` are no-ops with nothing outstanding (ORC-9); rewards are pushed and fall back to an IOU when the ledger is short or the transfer fails (e.g. a USDC-blacklisted proposer), so `payProposerReward` never reverts; `claimOwed` pays the whole IOU or reverts `InsufficientLedger`, and is a no-op with nothing owed. Solady 2afba69 has no non-reverting ERC-20 `transfer`, so the push uses a private `_tryTransfer` (low-level call; revert, `false` or malformed return data count as failure). A zero reward returns true with no event. `fundedTotal` never decreases, so returned bonds still count toward `maxPerMarket`. `totalOutstanding` is public for skim (O12.3) and alerts. Tests move bonds through `MockAssertionVenue` with real token transfers and check ORC-14 against the actual balance; 24 mutations caught.

### O12.3 · Watchdog disputes, closeDispute and skim
- Owner: OA
- PD: 0.5
- Depends: O12.2
- Plan: §6.6, C.5, ORC-10, ORC-14
- Cut: no
- Status: done
- Files: oracle/src/BondTreasury.sol, oracle/test/unit/TreasuryDisputes.t.sol
- Build: `disputeViaVenue` (caller = `oracle.watchdogOf(id)`, `NoLiveAssertion`, `maxOpenDisputes`, float debit, venue `disputeFor`, record keyed by assertionId, `openDisputeBonds`); `closeDispute` (recorded disputes only; closes when settled on the venue or when the market is Final with `VOID_DEADLINE`; second call false); `skim` (balance − ledgers − outstanding − open dispute bonds, credit only a positive remainder, never reverts).
- Done when: tests cover watchdog-only and capped disputes, close-once, close after a void write-off, and skim never crediting an in-flight bond twice.
- Check: cd oracle && forge test --match-path test/unit/TreasuryDisputes.t.sol
- Notes: Team decision: the dispute bond is the venue's own figure (`statusOf(assertionId).bond`, exactly what the venue pulls), and `disputeViaVenue` reverts `NoLiveAssertion` unless the assertion exists, is unsettled, undisputed and `now < expiresAt`. Check order: watchdog (`Unauthorized`), live assertion, `TooManyOpenDisputes`, float (`InsufficientLedger`). Dispute records are public (`disputes(assertionId)` gives market, venue, bond) for the keeper's closeDispute job. `skim` holds back every ledger, `totalOutstanding` and `openDisputeBonds` exactly as §6.6, so dispute winnings are credited in full only once no bond is still out. The treasury now declares `is IBondTreasury` (C.5 unchanged; ABI snapshot verifies). 28 mutations: 27 caught; removing `!st.exists` survives as equivalent (an unknown assertion reports `expiresAt = 0`, which the liveness check already refuses, on OOv3 too), kept for clarity and covered by an unknown-assertion test.

## O13 · UmaAdapter, ErosSandboxOracle and real-UMA tests
Plan §13: owner OA · 1.5 PD · depends O02 · acceptance: A2 suite + extended cases.

### O13.1 · Venue contracts from the prototypes
- Owner: OA
- PD: 0.5
- Depends: O02.2
- Plan: §6.7, D1, D14, B.4, B.5, C.1, ADJ-23
- Cut: yes
- Status: done
- Files: oracle/src/venues/UmaAdapter.sol, oracle/src/venues/ErosSandboxOracle.sol, oracle/test/unit/ErosSandboxOracle.t.sol
- Build: Add B.4 and B.5 (forge-fmt clean as given), with the `arbitrary-send-erc20` lint comment and reason from C.1. ErosSandboxOracle says TESTNET ONLY in its NatSpec.
- Done when: sandbox unit tests pass (owner-only answer, one answer per request, non-requester ignored, `setRequester` one-shot).
- Check: cd oracle && forge test --match-path test/unit/ErosSandboxOracle.t.sol
- Notes: Both files are the plan's B.4/B.5 code byte for byte (extracted from the plan and checked), `forge fmt` clean as given; the only addition is the C.1 `arbitrary-send-erc20` suppression with its reason above the two `safeTransferFrom` calls in UmaAdapter (`forge lint` reports none afterwards). B.5 already says TESTNET ONLY in its title. `setRequester` keeps the `AlreadyAnswered` error (ADJ-23). The request id is recomputed in the test from its B.5 definition. UmaAdapter is tested against real UMA in O13.2/O13.3. 12 sandbox mutations caught.

### O13.2 · Real-UMA integration suite (A2)
- Owner: OA
- PD: 0.5
- Depends: O13.1
- Plan: §6.7, §11.1, B.8, V-U1, ADJ-05
- Cut: yes
- Status: done
- Files: oracle/test/integration-uma/UmaVenue.t.sol
- Build: Port the B.8 test into `test/integration-uma/` (imports adjusted to `../../src/…`, ADJ-05): real Finder, Store, AddressWhitelist, IdentifierWhitelist and OOv3 from artifacts, MockUSDC from `@eros-test`.
- Done when: the six A2 cases pass (minimum bond = 2 × final fee; undisputed returns the bond to the asserter; only the team answers; unanswered never reverts; false pays the disputer 2B − 50% burn; stranger callbacks are no-ops; only the oracle asserts).
- Check: cd oracle && forge test --match-path test/integration-uma/UmaVenue.t.sol
- Notes: The B.8 test byte for byte (extracted from the plan), only the four `../src/` imports changed to `../../src/` (ADJ-05); fmt clean as given. Real Finder, Store, AddressWhitelist, IdentifierWhitelist and OOv3 (solc 0.8.16) deployed from artifacts. 6/6 A2 cases pass. Adapter mutations: 10 of 14 caught here; the 4 survivors (asserter used as payer, `trySettle` on an already-settled assertion, treasury-only `disputeFor`, `truthful` without `settled`) are exactly the O13.3 extended cases, so they are targeted there rather than changing the verbatim A2 port.

### O13.3 · Extended real-UMA cases
- Owner: OA
- PD: 0.5
- Depends: O13.2
- Plan: §6.7, §11.1, V-U4
- Cut: yes
- Status: done
- Files: oracle/test/integration-uma/UmaVenueExtended.t.sol
- Build: Permissionless asserter (asserter = payer = caller); treasury `disputeFor`; settlement done directly on OOv3 followed by `statusOf` (B.4 note); a deleted/never-answered request leaves `settleAssertion` reverting forever while `trySettle` returns false; a second final-fee setting changes `minimumBond`.
- Done when: all extended cases pass.
- Check: cd oracle && forge test --match-path test/integration-uma/UmaVenueExtended.t.sol
- Notes: Facts read from the pinned OOv3 source: `getMinimumBond` uses the final fee cached when the currency was first validated, so a new `Store.setFinalFee` reaches `venue.minimumBond()` (registry rule 6) only after anyone calls `syncUmaParams`; settling a disputed assertion calls the oracle's `getPrice`, which reverts while the sandbox has not answered, so an unanswered (or deleted) vote makes `settleAssertion` revert indefinitely while `trySettle` returns false; OOv3 refuses disputes at or after expiry. Also covered: payer and asserter (and payer and disputer) as separate roles, the treasury winning or losing a dispute (2B minus the 50% burn), `disputeFor` treasury-only, and no allowance left to OOv3 after an assert or a dispute. Adapter mutations over both real-UMA suites: 21 of 23 caught; the 2 survivors are equivalent under OOv3 (dropping the `settled` pre-check in `trySettle`, since OOv3 reverts "already settled" and the catch returns false; dropping `settled &&` from `truthful`, since OOv3 sets the resolution only together with `settled`).

## O14 · ResolutionOracle state machine
Plan §13: owner OA · 5 PD · depends O10–O13 · acceptance: §11.1 unit tests.

### O14.1 · Skeleton, trust sets, guardian and heartbeat
- Owner: OA
- PD: 1
- Depends: O11.4, O12.3, O13.3
- Plan: §4.1, §4.2, §5.2, §6.4, §6.8, C.1, C.3, D8, D20, ADJ-31
- Cut: yes
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleTrustSets.t.sol, oracle/test/mocks/ResolutionOracleHarness.sol
- Build: Constructor `(registry, treasury, usdc, monadChainSelector, governance, guardian)`, `simModeAllowed = chainid != 143`; Solady `EIP712` domain ("ErosResolutionOracle", "1"), `ReentrancyGuard` on every state-changing function; `createTrustSet` with `BadTrustSet` codes 1–9, `activateTrustSet`; guardian `revokeWorkflowId`/`revokeAttestor`/`revokeCommitteeMember`/`revokeWatchdog` (immediate, also on pinned sets); `initResolution` (registry only); `watchdogHeartbeat` and `lastHeartbeat`; trust-set views; all C.3 events declared. No pause and no admin path that can move a market (D20). A test-only harness that can place a Resolution in any state.
- Done when: every trust-set rule, every revoke and every access check has a test.
- Check: cd oracle && forge test --match-path test/unit/OracleTrustSets.t.sol
- Notes: Team decisions: one file `src/ResolutionOracle.sol` (plan layout); `BadTrustSet(0)` = no such trust set and guardian mistakes revert (ADJ-31); keeper functions will return false instead of reverting on a wrong state (O14.2-O14.4). Heartbeat authorization counts, per address, the trust sets naming it as non-revoked watchdog, so a watchdog of any set (active or not) beats until every one of its sets revokes it. `watchdogOf` returns 0 before the halt (nothing pinned). Market views return empty values for an unknown id; mutating calls will revert `UnknownMarket`. Solady `EIP712` domain ("ErosResolutionOracle", "1"); the digest views and `is IResolutionOracle` come in O16.1. Sim-mode setters and `lockProduction` are O15.2 (the `simModeAllowed`/`simMode` flags are set here). 31 mutations caught.

### O14.2 · Halt, request, escalate and open
- Owner: OA
- PD: 0.75
- Depends: O14.1
- Plan: §5.3, §5.4, §6.4, §7.3, D3, D4, D16, ORC-11, ORC-12, ADJ-32
- Cut: yes
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleHalt.t.sol, oracle/test/unit/OracleFixture.sol
- Build: `haltScheduled` (from None, EarlyCheck, EarlyReview at ≥ T; copy `haltedAt = economicHaltAt` and `oiHaltLots` from the engine; `voidDeadline = max(haltedAt, T) + voidSecs` set once; pin trust set and globals version; L1Pending or L2Pending with `l2StartedAt = haltedAt`; `HaltRecorded`); `requestResolution` (`NoFeed`, `TooEarly`, halts first, per-market `minRequestInterval`, `ResolutionRequested`); `escalateToL2`; `openAfterDeadline` (early-halted markets stay committee-only until T; `retryOpensAt`); `getL1Job`. No-op returns instead of reverts per §5.4.
- Done when: a late scheduled halt copies `economicHaltAt = T`; `voidDeadline` and pinning are correct; rate-limit and every no-op return are tested.
- Check: cd oracle && forge test --match-path test/unit/OracleHalt.t.sol
- Notes: Keeper no-op policy per ADJ-32 (team decision): `haltScheduled` before T and every wrong state return false. Engine errors bubble unchanged; a halt snapshot with `halted == false` reverts `EngineCallFailed` (team decision). The halt copies the engine snapshot as is (ORC-11, even a skewed `economicHaltAt`) and computes `voidDeadline` from `max(haltedAt, T)`. `requestResolution` reverts `NoFeed`, then `TooEarly` before `T + bufferSecs` (no halt then), halts a pre-halt market, and rate-limits with the pinned globals version. New shared `test/unit/OracleFixture.sol`: real registry, treasury and oracle harness wired through precomputed addresses, `MockMarketFactory` engines, a token-moving venue, one active trust set with real committee and attestor keys. The harness can clear `activeTrustSetId` to test the halt's defensive `NoActiveTrustSet` guard. 31 mutations caught (one needed a test moved past the rate limit).

### O14.3 · Committee and permissionless proposals
- Owner: OA
- PD: 0.75
- Depends: O14.2
- Plan: §5.4, §6.4, D7, D17, ORC-6
- Cut: yes
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleProposals.t.sol, oracle/test/unit/OracleFixture.sol
- Build: `submitReviewedProposal` in Review/Open (pinned set, outcome ∉ `rejectedMask`, attempt and mask match, evidenceURI hash and length) and from EarlyReview (before T, within the TTL, `early == true`, calls `engine.halt()`, pins the active set, records the halt) using SigLib; `proposePermissionless` in Open (own bond via the venue, `rewardAtoms` from the pinned globals, `proposer`, attempts++). `ProposalRecorded`.
- Done when: each guard has an accepting and a rejecting test; an early committee proposal halts the engine with `haltedAt = block.timestamp`.
- Check: cd oracle && forge test --match-path test/unit/OracleProposals.t.sol
- Notes: An EarlyReview proposal at or after T, or once the early TTL has run out, reverts `WrongState(EarlyReview)` (the market then halts on schedule or `expireEarly` returns it to None). Early proposals pin the active set and must carry `early == true` and that set id; the halt is recorded only after the signatures verify. Payload checks run in the order marketId (7), deadline (`SignatureExpired`; `now == deadline` is still valid), attempt (2), mask (6), early flag (1), trust set (4), evidence URI (5), outcome. The permissionless evidence URI follows the committee rule (1–256 bytes) and its hash must be non-zero (`BadPayload(5)`). The shared assertion internals (`_assert`, `_bond`, `_liveness`, `_claim`) land here because the permissionless path asserts in the same call; O14.4 reuses them. The redundant `outcome == 0` range check was removed after a surviving mutant (NONE is refused by `_checkOutcome`). OracleFixture gains the lifecycle and committee-signing helpers. 20 tests; 35/36 mutations caught, the survivor fixed by that removal.

### O14.4 · Assertions, finalize, reject and void
- Owner: OA
- PD: 1.25
- Depends: O14.3
- Plan: §5.4, §6.4, §6.5, D1, D2, D9, D10, D11, ORC-2, ORC-3, ORC-5, ORC-8, ORC-9, ADJ-27
- Cut: yes
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleAssertions.t.sol
- Build: `assertProposal` (attempts < 3, outcome not rejected, `now + liveness ≤ voidDeadline`, `TreasuryShort`, `fundAssertion`, venue `assertOutcome` with `renderClaim`, `Asserted`); `bondFor`, `livenessFor` (heartbeat fallback), `renderClaim`; `syncAssertion`; `finalizeMarket` (`trySettle`, then `statusOf`); `_final` (engine `settle(1)`/`settle(0)`/`settleInvalid()` in the same transaction, treasury booking per final reason, `releaseListing`); `_reject` (mask, Review with `retryOpensAt`, Voided → Final INVALID when YES and NO are both rejected); `voidMarket` (applies a settled or settleable assertion first, `markStuck` for a live team bond).
- Done when: the §11.1 "Assertion lifecycle", "Void", "Treasury bookkeeping per final reason" and "Liveness fallback" cases pass against `MockAssertionVenue` and `MockResolutionEngine`; an engine revert rolls the oracle transaction back.
- Check: cd oracle && forge test --match-path test/unit/OracleAssertions.t.sol
- Notes: Team decisions: a rejection applied by `voidMarket` (venue settled false at or after `voidDeadline`) is booked as a rejection (`onBondLost`, mask bit, `AssertionRejected`) and the market is then voided in the same call (VOID_DEADLINE); keeper functions return false or NOT_READY (ADJ-32); `TreasuryShort(need, have)` is checked before `fundAssertion`, whose own errors (e.g. `PerMarketCapExceeded`) bubble; engine reverts bubble and roll the whole call back (S-02), and `settle*`'s `newlyAccepted` is ignored (a duplicate is harmless, a conflict reverts). Attempt keys per ADJ-27 (`attempts` before the increment; `attempts − 1` when booking). The retry window is the market's listing-time copy (`MarketCore.retryWindowSecs`). `_reject` also clears `rewardAtoms` with `proposer` on the permissionless path. Views: `bondFor` is 0 before the halt (no OI or venue pinned); `livenessFor` gives the reviewed liveness while no proposal is recorded; `renderClaim` is empty without a proposal; all three are 0/empty for an unknown market. 29 tests; 51 mutations: 45 caught first, 6 survivors closed: 2 by new tests (ledger exactly the bond, NO rejected first), 3 by asserting the oracle never calls `onBondLost`/`markStuck` where §5.4 books nothing, and 1 redundant `livenessFor` check removed.

### O14.5 · Early check and the Layer 2 panel paths
- Owner: OA
- PD: 0.75
- Depends: O14.4
- Plan: §5.4, §6.4, §8.5, §8.6, D5, ORC-15
- Cut: no (in the cut `requestEarlyCheck` reverts `NotSupported`)
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OraclePanel.t.sol
- Build: `requestEarlyCheck` (market monitor only, before T, engine `monitorRestricted`); `expireEarly`; `submitPanelResult` routing (EarlyCheck → EarlyReview or None; L2Pending → stay on ≥ 2 NOT_YET, Proposed on the auto gate, Review otherwise); `submitPanelProposal`; `_autoGate` (unanimous YES/NO, confidence floor, category validated with matching gateHash and `validatedAt ≤ haltedAt`, U95 and N limits, review limit, POST_T, `flags == 0`, evidence present) using the pinned globals version.
- Done when: every routing row of §5.4 is tested; a category validated after the halt does not open the gate; revoking one closes it at once; L2_AUTO never happens before T.
- Check: cd oracle && forge test --match-path test/unit/OraclePanel.t.sol
- Notes: Implemented in full (not the cut's `NotSupported`). `requestEarlyCheck` reverts `Unauthorized` for anyone but the market's monitor, `WrongState` outside None or at/after T (as early proposals in O14.3), and `EngineCallFailed` while the engine's `marketRiskView().monitorRestricted` is false (S-09; the same "engine not in the expected state" error as the halt check). `expireEarly` returns to None with `EarlyCheckCleared(1)` and clears `earlyStartedAt`; an unknown early result clears with reason 0. An EARLY result routed to EarlyReview restarts the TTL (`earlyStartedAt = now`, §5.4). Panel payload checks run marketId (7), deadline (`SignatureExpired`, `now == deadline` valid), attempt (2), trust set (4: active set in EarlyCheck, pinned in L2Pending), evidence URI (5), phase (1), gateHash (3), then the attestor signature (`BadSignature`, also for a revoked attestor or a non-65-byte signature). `PanelResultAccepted` is emitted for every accepted result with the state it routed to (L2Pending for NOT_YET, which also emits `PanelNotYet`). Gate codes in C.3 order; the category needs `validated`, the market's gateHash and `validatedAt ≤ haltedAt`, with U95/N and the review limit read from the pinned globals version. ORC-15 holds by construction: L2Pending is only entered at or after T, and an early-halted market rejected before T sits in Review where a panel result reverts `WrongState` (tested). 27 tests; 51 mutations: 48 caught first, 2 survivors (middle label, middle confidence) closed by new cases, 1 re-run with a unique pattern and caught.

### O14.6 · Exclusive groups
- Owner: OA
- PD: 0.5
- Depends: O14.4
- Plan: §5.4, D6, ORC-7
- Cut: no
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleGroups.t.sol, oracle/src/MarketRegistry.sol, oracle/test/unit/RegistryCreateRules.t.sol
- Build: YES lock taken at assertion; another holder → `assertProposal` returns false; released on rejection or void; kept on Final YES (`finalYes`); a YES in a group with a Final YES → Review with `proposed = NONE` and `retryOpensAt = now + retryWindow` (no attempt used); `GroupLock`, `GroupConflict`; `groupState` view.
- Done when: the §11.1 "Groups" cases pass, including the conflict on a feed market where `l2StartedAt == 0`.
- Check: cd oracle && forge test --match-path test/unit/OracleGroups.t.sol
- Notes: Only exclusive groups (`MarketCore.groupExclusive`) have a YES lock; non-exclusive groups are just labels. `assertProposal` on a YES: a Final YES in the group → Review (`proposed = NONE`, `retryOpensAt = now + retryWindow`, `GroupConflict`, no attempt, returns false); another member holding the lock → false (waits); else takes the lock (`GroupLock(.., true)`). `proposePermissionless` YES reverts `GroupYesTaken` when the lock is held or a Final YES exists, and takes the lock otherwise; `submitReviewedProposal` YES reverts `GroupYesTaken` only after a Final YES (§5.4), so a YES recorded while another YES is live waits at `assertProposal`. Panel and L1 YES proposals are recorded and meet the conflict at `assertProposal` (tested on a feed market with `l2StartedAt == 0`). The lock is released on rejection (including the YES-and-NO void) and on a VOID_DEADLINE void (`GroupLock(.., false)`), and kept on Final YES, which also sets `finalYes`. Team decision (agreed one-line flip): `MarketRegistry._groupsEnabled()` now returns true, so grouped listings are accepted; the rules harness keeps its own switch so the disabled branch stays tested (test renamed `test_rule1_groupsSwitchedOff`). Cleanup after O14 (team decision): the switch itself was then removed, with its harness toggle and the test of the disabled branch; `EarlyCheckOrGroupsDisabled` stays declared in the frozen `IMarketRegistry` but nothing raises it. 17 tests; 21/21 mutations caught (19 first; the redundant Final-YES term in the permissionless check was removed because a Final YES keeps the lock, and a new test covers a non-holder's rejection).

## O15 · CRE receiver
Plan §13: owner OA · 1.5 PD · depends O14 · acceptance: §11.1 onReport tests; 64-byte metadata through a header-faithful mock.

### O15.1 · `onReport` production path
- Owner: OA
- PD: 0.75
- Depends: O14.5, O14.6
- Plan: §6.4, §7.1, D12, ORC-4, V-C7, V-C8
- Cut: yes
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/mocks/MockKeystoneForwarderLite.sol, oracle/test/unit/OracleReport.t.sol, oracle/test/unit/OracleTrustSets.t.sol
- Build: `MockKeystoneForwarderLite` builds the 109-byte header exactly like `KeystoneForwarder` and passes `rawReport[45:109]` as metadata. `onReport`: production auth (pinned set is production, sender = its forwarder, metadata ≥ 62, workflow ID accepted and not revoked, owner, optional name), decode report v1, `BadReport` codes 1–6, effects, `ProposedL1`; `supportsInterface` true for `0x805f2132` and `0x01ffc9a7`.
- Done when: every §11.1 onReport revert case, replay after proposal/escalation/Final, and 64-byte metadata acceptance pass; `onReport` uses < 150k gas.
- Check: cd oracle && forge test --match-path test/unit/OracleReport.t.sol
- Notes: Team decisions: check order is the 256-byte report v1 layout (`BadReport(1)`; it is needed to find the market), `UnknownMarket`, `WrongState` (only L1Pending, so the pinned trust set exists), then the sender against that set (`Unauthorized` for anyone but its forwarder, then `ProductionSetRequired`, `BadMetadata`, `WrongWorkflow`), then `BadReport` 1-6; every path reverts with no effect, so the order changes only the error. The report is read as eight uint256 words, so an out-of-range or dirty word fails its own code instead of a raw decoding revert. Workflow ID 0 never matches an empty second slot; the metadata's reportId (bytes 62-64) is not read. `T + bufferSecs` is copied from the registry in `initResolution` (both immutable, ORC-1): reading the whole FeedSpec in `onReport` cost 137k-198k gas cold, growing with the spec's string lengths, while one CRE `writeGasLimit` serves every market; now `onReport` is about 86k cold (call included) and flat in the spec size (tested). `initResolution` therefore reads the registry's market views, and `OracleTrustSets` mocks `getMarketCore` for its EOA registry. No group rule in `onReport`: an L1 YES meets it at `assertProposal` (O14.6). The sim-mode branch is O15.2; until then a market pinned to a sim set gets `ProductionSetRequired`. `MockKeystoneForwarderLite`: header layout of §7.1/V-C7, ERC-165 detection as OpenZeppelin's ERC165Checker, the V-C8 transmission rule; its transmission id is a simplified keccak of receiver, execution id and report id, not claimed identical to Chainlink's. Gas is measured with a low-level call on pre-encoded calldata and `vm.cool`, so the caller's memory and warm slots are not counted. 9 tests; 28/28 mutations caught. Fix after CI (Foundry 1.8.3) failed `test_gas_independentOfFeedSpecSize` from `acbc41f` on (2,560 gas apart): 1.8.3 isolates each test call (`isolate = true` by default; 1.5.1 had it off), and the first of the two measured calls found the oracle account warm, the second cold; both `onReport` frames cost the same (110,374 and 110,362). The helper now touches the oracle account after `vm.cool`, so every measured call pays the warm account price while the slots stay cold, and `test_gas_underBudget` adds the 2,500 cold-account surcharge back. The 500-gas tolerance is kept: a budget-only check would pass the old FeedSpec read (139k cold for the short spec under 1.5.1), which the independence check catches under both versions (60.7k apart). Under 1.8.3 the figures include the 21,000 intrinsic gas of the isolated call: cold `onReport` is 113,441 with the surcharge (88,473 under 1.5.1).

### O15.2 · Sim mode and `lockProduction`
- Owner: OA
- PD: 0.75
- Depends: O15.1
- Plan: §6.4, §7.5, D13, ORC-13, V-C9
- Cut: yes
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleSimMode.t.sol
- Build: `setSimForwarder` and `setSimRelayer` (Timelock, only while sim mode); sim path (sender = sim forwarder, `tx.origin` is a relayer, pinned set not production, metadata skipped); production-forwarder reports still accepted while sim mode is on; `lockProduction` (one-way, needs an active production set with forwarder, workflow ID and owner; clears the sim forwarder).
- Done when: the §11.1 "Sim mode" cases pass, including sim mode impossible under `vm.chainId(143)` and a mock-forwarder report reverting after the lock.
- Check: cd oracle && forge test --match-path test/unit/OracleSimMode.t.sol
- Notes: Team decisions: the sim path is taken only when sim mode is on and the sender is the configured sim forwarder (§6.4 branches on the sender); a relayer `tx.origin` that is not allowed, or a production-pinned market, reverts `Unauthorized` there (C.3 has no dedicated error). The sim path skips only the metadata: the report content (`BadReport` 1-6, state, replays) is checked as on the production path. Any other sender takes the production path, so the sim set's own forwarder gets `ProductionSetRequired` when it is not the sim forwarder, and after the lock (ORC-13, E11). `setSimForwarder(0)` disables the sim path without ending sim mode. `lockProduction` is repeatable rather than reverting once sim mode is off, because §12.6 calls it on mainnet before the first listing, where sim mode is off from the constructor; each call requires the active set to be a production set with a forwarder, a workflow owner and a workflow ID that is not revoked (a set whose IDs are all revoked is refused), then turns sim mode off and clears the sim forwarder; relayers are kept but unreachable. Nothing turns sim mode back on (the setters revert `SimModeOff`). Governance may still activate a sim set after the lock; markets pinned to it get no reports and time out into Layer 2 (D13, tested). `simForwarder` is packed with `simMode`, so the production path pays one extra cold slot (cold `onReport` 88,473 gas with the call, was 86,164, both under Foundry 1.5.1; 113,441 under CI's 1.8.3, which adds the isolated call's intrinsic gas, see O15.1). ResolutionOracle is now 41,215 B runtime, slightly above the §6.9 estimate of 25-40 KiB and within Monad's 128 KiB. 6 tests; 19 mutations: 15 caught (one after a new case: a sim set that names a workflow and owner cannot be locked), 4 equivalent and kept as plan-listed defence: the `simMode` and `simModeAllowed` terms of the sim path (the sim forwarder can only be non-zero while sim mode is on) and the `lockProduction` forwarder and owner checks (`createTrustSet` already requires both for a production set).

## O16 · EIP-712 panel and committee
Plan §13: owner OA · 1.5 PD · depends O14 · acceptance: signature test vectors shared with oracle-sdk.

### O16.1 · EIP-712 views and shared vectors
- Owner: OA
- PD: 0.5
- Depends: O14.5, O14.6
- Plan: §6.4, D7, C.7, V-R4, ADJ-15
- Cut: no
- Status: done
- Files: oracle/src/ResolutionOracle.sol, oracle/test/unit/OracleEip712.t.sol, oracle/vectors/eip712.json
- Build: `hashPanelResult`, `hashReviewedProposal`, `domainSeparator` views; deploy the oracle at `0x…AA` on chainId 10143 (`deployCodeTo`) and assert the P1 and R1 digests from `vectors/eip712.json`; add signed examples (fixed test keys) to the vector file for oracle-sdk.
- Done when: both digests match C.7 through the oracle's own views.
- Check: cd oracle && forge test --match-path test/unit/OracleEip712.t.sol
- Notes: The three views are `_hashTypedData(SigLib.hash…)` and Solady's `_domainSeparator()`, the same digest the panel and committee checks verify; with them the contract implements all of C.3 and now declares `is IResolutionOracle` (errors and events keep their qualified names). Solady's ERC-5267 `eip712Domain()` is also exposed and tested. The vector oracle is deployed with `deployCodeTo` at `0x…AA` on 10143, so its constructor runs there and the cached domain is C.7's; expected separators are built in the test from the vector file's domain strings, not with SigLib. Also tested: the separator changes with the chain (`vm.chainId(143)`) and the address (`0x…BB`), and signatures made over the views are accepted by the fixture oracle's `submitPanelResult` and `submitReviewedProposal`. `vectors/eip712.json` gains `domainSeparator` and a `signed` section for oracle-sdk (O30.2): P1 signed by test key 1, R1 by test keys 2 and 3 (signers ascending), 65-byte r‖s‖v, v 27/28, low s; RFC 6979 nonces make the signatures reproducible, and Foundry `vm.sign`, `cast wallet sign --no-hash` and viem 2.57.2 `signTypedData` gave identical bytes (viem also gave the same separator and P1/R1 digests). The test keys are public and must never be funded. ResolutionOracle is 41,545 B runtime (was 41,215). 4 tests; 6/6 mutations caught (separator zeroed, struct hash returned without the domain, wrong struct hashed, domain name or version changed).

### O16.2 · Panel signature and payload rejections
- Owner: OA
- PD: 0.5
- Depends: O16.1
- Plan: §6.4, §11.1, ADJ-15
- Cut: no
- Status: done
- Files: oracle/test/unit/OraclePanelSigs.t.sol
- Build: `submitPanelProposal` and `submitPanelResult` reject: split labels, confidence below θ_hi, unvalidated category, gateHash mismatch, OI above the review limit, `flags != 0`, wrong attempt, wrong trust set, expired deadline, wrong signer, revoked attestor, URI hash or length mismatch, wrong phase.
- Done when: each rejection asserts its exact error and code (C.3).
- Check: cd oracle && forge test --match-path test/unit/OraclePanelSigs.t.sol
- Notes: Every payload and signature rejection runs on each panel entry point: `submitPanelResult` in EarlyCheck (phase EARLY, active set), `submitPanelResult` in L2Pending and `submitPanelProposal` in L2Pending (phase POST_T, pinned set). Each case changes one field of a valid result and re-signs it over the oracle's `hashPanelResult` view (O16.1), so only the check under test can fail, and each entry point ends with the valid result accepted. Payload: marketId (7), expired deadline (`SignatureExpired`; a result signed to expire this second is accepted), attempt 1 and 255 (2), trust set 0 or nonexistent (4), evidence URI hash mismatch, empty and 257 bytes (5; 256 accepted), phase wrong, NONE or out of range (1), gateHash (3). `BadSignature`: another key or a committee member, a payload changed after signing (labels, ĉ, evidenceHash, flags, deadline), a signature for chainId 143 or another oracle address, the raw struct hash, an `eth_sign` message, the high-s twin (checked to recover the attestor), `v` in {0, 1}, 0, 64 and 66 bytes. Trust sets: after a rotation L2Pending keeps the pinned set and EarlyCheck uses the active one, naming the other set is `BadPayload(4)` and the other set's attestor is `BadSignature`; a revoked attestor is refused on every entry point, and revoking another set's attestor changes nothing. Gate: split, a confidence below θ_hi, no category, a category recorded for the market's gateHash but not validated, OI above the review limit, flags and no evidence revert `submitPanelProposal` with `GateClosed` 1-6, and the same signed result sent to `submitPanelResult` is accepted and routed to Review with no proposal. State: `WrongState` in None, L1Pending, EarlyCheck (proposal), Review and Proposed, including a replay of an accepted result; `UnknownMarket`. Boundaries already in `OraclePanel.t.sol` (θ_hi, the exact review limit, validation at the halt block) are not repeated. No contract change. 5 tests; 28 mutations of `_checkPanel`, `_checkURI`, `_autoGate`, the entry points and SigLib's attestor check, scored on this suite alone: 27 caught (two after adding the deadline boundary and the recorded-but-unvalidated category), 1 equivalent: SigLib's `v ∈ {27, 28}` check, because `ecrecover` returns 0 for any other `v` and the attestor is never 0.

### O16.3 · Committee signature rejections and ERC-1271
- Owner: OA
- PD: 0.5
- Depends: O16.1
- Plan: §6.4, §11.1, ADJ-15
- Cut: no (basic committee checks are already in O14.3)
- Status: done
- Files: oracle/test/unit/OracleCommitteeSigs.t.sol, oracle/test/mocks/MockERC1271Wallet.sol
- Build: Below threshold, duplicate signer, non-member, revoked member, unsorted signatures, rejected outcome, wrong `rejectedMask`, wrong attempt, expired deadline, `early` flag mismatch, an ERC-1271 member accepted; after a rejected early proposal `openAfterDeadline` returns false until T.
- Done when: every case passes with its exact error.
- Check: cd oracle && forge test --match-path test/unit/OracleCommitteeSigs.t.sol
- Notes: Every payload and signature-set rejection runs in each state a committee proposes from: Review and Open (pinned set, `early = false`) and EarlyReview (active set, `early = true`), each reached through the real flow (a panel result failing the gate, the L2 deadline, an early check with a confident unanimous panel), not forced; each case changes one thing of a valid proposal signed over the `hashReviewedProposal` view (O16.1), and each state ends with the valid proposal accepted. Payload: marketId (7), expired deadline (`SignatureExpired`; a proposal signed to expire this second is accepted), attempt 1 and 255 (2), rejectedMask claiming YES or an unused bit (6), `early` flipped (1), trust set 0 or nonexistent (4), evidence URI (5), outcome NONE, 4 and 255 (`OutcomeNotAllowed`). Signature sets: zero or one signature (`NotEnoughSignatures`), duplicate, unsorted or zero signer (`SignersNotSorted`), a non-member and a revoked member (`NotCommitteeMember(signer)`), and `BadSignature` for a payload changed after signing, another member's signature, another chain or oracle, the raw struct hash, an `eth_sign` message, and a bad third signature after two valid ones (every listed signature is checked). Accepted forms, pinned so a change is deliberate: SignatureCheckerLib accepts a high-s twin and an EIP-2098 64-byte signature from an EOA member, which is safe because no signature is an identifier (a replay fails on state, attempt, mask and deadline; tested). Trust sets: after a rotation Review keeps the pinned committee (a set-2-only member is `NotCommitteeMember`, a set-2 revocation changes nothing) and EarlyReview uses the active one (naming set 1 is `BadPayload(4)`; the early halt pins set 2). ERC-1271: `MockERC1271Wallet` (a 1-of-1 Safe stand-in: its owner's ECDSA signature over the hash) is accepted as a member; a wrong digest, a wrong magic value, a revert and empty return data are `BadSignature`; the owner signing as itself and a revoked wallet are `NotCommitteeMember`. After a rejected early YES (attempt 1, mask 2, Review before T): the old attempt (2), the old mask (6), `early = true` (1), the rejected YES (`OutcomeNotAllowed`) and the original early signatures are refused; `openAfterDeadline` returns false at `retryOpensAt` and at T - 1, true at T; the committee may still propose NO before T. No contract change. 6 tests; 28 mutations of `_checkReviewedPayload`, `_checkOutcome`, the set selection, `_verifyCommittee`, SigLib's m-of-k check and `openAfterDeadline`, scored on this suite alone: 27 caught; the survivor (an early proposal allowed at exactly T) is a timing guard caught by `OracleProposals.t.sol` (O14.3).

## O17 · Invariants and seam tests
Plan §13: owner OA · 3 PD · depends O14–O16 · acceptance: `FOUNDRY_PROFILE=ci forge test` green.

### O17.1 · Stateful handler
- Owner: OA
- PD: 1
- Depends: O15.2, O16.2, O16.3
- Plan: §5.5, §11.1
- Cut: no
- Status: done
- Files: oracle/test/invariant/OracleHandler.sol, oracle/test/invariant/OracleInvariants.t.sol
- Build: A handler that calls every external function of the oracle, registry and treasury with bounded random inputs, time warps, venue outcomes (true, false, never answered, settled directly) and engine knobs, and keeps ghost variables for the invariants.
- Done when: a smoke invariant (`true`) runs at the default profile with no handler revert loops dominating the calls.
- Check: cd oracle && forge test --match-path test/invariant/OracleInvariants.t.sol
- Notes: The handler deploys and wires the real ResolutionOracle (not the harness), MarketRegistry and BondTreasury with the sim set 1 active and the production set 2 created, and reaches every state-changing function of the three contracts through 14 fuzzed selectors: listing (at most 4 live markets, 16 in all, with and without a feed, some in an exclusive group), time warps, single keeper calls (`keeper`) and a whole keeper tick, the early check, Layer 1 reports (KeystoneForwarder mock with the production metadata, or the sim path; the workflow waits for T + bufferSecs), signed panel results and proposals, committee proposals (outcomes not yet rejected), permissionless proposals, venue outcomes (true, false, disputed, settled directly, never answered), disputes and their closing, the heartbeat, and `admin` (treasury flows, registry and oracle governance including `lockProduction` after activating the production set, guardian revocations on one call in four, engine knobs, and unauthorized calls to every restricted entry point). Markets are picked in a state where the action can act; one call in eight takes any market, so calls in the wrong state still happen. Every system call is in try/catch: the handler never reverts (checked with `fail_on_revert` at the `ci` profile: 32,768 calls, 0 reverts), and per action it counts calls, inner reverts (with their error selector) and no-ops. Ghosts for O17.2, latched as flags after every action: registry views unchanged since listing (ORC-1), mask monotone and no proposal of a rejected outcome (6), one live assertion at a time (5), voidDeadline and trustSetId set once (12, 13), nothing changes after Final (8), reports accepted only in L1Pending and none on a sim set after the lock (4, 13), no non-REVIEWED proposal before T (15), ledger decreases only through their own path or the Timelock (10), and any unauthorized success. `test_handlerReach` drives the handler deterministically (32 runs of 128 calls, the `ci` depth, gas metering paused) and asserts that every state and every final reason is reached, that Layer 1 proposals and production locks happen and that inner reverts stay under half; measured: 6% inner reverts, every RState entered (Voided is transient), 5-7 ASSERTED_TRUE, 2 REJECTED_YES_AND_NO (steered: after a first rejection the venue answers false half the time), 6-7 VOID_DEADLINE, about 10 Layer 1 proposals and 9 locks, no ghost flag raised. Smoke invariant: default profile 64 x 64 and `ci` 256 x 128 (about 20 s) pass under Foundry 1.5.1 and 1.8.3.

### O17.2 · Invariants ORC-1 to ORC-15
- Owner: OA
- PD: 1
- Depends: O17.1
- Plan: §5.5, D20, ORC-1, ORC-2, ORC-3, ORC-4, ORC-5, ORC-6, ORC-7, ORC-8, ORC-9, ORC-10, ORC-11, ORC-12, ORC-13, ORC-14, ORC-15
- Cut: no
- Status: done
- Files: oracle/test/invariant/OracleInvariants.t.sol, oracle/test/invariant/OracleHandler.sol
- Build: One `invariant_` function per ORC row of §5.5.
- Done when: all fifteen hold at the `ci` profile (10,000 fuzz, 256×128 invariant).
- Check: cd oracle && FOUNDRY_PROFILE=ci forge test --match-path test/invariant/OracleInvariants.t.sol
- Notes: One `invariant_ORCn_*` per §5.5 row plus `invariant_D20_noUnauthorizedCall` (no restricted entry point ever accepted an outsider). Facts that only show between two calls are latched by the handler's ghosts and read here (ORC-1, 4, 5, 6, 8, 10, 12, 13, 15); the rest are checked on the state: ORC-2 the engine settled exactly when the market is Final, once, with the outcome the oracle finalized (mapped explicitly: the engine orders NO before YES); ORC-3 a Final market is ASSERTED_TRUE with its last assertion settled true on the venue, or voided INVALID at or after voidDeadline, or with YES and NO both in the mask; ORC-5 one attempt per opened assertion, at most 3, the live one the last; ORC-6 no recorded proposal of a rejected outcome and the mask holds only outcome bits (an INVALID proposal can be rejected too: it goes back to Review, only YES and NO together void); ORC-7 at most one Final YES per exclusive group, `finalYes` and the lock holder consistent, every live YES assertion held by the lock holder; ORC-9 on a snapshot, every unhalted market is halted at T and every halted non-Final market reaches Final at voidDeadline through calls by a stranger (the engine's reverting-`settle` test knob is switched off first: a reverting engine blocks every Final by design, S-02); ORC-11 haltedAt and oiHaltLots equal the engine's halt snapshot; ORC-12 voidDeadline is 0 before the halt and `max(haltedAt, T) + voidSecs` after; ORC-13 the trust set is pinned exactly at the halt and the lock ends sim mode; ORC-14 the treasury's token balance covers its three ledgers. Handler changes for the invariants (after O17.1): `pokeFinal` calls every permissionless entry point on a Final market (half the time after its voidDeadline); treasury actions have their own selector and withdrawals probe the ASSERTION floor (whole ledger, exactly to the commitments, one atom past them; the amount is deposited back so the run does not stall); after a rejection one call in four retries a rejected outcome and the others mostly propose the other binary outcome, and markets with a rejection get priority; half the time a keeper runs `finalizeMarket` right after a venue answer (a scripted answer used to be overwritten before anyone applied it: 8 rejections in 64 driver runs, now 27); venue answers go to assertions the oracle is waiting on. 16 fuzzed selectors; `test_handlerReach` now drives 64 runs of 128 calls. Mutation check, 10 planted bugs, one per rule family: caught at the default profile: void before the deadline (ORC-3), reports in any state (ORC-4, and 2, 8, 9, 15), void after Final (ORC-2), void skipping a live assertion (ORC-9), the lock keeping sim mode (ORC-13), an early committee proposal not REVIEWED (ORC-15), a withdrawal below the commitments (ORC-10), skim crediting the whole balance (ORC-14); caught only at the `ci` profile (in 1.5.1 each invariant runs its own 4,096-call campaign): a rejected outcome proposed again (ORC-6) and the group YES lock ignored (ORC-7). Results: all invariants hold at the `ci` profile under Foundry 1.8.3 (one campaign checking all 16 after every call: 256 runs, 32,768 calls, 0 handler reverts) and at the default profile under 1.5.1. The full `ci` suite now takes about 3 minutes locally (was 30 s), most of it the invariant campaign.

### O17.3 · Seam with B's real settlement code
- Owner: OA
- PD: 1
- Depends: O15.2, O16.2, O16.3
- Plan: §3.2, §3.4, §11.1, B.6, V-R1
- Cut: no
- Status: done
- Files: oracle/test/seam/EngineHarness.sol, oracle/test/seam/Seam.t.sol
- Build: Add B.6 `EngineHarness` (B's real `SettlementController` with B's `MockBookAdapter` and `MockAccountingPort`, imported through remappings; no `*.t.sol` import) with `resolutionAuthority = ResolutionOracle`, and drive it through the real oracle.
- Done when: early YES claimable before T; early INVALID pending until the T capture; a late scheduled halt gives `haltedAt = T`; a conflicting delivery reverts the oracle transaction so the oracle does not become Final; the full suite is green at the `ci` profile.
- Check: cd oracle && FOUNDRY_PROFILE=ci forge test
- Notes: `EngineHarness` is B.6 as B composes it in its own suite (B036): the real `SettlementController` (resolution ingress, halt, finality latch, INVALID price, settlement jobs) with B's `MockBookAdapter` and `MockAccountingPort`, imported through `@eros/`, `@eros-test/mocks/B/` and `@eros-provisional/` (no `*.t.sol`). B.6's listing fixture is replaced by `SeamFactory`, an `IMarketFactory` the real MarketRegistry calls: it deploys and initializes one harness from the listing the registry built (seam fields bound, `resolutionAuthority = ResolutionOracle`), so the registry's handshake runs against the real engine; `SeamFixture` keeps B.6's engine fields and risk profile. The real engine needs T at least a day after listing and `T + 1 h <= listedAt + voidSecs`, so the seam lists T at listing + 25 h with voidSecs 26 h (plan §14). B's accounting mock is scripted as B036 does (3 accounts, 100,000 lots frozen at the halt, a reconciled finish). Tests, through the oracle's own entry points: an early YES (monitor restriction, early check, panel, committee) halts the engine at block time with the same `economicHaltAt` and OI, settles it YES, and claims open through the engine's jobs before T; an early INVALID settles INVALID before T but payouts revert `OutcomeOrPricePending` until the engine captures the price from T (NOT_YET before T, WAIT_GRACE at T without index data, the disclosed 0.5 fallback at T + 1 h), then claims open; a scheduled halt run two hours late gives `haltedAt = economicHaltAt = T`, `haltRecordedAt` the real time and `voidDeadline = T + voidSecs`; with a conflicting outcome already latched at the engine, `finalizeMarket` and the void (venue silent, INVALID) revert with the engine's `ConflictingFinalOutcome`, so the oracle stays Proposed and the venue settlement and bond booking roll back, while the same outcome latched first is accepted; only the pinned oracle can halt or settle the engine (`Unauthorized` for anyone else). 5 tests; 6 planted oracle bugs all caught: YES and NO swapped at the engine, INVALID delivered as NO, `haltedAt` copied from `haltRecordedAt`, and the engine's revert swallowed on the INVALID and on the NO delivery (the first caught only after adding the venue-silent void case). EngineHarness is 78,244 B, within the 128 KiB limit of `forge build --sizes`.

## O18 · Gas snapshots
Plan §13: owner OA · 0.5 PD · depends O17 · acceptance: budgets §6.9 met or justified.

### O18.1 · Gas snapshots and `gas.json`
- Owner: OA
- PD: 0.5
- Depends: O17.2, O17.3
- Plan: §6.9, §12.11
- Cut: no
- Status: done
- Files: oracle/test/gas/OracleGas.t.sol, oracle/.gas-snapshot, oracle/deployments/gas.json, oracle/src/libraries/ClaimRenderer.sol, oracle/test/parity/ClaimRendererV1.sol, oracle/test/parity/ClaimRendererParity.t.sol
- Build: One gas test per call type of §6.9 (`onReport`, `haltScheduled`, `assertProposal` with a 16 KiB claim, `finalizeMarket`, `createMarket`); write measured limits with margin into `deployments/gas.json`; record contract sizes.
- Done when: every budget is met or the excess is justified in `gas.json`; every contract is < 128 KiB.
- Check: cd oracle && forge snapshot --check --match-path test/gas/OracleGas.t.sol && forge build --sizes
- Notes: One test per §6.9 call type on the deployed stack: the real ResolutionOracle, MarketRegistry and BondTreasury, the real UMA OOv3 (loaded from its artifact files, so the run filtered to this file finds it) behind UmaAdapter, the testnet StubMarketFactory engine and B's real SettlementController (O17.3 harness) where the engine matters (halt, finalize, createMarket). One setUp prepares every state on one timeline (T at listing + 25 h, voidSecs 26 h, valid for both engines); each test makes one call with all storage cold. `transaction` includes the intrinsic gas and calldata under the CI toolchain (Foundry 1.8.3, isolation), the basis for each service's `limit` (about 1.2 x, rounded up); `execution` subtracts the same call to an empty contract and is compared with the §6.9 budget. The tests read `deployments/gas.json` and fail when a call exceeds its limit or its budget plus a recorded `excessAllowed`. Results (execution vs budget): onReport 79,676 vs 150k; haltScheduled 227,002 vs 200k + engine halt (stub 285,551; B's engine 540,230; the oracle's own part about 142k either way); finalizeMarket 229,493 / 235,732 vs 300k; createMarket 6.9M (stub) and 22.0M (B's 78 KiB engine) transaction, both under 30M. assertProposal was 953k for a normal claim and 1,227k at 16 KiB, about 430k of it in ClaimRenderer (the template re-validated on every render, every candidate token built with `string.concat` while scanning byte by byte). Team decision (agreed with the user): ClaimRenderer rewritten for gas with byte-identical output: one pass that validates as it renders (InvalidTemplate still wins over NoOutcome), `LibString.indexOf` to jump between double opening braces, tokens matched by one masked memory word against precomputed constants. Parity: the previous renderer is frozen as test-only `ClaimRendererV1` and `ClaimRendererParity.t.sol` fuzzes default, valid (random token order and literals) and arbitrary (malformed braces) templates plus edge cases, requiring the same bytes or the same revert, the same `isValidTemplate` and `worstCaseLength`; three planted renderer bugs were caught; the existing ClaimRenderer tests pass unchanged. After it assertProposal is 660,939 (639-byte claim) and 921,397 (16 KiB) execution, still about 51k and 63k (7-8%) above 600k + 16 x claim bytes: justified in gas.json (a fully cold transaction touching eight contracts, OOv3 reading UMA's Finder and Store, token approvals and the treasury's bookkeeping, plus OOv3's ~16.8 gas per claim byte), with `excessAllowed` 56k and 70k as regression bounds. The real-engine halt figure is provisional: B's MockAccountingPort logs every call to storage (340k for its halt against A's 72k measurement), so it is re-measured on A's accounting before mainnet. The CRE `writeGasLimit` stays at the plan's starting 400k until the real forwarder is simulated (measured through the mock forwarder: 148k transaction). Every contract is under 128 KiB (ResolutionOracle 41,199 B after the rewrite; the largest, test-only SeamFactory, 80,690 B). `.gas-snapshot` is generated with Foundry 1.8.3: `forge snapshot --check` must run with that version (1.5.1 has no isolation and measures less).

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
- Status: done
- Files: oracle/src/KeeperRouter.sol, oracle/test/unit/KeeperRouter.t.sol
- Build: `finalizeMany`, `assertMany`, `haltAndRequest`, each inner call in try/catch; no funds, no approvals.
- Done when: an engine revert on one market does not block the others; a `TooEarly` request never undoes the halt.
- Check: cd oracle && forge test --match-path test/unit/KeeperRouter.t.sol
- Notes: `KeeperRouter is IKeeperRouter` with constructor `(oracle)` (zero address refused, as the other contracts); it holds no funds, no approvals and no state but the oracle's address, and has no privilege. `finalizeMany` reports each status and whether the call reverted (a reverted call reports NOT_READY); `assertMany` reports false for a call with nothing to assert and for one that reverted (C.6 has no separate reverted array); `haltAndRequest` wraps `haltScheduled` and `requestResolution` separately and returns what each reported. Tests on the oracle fixture: a market whose engine reverts on `settle` (first in the batch) and an unknown id are caught while the markets after them finalize, with every status passed through (FINAL, REJECTED, DISPUTED, NOT_READY) and the reverted market finalized by the same batch once its engine recovers; assertions with nothing to assert, an unknown id and a bond the treasury refuses (per-market cap below the bond) report false without blocking the others; the halt stands when the request reverts TooEarly (before T + bufferSecs) or NoFeed, and the request goes out after the buffer; the router's token balance and allowances stay 0. 4 tests; 5/5 mutations caught (finalize or assert not wrapped, halt and request in one try, a status dropped, assertions always true). 1,754 B runtime (added to `deployments/gas.json`).

### O19.3 · DeployUmaSandbox and DeployOracle
- Owner: OA
- PD: 0.75
- Depends: O19.1, O19.2
- Plan: §12.4, §12.5, §12.11, C.1
- Cut: yes
- Status: done
- Files: oracle/script/DeployUmaSandbox.s.sol, oracle/script/DeployOracle.s.sol, oracle/deployments/params.monad-testnet.json, oracle/src/testnet/TestUSDC.sol, oracle/test/unit/TestUSDC.t.sol, oracle/.gitignore
- Build: `TestUSDC` (TESTNET ONLY, 6 decimals, capped faucet mint, no other knobs; `seam-decisions.md` S-13), deployed first by the sandbox script when no bond token address is given. Sandbox script in the eight steps of §12.4 (USDC bond token, ErosSandboxOracle replacing MockOracleAncillary, final asserts on owner and requester). Oracle script: precompute every address, deploy in the §12.5 order (Timelock initialized in the same script), assert each address, refuse stubs on chainId 143, pass factory 0 on mainnet, write `deployments/<network>.json` in the §12.11 schema with code hashes and deploy blocks.
- Done when: both scripts run on anvil and on a fork of Monad testnet with every assertion passing.
- Check: cd oracle && forge script script/DeployOracle.s.sol --fork-url $MONAD_TESTNET_RPC
- Notes: `TestUSDC`: TESTNET ONLY, 6 decimals, an open faucet `mint` capped at 100,000 USDC per call, no other knobs, constructor refuses chainId 143 (tested). `DeployUmaSandbox` follows the eight steps of §12.4 (TestUSDC first when `BOND_TOKEN` is unset; UMA's 0.8.16 contracts loaded from their artifact files, so `forge build` runs first) and asserts the Safe owns the sandbox oracle, the requester is OOv3, the four Finder entries, the final fee, both whitelists, and OOv3's currency, liveness and minimum bond (2 x the final fee); it refuses chainId 143. `DeployOracle` precomputes every address (the Timelock's `initialize` counted as one nonce), deploys in the §12.5 order, asserts every address, every immutable link, the Timelock's roles and delay (Safe proposes and cancels, anyone executes, admin 0), sim mode by chain and that the deployer holds no role, and writes the §12.11 schema (code hashes; `deployBlock` is the chain head when the script ran, a lower bound for an indexer; trust sets, globals version, Timelock operations empty until O19.4; CRE workflow IDs and sim relayers filled in X01/O19.4). On chainId 143 it deploys no stub, passes factory 0 and requires a Timelock delay of at least 48 h. Team decisions: role and token addresses come from `params.<network>.json` with environment overrides (TEAM_SAFE, GUARDIAN_SAFE, USDC, OOV3); the committed testnet params keep zero placeholders for the X03 addresses and the scripts refuse a zero role; a zero bond token or OOv3 is taken from the deployments file the sandbox script wrote. Only a broadcast writes `deployments/<network>.json`; a simulation writes `deployments/dryrun/<network>.json` (gitignored with anvil's outputs), and `DEPLOYMENTS_DIR` redirects a broadcast to a local fork of a real network. Dry runs (Foundry 1.8.3): on anvil (needs `--code-size-limit 131072`, Monad's 128 KiB: anvil's default EIP-170 limit refuses MarketRegistry and ResolutionOracle) both scripts broadcast and every code hash, link, role and delay was then re-read on chain with cast; on a fork of Monad testnet (https://testnet-rpc.monad.xyz, chain 10143, block 67,628,326, through a local anvil fork so the second script sees the first one's contracts) both scripts broadcast to the fork and the same on-chain checks pass; a plain `forge script --fork-url` simulation runs the sandbox (about 9.6M gas, 1.97 MON estimated) but not DeployOracle after it, since separate simulations do not share state. Refusals checked: zero Safe placeholders (`ZeroAddress("roles.teamSafe (X03)")`), the sandbox on 143 (`MainnetRefused`), a 300 s delay on 143 (`DelayTooShort(300)`). Not exercised: the mainnet success path (needs UMA's mainnet OOv3: a Monad mainnet fork before the mainnet deploy). Nothing was broadcast to a public network.

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
