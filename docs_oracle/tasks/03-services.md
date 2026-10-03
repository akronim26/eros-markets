# Block 3 — Services (O30–O38)

Plan §8, §9, §13 rows O30–O38. Format and rules: header of `docs_oracle/check_tasks.py`. All
services are TypeScript on Node 22 with viem in the bun workspace (`oracle/services/*`), read
`deployments/<network>.json`, send every transaction with an explicit gas limit from
`deployments/gas.json`, and re-read state before acting (§9). Each service task that adds tests also
adds its CI job (ADJ-11). Secrets live in the cloud secret manager, never in git (§12.7).

## O30 · `packages/oracle-sdk`
Plan §13: owner OB · 1.5 PD · depends OG1 · acceptance: mirrors match Solidity vectors.

### O30.1 · ABIs and deployments loader
- Owner: OB
- PD: 0.5
- Depends: OG1
- Plan: §9, §12.11, ADJ-09
- Cut: no (the cut reads ABIs from forge output, ADJ-17)
- Status: done
- Files: oracle/packages/oracle-sdk/{package.json,src/abi/*,src/deployments.ts,test/*}
- Build: Copy the ABIs of every oracle contract from `forge inspect` into the package with a hash check against `oracle/abi/SHA256SUMS`; typed loader for `deployments/<network>.json` and `gas.json` (§12.11 schema).
- Done when: the hash check fails on any ABI drift and the loader parses the testnet file.
- Check: cd oracle/packages/oracle-sdk && bun test
- Notes: `@eros-oracle/oracle-sdk` (workspace member). `scripts/sync-abis.ts` (`bun run sync-abis`) runs `forge inspect <source>:<Name> abi --json` for the 11 Appendix C interfaces and the 9 deployed contracts (ResolutionOracle, MarketRegistry, BondTreasury, KeeperRouter, UmaAdapter, ErosSandboxOracle, TestUSDC, StubMarketFactory, ResolutionEngineStub; list in `src/abi/sources.ts`), writes `oracle/abi/<Name>.json`, regenerates `oracle/abi/SHA256SUMS` (now 20 files; the 11 O02.2 interface files are byte-identical) and writes `src/abi/<Name>.ts` (`as const` for viem types) stamped with the JSON's sha256; it replaces the manual regeneration command of O02.2. `forge inspect` output is byte-identical on Foundry 1.5.1 and 1.8.3. `src/deployments.ts`: zod schema of §12.11 (checksummed addresses, uint64 selector and final fee as bigint, the six core contracts required, StubMarketFactory optional), `loadDeployments(network, {expectChainId})` refusing another network or chain, `loadGas`/`gasLimit` (no limit is ever guessed for an unlisted call), `contractAddress`. 11 tests: SHA256SUMS lists exactly the files and every hash matches; every source has a snapshot and back; `forge inspect` of every source equals the snapshot (a planted function in IKeeperRouter fails it with "drifted ... run bun run sync-abis"); each SDK module is the generated form of its snapshot with the stamped hash; the oracle ABI has every call the services make; the loader parses DeployOracle's testnet output (the O19.3 fork dry run, committed as `test/fixtures/deployments.monad-testnet.json`; the live file is written at X04) and refuses a missing core contract, a bad address, a missing role, a selector above 2^53 written as a number, another network or chain, and invalid JSON; gas limits read from gas.json. Passes with the workspace tests under Foundry 1.8.3.

### O30.2 · EIP-712 types and BondMath mirror
- Owner: OB
- PD: 0.5
- Depends: O30.1
- Plan: §9, C.7, V-R4
- Cut: no
- Status: done
- Files: oracle/packages/oracle-sdk/src/{eip712.ts,bond.ts}, oracle/packages/oracle-sdk/test/*
- Build: `PanelResult` and `ReviewedProposal` typed-data definitions and domain builder; BondMath (and VoidBound) mirrors with bigint.
- Done when: P1/R1 digests and the signed examples in `vectors/eip712.json`, the bond vector and both void-bound vectors match.
- Check: cd oracle/packages/oracle-sdk && bun test
- Notes: `src/eip712.ts`: `panelResultTypes`/`reviewedProposalTypes` (viem typed-data), `oracleDomain(chainId, verifyingContract)` (name "ErosResolutionOracle", version "1"), `domainSeparator`, struct hashes and digests (`panelResultDigest`, `reviewedProposalDigest`, the contract's `hashPanelResult`/`hashReviewedProposal`), `signPanelResult`/`signReviewedProposal` for a viem LocalAccount, `recoverSigner` that returns null for any signature SigLib refuses (not 65 bytes, v not 27/28, high s), `sortCommitteeSigs` (ascending, duplicate refused), the Outcome/PanelLabel/Phase enums and `hashText`. `src/bond.ts`: bigint `bond` (proportional term rounded up, negative or above-uint16 bps refused), `isWatchdogFresh`, `liveness` (Path enum, NoPath), `minVoidSecs`. 14 tests: type strings and typehashes, domain separator (and that it moves with chain and contract), P1/R1 digests, every field bound, the P1 attestor signature and both R1 committee signatures byte for byte from the vector keys (signed out of order, sorted to the vector order), refused short/bad-v/high-s (malleable twin) signatures; bond.json, rounding and floors, liveness and watchdog boundaries, both voidbound.json vectors and the no-feed case. 12/12 mutations caught (a field type, the domain version, the low-s and v checks, the sort, rounding down, A_max, R_max+2, T_L1 without a feed, the heartbeat boundary, the L1 freshness condition). SDK suite 25 tests.

### O30.3 · Claim-render mirror
- Owner: OB
- PD: 0.5
- Depends: O30.2
- Plan: §9, §12.9, ADJ-16
- Cut: no
- Status: done
- Files: oracle/packages/oracle-sdk/src/claim.ts, oracle/vectors/claim.json, oracle/test/vectors/ClaimVectors.t.sol
- Build: A Foundry test writes `vectors/claim.json` (template, inputs, rendered bytes) from `renderClaim`; the TS mirror renders the same bytes. `oracle-cli` switches its claim preview to the mirror.
- Done when: every claim vector matches byte for byte.
- Check: cd oracle/packages/oracle-sdk && bun test
- Notes: `test/vectors/ClaimVectors.t.sol` renders 27 cases through `ClaimRenderer` and compares the JSON with `vectors/claim.json` byte for byte (stale file fails; `WRITE_CLAIM_VECTORS=true forge test --mc ClaimVectorsTest` regenerates it; foundry.toml grants read-write on that one file). Each vector: template, fields, Layer 1 URL and value hash (evidence = `l1Evidence` when set), rendered bytes as hex, `worstCaseLength`, error. Cases: the example template for an L1 YES, URI NO and INVALID; UTF-8 multibyte and JSON-escaped text (tab, quotes, backslash, CR LF, a control byte); reordered and adjacent tokens; no TAU_UNIX and TAU_UNIX at the end; literal braces around tokens; tau at 0, leap days (2000, 2028), 9999-12-31 and uint64 max with a uint256-max chain id; leading-zero ids; empty strings; hex-looking text ("0xdeadbeef"); a 256-byte evidence URI; a long L1 URL that drives the bound; and InvalidTemplate for a missing, duplicated or unknown token, TAU_UNIX twice, a triple brace, trailing `{{`, a truncated token and InvalidTemplate winning over NoOutcome, plus NoOutcome. Found while building: `worstCaseLength` reverts only on a `{{` that is not a token, not on bad counts (mirrored). `oracle-sdk/src/claim.ts` mirrors `render`, `isValidTemplate`, `worstCaseLength`, `l1Evidence` and the UTC date (the civil-from-days algorithm in bigint) on UTF-8 bytes; text is encoded with `stringToBytes`, since viem's `toBytes` would decode a "0x…" question as hex. 28 tests (one per vector, coverage of the file, `utc` against the JS calendar); 13/13 non-equivalent mutations caught (3 equivalent ones noted: outcome branch order inside the range check, hex32 of a full hash, the JS bounds check). `oracle-cli list` now renders `claim.txt` with the mirror; `forge/RenderClaim.s.sol` and `renderClaim` in `forge.ts` are removed (ADJ-16 closed). SDK 54 tests, CLI 35 tests, both also with Foundry 1.8.3.

## O31 · Keeper
Plan §13: owner OB · 2.5 PD · depends O30 · acceptance: every job idempotent; anvil fork scenario tests.

### O31.1 · Keeper core
- Owner: OB
- PD: 0.75
- Depends: O30.3
- Plan: §9, §9.1
- Cut: partial (in the cut: viem with forge ABIs, ADJ-17)
- Status: todo
- Files: oracle/services/keeper/**
- Build: Job loop over markets from the indexer and `getResolution`; job keys `(marketId, stateVersion, action)`; re-read at `latest` before sending; explicit gas limits; safe to run as two instances.
- Done when: unit tests show a duplicate job is never sent twice and a stale state version is dropped.
- Check: cd oracle/services/keeper && bun test

### O31.2 · Resolution jobs
- Owner: OB
- PD: 0.75
- Depends: O31.1
- Plan: §9.1, D16
- Cut: partial (halt, request, escalate, assert, finalize, void)
- Status: todo
- Files: oracle/services/keeper/src/jobs/*
- Build: Halt at T; request L1 every 5 min from T + buffer; escalate at T + l1Timeout; open; expire early; assert (pre-check the treasury holds B, alert otherwise); sync dispute; finalize through `KeeperRouter.finalizeMany`; void at `voidDeadline`.
- Done when: each job has a unit test of its trigger condition and its no-op path.
- Check: cd oracle/services/keeper && bun test

### O31.3 · Engine follow-up and treasury jobs
- Owner: OB
- PD: 0.5
- Depends: O31.2
- Plan: §9.1, §3.2
- Cut: no
- Status: todo
- Files: oracle/services/keeper/src/jobs/*
- Build: After Final: `captureInvalidPrice`, `prepareSnapshotChunk(32)`, `preparePayoutChunk(32)`, `finishPreparation`; `closeDispute` then `skim` for treasury-funded disputes; hourly commitments check (no transaction, alert only).
- Done when: unit tests cover each job's trigger and no-op path.
- Check: cd oracle/services/keeper && bun test

### O31.4 · Fork scenario tests
- Owner: OB
- PD: 0.5
- Depends: O31.3
- Plan: §9.1, §11.3
- Cut: no
- Status: todo
- Files: oracle/services/keeper/test/fork/*
- Build: Anvil (fork of Monad testnet or a local deploy from O19.3) scenarios: L1 path to Final, rejection to Review, void at the deadline, two keeper instances racing.
- Done when: every scenario reaches the expected state and no job sends a reverting transaction.
- Check: cd oracle/services/keeper && bun test test/fork

## O32 · Snapshotter and IPFS dual pinning
Plan §13: owner OB · 2 PD · depends O30 · acceptance: hash reproducible from a pinned CID.

### O32.1 · Evidence fetcher
- Owner: OB
- PD: 0.75
- Depends: O30.3
- Plan: §8.2
- Cut: no
- Status: todo
- Files: oracle/services/snapshotter/**
- Build: Sources in order (the L1 endpoint if `hasFeed`, then allow-listed hosts, then context pages marked non-allow-listed); items `{url, host, fetchedAt, httpStatus, contentType, sha256, bytesBase64}`; caps 512 KB per item and 4 MB per snapshot; plain GETs, no cookies; raw HTML stored, text extracted only for prompts.
- Done when: tests against a local HTTP fixture cover order, caps and the item format.
- Check: cd oracle/services/snapshotter && bun test

### O32.2 · Canonical form and evidence hash
- Owner: OB
- PD: 0.5
- Depends: O32.1
- Plan: §8.2
- Cut: no
- Status: todo
- Files: oracle/services/snapshotter/src/jcs.ts
- Build: RFC 8785 JCS canonical JSON; `evidenceHash = keccak256(canonicalBytes)`.
- Done when: the RFC 8785 test vectors pass and the same snapshot always gives the same hash.
- Check: cd oracle/services/snapshotter && bun test

### O32.3 · Dual pinning and verification
- Owner: OB
- PD: 0.75
- Depends: O32.2
- Plan: §8.2
- Cut: no
- Status: todo
- Files: oracle/services/snapshotter/src/pin.ts
- Build: Pin to two providers; `evidenceURI = ipfs://<CIDv1>`; verify both pins and a gateway fetch hash before anything is submitted; reviewer additions create a new snapshot, hash and URI.
- Done when: a snapshot pinned on testnet infrastructure re-fetches from its CID with the same `evidenceHash`.
- Check: cd oracle/services/snapshotter && bun test

## O33 · Panel runner
Plan §13: owner OB · 4 PD · depends O32 · acceptance: signed payload accepted on testnet; flagged snapshot → Review.

### O33.1 · Model clients
- Owner: OB
- PD: 1
- Depends: O32.3
- Plan: §8.3
- Cut: no
- Status: todo
- Files: oracle/services/panel-runner/src/models/*
- Build: Three families from three providers pinned to exact versions (`modelIdHash = keccak256("provider:model-id@version")`); temperature 0 and fixed seeds where supported; JSON-schema structured output `{label, confidence, cited, rationale ≤ 1,000}`; invalid output counts as an API failure; 3 retries with back-off, then ABSTAIN; no valid citation, or only non-allow-listed citations, → ABSTAIN; calls independent, outputs never shared.
- Done when: tests with recorded provider responses cover each failure path.
- Check: cd oracle/services/panel-runner && bun test

### O33.2 · Prompts and prompt-injection defences
- Owner: OB
- PD: 0.75
- Depends: O33.1
- Plan: §8.3
- Cut: no
- Status: todo
- Files: oracle/services/panel-runner/src/{prompts,injection}/*
- Build: One pinned prompt per category (`promptHash`); every item as a delimited, escaped, untrusted data block; the system prompt says instructions inside evidence are data; deterministic detector ("ignore previous", role tags, hidden or zero-width text, off-screen CSS) plus a small classifier model; any hit sets `FLAG_INJECTION_SUSPECTED`.
- Done when: a fixture set of injected items is flagged and clean items are not.
- Check: cd oracle/services/panel-runner && bun test

### O33.3 · Calibration and reviewer candidate
- Owner: OB
- PD: 0.5
- Depends: O33.2
- Plan: §8.3
- Cut: no
- Status: todo
- Files: oracle/services/panel-runner/src/calibration.ts
- Build: Isotonic map per model from JSON breakpoints (O39.4 publishes the measured maps; until then a pinned placeholder map, so every result still goes to review); `ĉ = clip(g(c), 0.01, 0.99)`; `calibratedBps = floor(ĉ × 10000)`; `calibratorHash = keccak256(JCS(all three maps))`; display-only candidate `ℓ = (n_eff/n) Σ s_i·logit(ĉ_i)`.
- Done when: unit tests cover clipping, flooring and the hash.
- Check: cd oracle/services/panel-runner && bun test

### O33.4 · KMS signing
- Owner: OB
- PD: 0.75
- Depends: O33.3
- Plan: §8.3, V-A1
- Cut: no
- Status: todo
- Files: oracle/services/panel-runner/src/signer.ts
- Build: Sign the EIP-712 `PanelResult` (oracle-sdk types) with a KMS `ECC_SECG_P256K1` key; convert DER to (r, s, v) with low-s and `v ∈ {27, 28}`.
- Done when: a unit test with a KMS test key produces signatures the oracle's `hashPanelResult` + `ecrecover` accept (V-A1).
- Check: cd oracle/services/panel-runner && bun test

### O33.5 · Routing, re-runs and testnet acceptance
- Owner: OB
- PD: 1
- Depends: O33.4
- Plan: §8.1, §8.3, §8.5, §8.6
- Cut: no
- Status: todo
- Files: oracle/services/panel-runner/src/runner.ts
- Build: Trigger on `StateChanged` into L2Pending (POST_T) or EarlyCheck (EARLY) plus polling; NOT_YET majority re-runs with back-off 15 min, 30 min, 1 h, 2 h, … until `l2StartedAt + l2DeadlineSecs`, each with a fresh snapshot; early results that are not three identical known labels return the market to None; local routing pre-check only to save gas; submit from the relayer EOA.
- Done when: on testnet a signed payload is accepted and a flagged snapshot routes the market to Review.
- Check: manual: testnet tx hashes of an accepted PanelResult and of a flagged result routed to Review

## O34 · Committee console
Plan §13: owner OB · 2.5 PD · depends O30 · acceptance: E2/E3 committee steps on testnet.

### O34.1 · Case view backend
- Owner: OB
- PD: 0.75
- Depends: O30.3
- Plan: §8.4
- Cut: no
- Status: todo
- Files: oracle/services/committee-console/src/backend/*
- Build: Assemble each case: question, rules, rendered snapshot, panel labels, rationales, ĉ, candidate, `rejectedMask`, deadlines; notes as JCS → `noteHash`, pinned to IPFS.
- Done when: tests build a case from a recorded market state.
- Check: cd oracle/services/committee-console && bun test

### O34.2 · Signing and submission
- Owner: OB
- PD: 0.75
- Depends: O34.1
- Plan: §8.4, D7, D17
- Cut: partial (as a CLI)
- Status: todo
- Files: oracle/services/committee-console/src/sign/*
- Build: `ReviewedProposal` signed with `eth_signTypedData_v4`; collect signatures, sort by signer ascending, check threshold locally; anyone submits `submitReviewedProposal`; Safe members via ERC-1271.
- Done when: a 2-of-3 proposal built by the console is accepted by the oracle on anvil.
- Check: cd oracle/services/committee-console && bun test

### O34.3 · Reviewer UI, source additions and service level
- Owner: OB
- PD: 0.5
- Depends: O34.2, O32.3
- Plan: §8.4, ADJ-22
- Cut: no
- Status: todo
- Files: oracle/services/committee-console/src/ui/*
- Build: Web app or CLI behind SSO; YES/NO/INVALID chosen from the rules alone; reviewers may add sources (new snapshot through the snapshotter, ADJ-22); alerts at T_r, at the L2 deadline − 2 h and at `retryOpensAt` − 2 h.
- Done when: a reviewer can complete a case, including an added source, without leaving the console.
- Check: cd oracle/services/committee-console && bun test

### O34.4 · Committee steps on testnet
- Owner: OB
- PD: 0.5
- Depends: O34.3
- Plan: §8.4, E2, E3
- Cut: partial (CLI flow only)
- Status: todo
- Files: docs_oracle/evidence/O34/
- Build: Run the committee steps of E2 and E3 on testnet with the three committee keys.
- Done when: both reviewed proposals are accepted on testnet.
- Check: manual: tx hashes of both accepted ReviewedProposals in docs_oracle/evidence/O34/

## O35 · Watchdog
Plan §13: owner OA · 3 PD · depends O30, O20 · acceptance: wrong-proposal drill disputes inside liveness.

### O35.1 · Proposal intake and Layer 1 re-run
- Owner: OA
- PD: 0.75
- Depends: O30.3, O20.2
- Plan: §9.2
- Cut: no
- Status: todo
- Files: oracle/services/watchdog/src/{intake,l1}.ts
- Build: Subscribe to every proposal from every path as soon as it is recorded; for L1 re-run the FeedSpec with `packages/feedspec` from the watchdog's own egress, plus the fallback source if listed.
- Done when: tests flag a contradiction between a recorded L1 outcome and a re-run.
- Check: cd oracle/services/watchdog && bun test

### O35.2 · Fourth model family
- Owner: OA
- PD: 0.75
- Depends: O35.1
- Plan: §9.2, §8.3
- Cut: no
- Status: todo
- Files: oracle/services/watchdog/src/model.ts
- Build: For L2, REVIEWED and PERMISSIONLESS proposals: a fourth model family with a different prompt on the same snapshot, plus the L1 feed if one exists.
- Done when: tests with recorded responses produce contradiction and agreement verdicts.
- Check: cd oracle/services/watchdog && bun test

### O35.3 · Dispute, float accounting and heartbeat
- Owner: OA
- PD: 0.75
- Depends: O35.2
- Plan: §9.2, D11
- Cut: no
- Status: todo
- Files: oracle/services/watchdog/src/{dispute,heartbeat}.ts
- Build: On a contradiction while the assertion is live and before `expiresAt − 10 min`: `BondTreasury.disputeViaVenue(id)` and page a human (page only without float); `watchdogHeartbeat()` every 10 min; alert when `WATCHDOG_FLOAT < Σ B(live assertions)`.
- Done when: an anvil test disputes inside liveness and a stopped heartbeat moves L1 liveness to the reviewed value.
- Check: cd oracle/services/watchdog && bun test

### O35.4 · Independent deployment and drill
- Owner: OA
- PD: 0.75
- Depends: O35.3
- Plan: §9.2, §12.7
- Cut: no
- Status: todo
- Files: docs_oracle/evidence/O35/
- Build: Deploy on a separate cloud account with its own RPC, API keys, KMS key and model provider; run a wrong-proposal drill on testnet.
- Done when: the drill's wrong proposal is disputed inside liveness.
- Check: manual: drill tx hashes (proposal, dispute) in docs_oracle/evidence/O35/

## O36 · Alerts
Plan §13: owner OB · 1 PD · depends O31 · acceptance: each alert fired once in a drill.

### O36.1 · Alert rules
- Owner: OB
- PD: 0.5
- Depends: O31.4
- Plan: §9.4
- Cut: no
- Status: todo
- Files: oracle/services/alerts/src/rules/*
- Build: Every §9.4 rule: `ReportProcessed(result=false)` for the oracle; L1Pending after two retry intervals; escalations per provider; panel failures; review past T_r; L2 deadline and `retryOpensAt` approaching; every dispute and DVM roll; markets within 72 h of `voidDeadline`; ASSERTION below the next bond or the open-market cap total; float below Σ live bonds; reward IOUs; stale heartbeat; guardian revocations; queued trust-set activations; Final but `claimsEnabled` false for > 6 h.
- Done when: each rule has a unit test with a firing and a quiet fixture.
- Check: cd oracle/services/alerts && bun test

### O36.2 · Routing and drill
- Owner: OB
- PD: 0.5
- Depends: O36.1
- Plan: §9.4
- Cut: no
- Status: todo
- Files: oracle/services/alerts/src/routes/*, docs_oracle/evidence/O36/
- Build: Route to PagerDuty, Slack and Telegram; run a drill that triggers every rule once.
- Done when: every rule fired exactly once in the drill and reached its route.
- Check: manual: drill log listing every rule with its delivery in docs_oracle/evidence/O36/

## O37 · Envio indexer
Plan §13: owner OB · 2 PD · depends OG1 · acceptance: Disputes Live queries served.

### O37.1 · Project and sources
- Owner: OB
- PD: 0.75
- Depends: OG1
- Plan: §9.3, §6.8, V-E2
- Cut: no
- Status: todo
- Files: oracle/indexer/**
- Build: `pnpx envio init` for Monad testnet; sources ResolutionOracle, MarketRegistry, BondTreasury, UmaAdapter, OOv3 (`AssertionMade`, `AssertionDisputed`, `AssertionSettled`), the KeystoneForwarder's `ReportProcessed` filtered to the oracle, ErosSandboxOracle; ABIs from `forge inspect`; start blocks from `deployments/<network>.json`.
- Done when: the indexer syncs testnet events from the deploy blocks.
- Check: cd oracle/indexer && pnpm envio codegen

### O37.2 · Entities and handlers
- Owner: OB
- PD: 0.75
- Depends: O37.1
- Plan: §9.3
- Cut: no
- Status: todo
- Files: oracle/indexer/src/*
- Build: Market, Resolution (state history), Assertion, Proposal, PanelResult, Dispute, TreasuryLedger, TrustSet, ReportAttempt.
- Done when: handler tests populate every entity from recorded events.
- Check: cd oracle/indexer && pnpm test

### O37.3 · Queries and mainnet config
- Owner: OB
- PD: 0.5
- Depends: O37.2
- Plan: §9.3, §9.5, DEP-5
- Cut: no
- Status: todo
- Files: oracle/indexer/**
- Build: The queries Disputes Live and the keepers need (live markets by deadline, market detail, assertion history); a mainnet (143) config. Merge into the app team's indexer when it exists (DEP-5).
- Done when: every Disputes Live query returns data on testnet.
- Check: cd oracle/indexer && pnpm test

## O38 · Disputes Live page
Plan §13: owner OB · 3 PD · depends O37 · acceptance: dispute + propose flows on testnet.

### O38.1 · Market list
- Owner: OB
- PD: 0.75
- Depends: O37.3
- Plan: §9.5, ADJ-13
- Cut: partial (one page of live assertions with an explorer link)
- Status: todo
- Files: oracle/apps/disputes-live/**
- Build: Every market in Proposed, Disputed, Review or Open, soonest deadline first.
- Done when: the page lists the testnet markets in the right order.
- Check: cd oracle/apps/disputes-live && bun test

### O38.2 · Market detail
- Owner: OB
- PD: 0.75
- Depends: O38.1
- Plan: §9.5
- Cut: no
- Status: todo
- Files: oracle/apps/disputes-live/**
- Build: Question; rules; proposed outcome and path; evidence link and hash (or L1 value hash and source URL); panel labels and candidate; bond; assertion expiry; `voidDeadline`; attempt and rejected outcomes; payout state only from `claimsEnabled` and the risk-sdk `settlement.ts` states.
- Done when: component tests render each field and never show "paid" from oracle Final alone.
- Check: cd oracle/apps/disputes-live && bun test

### O38.3 · Dispute button
- Owner: OB
- PD: 0.5
- Depends: O38.2
- Plan: §9.5
- Cut: partial (dispute button)
- Status: todo
- Files: oracle/apps/disputes-live/**
- Build: `usdc.approve(OOv3, bond)` then `OOv3.disputeAssertion(assertionId, user)` with the exact bond and a liveness countdown; pending → final via Monad `latest` → `finalized`.
- Done when: the flow works against anvil.
- Check: cd oracle/apps/disputes-live && bun test

### O38.4 · Propose button and testnet banners
- Owner: OB
- PD: 0.5
- Depends: O38.3
- Plan: §9.5, §17
- Cut: no
- Status: todo
- Files: oracle/apps/disputes-live/**
- Build: In Open: `usdc.approve(UmaAdapter, B)` then `proposePermissionless(id, outcome, uri, hash)`, rejected outcomes disabled; testnet banners for the sandbox DVM and the single-node `--listen` simulator.
- Done when: the flow works against anvil and both banners show on testnet builds.
- Check: cd oracle/apps/disputes-live && bun test

### O38.5 · Testnet flows
- Owner: OB
- PD: 0.5
- Depends: O38.4
- Plan: §9.5
- Cut: no
- Status: todo
- Files: docs_oracle/evidence/O38/
- Build: Run a dispute and a permissionless proposal from the page on testnet.
- Done when: both transactions confirm and the page shows the new states.
- Check: manual: tx hashes of the page's dispute and proposal in docs_oracle/evidence/O38/
