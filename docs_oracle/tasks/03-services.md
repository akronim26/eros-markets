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
- Status: done
- Files: oracle/services/keeper/**
- Build: Job loop over markets from the indexer and `getResolution`; job keys `(marketId, stateVersion, action)`; re-read at `latest` before sending; explicit gas limits; safe to run as two instances.
- Done when: unit tests show a duplicate job is never sent twice and a stale state version is dropped.
- Check: cd oracle/services/keeper && bun test
- Notes: `@eros-oracle/keeper` (workspace member; CI runs it in the `packages` job, which tests every workspace member, ADJ-11). The oracle has no version counter, so `stateVersion` is keccak256 of the ABI-encoded `Resolution` (`src/version.ts`): any field change (state, request count, attempts, assertion, deadlines, ...) is a new version. `src/keeper.ts`: each tick lists markets (deduplicated), reads every `getResolution` at `latest`, takes the first job of the first planner that has one (one job per market per tick) and sends it only if (1) this instance has not sent or started sending the key (claimed before any await, so concurrent duplicates stop), (2) gas.json has a measured limit for the call (never guessed; the job is dropped with an error log), (3) a fresh read still shows the planned version (else `stale`), (4) an eth_call at `latest` neither reverts nor reports a no-op (`false` by default, per-job `isNoop` for FinalizeStatus). Sends do not wait for receipts; keys of older versions are forgotten, a key whose transaction reverted on chain or has no receipt after `resendAfterMs` (5 min) is forgotten so the job is retried, and a failed broadcast is retried next tick. Two instances: the second runs with `DELAY_MS` and drops jobs the first already landed; if both send before either lands, the later call is a no-op on chain. `src/sources.ts`: `IndexerSource` (Envio GraphQL `Market { id }`, paged; the query is checked against the schema in O37), `RegistryLogSource` (MarketListed from the registry's deploy block in 100-block ranges, cursor kept, a failed range re-read) and `StaticSource`. `src/chain.ts`: viem adapter (nonce manager for back-to-back sends, explicit gas, receipts as success/reverted/pending), smoke-tested read-only against an anvil fork of Monad testnet; `src/main.ts` reads NETWORK, RPC_URL, KEEPER_PRIVATE_KEY, INDEXER_URL, POLL_MS, DELAY_MS. `src/jobs/index.ts` holds the planners (empty until O31.2). gas.json has limits for haltScheduled, assertProposal and finalizeMarket only; the other §9.1 calls are measured in O31.2. 25 tests (in-memory chain with a mempool): a duplicate is never sent twice (later ticks, concurrent execute, a market listed twice), a stale version is dropped (state moved during the delay, or an old version), two instances racing (the delayed one sends nothing; simultaneous sends apply once), no-op, revert and missing-gas gates, retries after a failed broadcast, an on-chain revert and a lost transaction, per-market and per-planner isolation, the run loop surviving a failing source, stateVersion against an independent encoding and changing with each of the 25 fields, indexer paging and errors, log ranges of at most 100 blocks. 20/20 mutations caught. Also fixed O30.2's `domainSeparator` to pass chainId as bigint (types only; vectors unchanged).

### O31.2 · Resolution jobs
- Owner: OB
- PD: 0.75
- Depends: O31.1
- Plan: §9.1, D16
- Cut: partial (halt, request, escalate, assert, finalize, void)
- Status: done
- Files: oracle/services/keeper/src/jobs/*
- Build: Halt at T; request L1 every 5 min from T + buffer; escalate at T + l1Timeout; open; expire early; assert (pre-check the treasury holds B, alert otherwise); sync dispute; finalize through `KeeperRouter.finalizeMany`; void at `voidDeadline`.
- Done when: each job has a unit test of its trigger condition and its no-op path.
- Check: cd oracle/services/keeper && bun test
- Notes: `src/jobs/resolution.ts`: one planner in priority order, each condition mirroring the contract's own check: void (not Final, `now >= voidDeadline`; `voidMarketStuck` gas when an assertion is live), halt (pre-halt at T), expire early (EarlyCheck/EarlyReview after the TTL), escalate (L1Pending at T + l1TimeoutSecs, ahead of a request), request L1 (feed, from T + bufferSecs, every 5 min or the onchain `minRequestIntervalSecs` if longer), open (L2Pending/Review from T, at `retryOpensAt` or `l2StartedAt + l2DeadlineSecs`), assert (Proposed, no live assertion; reads the ASSERTION ledger and `bondFor` and alerts instead when short, or when all 3 attempts are used), sync dispute (Proposed, venue shows disputed and unsettled), finalize (Proposed past `expiresAt` or settled; Disputed every tick, since the DVM may have answered; a simulated NOT_READY, and DISPUTED again from Disputed, are no-ops: `_applyVenue` returns DISPUTED for an already-Disputed market, which would otherwise resend every tick). Finalize is batched: jobs with the `finalize` batch key that pass their checks go out as `KeeperRouter.finalizeMany` in runs of at most 4, a run of one as `finalizeMarket`; batch gas = finalizeMany1.limit + (k - 1) x finalizeMany4.perExtraMarket (the line through the two measured limits; sizes above 4 are refused). Core additions: the listing (tau, feed buffer and timeout, L2 deadline, early TTL) is read once per market and cached; lazy reads (venue status, treasury ledger, `bondFor`, globals by pinned version, cached); `alert()` logs at error level with `alert: true`. Testnet vs mainnet engine is detected from deployments (StubMarketFactory present): real-engine gas keys are used on mainnet, and those not yet measured (`voidMarketRealEngine`, `voidMarketStuckRealEngine`) are refused, not guessed. Gas: `test/gas/OracleGas.t.sol` now measures requestResolution (107k tx, limit 130k), escalateToL2 (105k, 130k), openAfterDeadline (73k, 90k), expireEarly (77k, 100k), syncAssertion (76k, 100k), voidMarket (142k, 180k), voidMarketStuck (225k, 280k), finalizeMany with 1 (260k, 320k) and 4 markets (815k, 980k), all under Foundry 1.8.3 (19 gas tests; the existing figures unchanged); `.gas-snapshot` regenerated. 23 new tests (48 in the keeper): each job's trigger and no-op path with boundaries, every planned testnet gas key exists in gas.json, alerts on a short treasury and exhausted attempts, finalize batching (runs of 4, a run of one, members failing checks left out, NOT_READY sends nothing, the batch-gas line), the listing read once. 29/30 mutations caught (the survivor is equivalent: `lastRequestAt == 0` only matters for timestamps under 5 minutes).

### O31.3 · Engine follow-up and treasury jobs
- Owner: OB
- PD: 0.5
- Depends: O31.2
- Plan: §9.1, §3.2
- Cut: no
- Status: done
- Files: oracle/services/keeper/src/jobs/*
- Build: After Final: `captureInvalidPrice`, `prepareSnapshotChunk(32)`, `preparePayoutChunk(32)`, `finishPreparation`; `closeDispute` then `skim` for treasury-funded disputes; hourly commitments check (no transaction, alert only).
- Done when: unit tests cover each job's trigger and no-op path.
- Check: cd oracle/services/keeper && bun test
- Notes: Engine follow-up (`src/jobs/engine.ts`, after oracle Final): reads the engine's `getSettlementStatus()`; INVALID without a captured price → `captureInvalidPrice()` only (a result with `captured == false` is a no-op: grace not over, or BLOCKED); otherwise `finishPreparation()`, `preparePayoutChunk(32)`, `prepareSnapshotChunk(32)` offered in that order. The core now tries a planner's jobs in order and sends the first that neither reverts nor is a no-op, so the next step is always the one sent (finishing reverts until both jobs are done, a payout chunk until the snapshot is). Nothing once claims are enabled (the testnet stub engine reports that at Final, so these jobs never run on testnet) or before the halt; RECOVERY_REQUIRED alerts Risk. The job's version is the engine status (with the oracle version), checked again before sending (`freshVersion`, new in the core), so each chunk is its own key and no chunk is sent twice for the same progress. Names and ABI from Risk's SettlementController/InvalidPrice (unchanged on integration/risk apart from type renames); `src/engineAbi.ts` is pinned by a test against `forge inspect EngineHarness abi`. Gas: the four engine calls are not in gas.json, because a 32-account chunk's cost depends on A's accounting, which the seam harness only mocks; they are measured at the risk merge and refused until then. Treasury (`src/jobs/treasury.ts`, global planners, new in the core): `closeDispute(assertionId)` for every dispute in BondTreasury's DisputeFunded logs (`TreasuryDisputeSource`, 100-block ranges like the registry source) still recorded open (a `false` result is a no-op; a dispute seen closed is not read again), then `skim()` (no-op when it would credit 0; keyed by the treasury's USDC balance, float and open disputes), sent in that order. Hourly commitments check by chain time, no transaction: alerts when the ASSERTION ledger is below `totalCommitted` or below the largest `bondFor` among Proposed markets waiting for their assertion. Gas measured (Foundry 1.8.3): closeDispute 118k tx on its costlier path (market voided at the deadline, so the oracle is read too), limit 150k; skim 50k on the crediting path, limit 60k (21 gas tests). Core fix: an option passed as `undefined` no longer replaces its default. 18 new tests (66 in the keeper): the engine steps in sequence with reverts falling through, no chunk twice at the same progress, progress during the delay makes the job stale, the INVALID capture and its no-op, no jobs before Final, after claims or before the halt, the recovery alert, refusal without measured gas, the engine version covering every field, the ABI against forge; dispute close and skim with their no-ops, staleness and skipping closed disputes, skim keyed by treasury state; commitments alerts, boundaries and the hourly gate; the fallback rule in the core. 28/28 mutations caught.

### O31.4 · Fork scenario tests
- Owner: OB
- PD: 0.5
- Depends: O31.3
- Plan: §9.1, §11.3
- Cut: no
- Status: done
- Files: oracle/services/keeper/test/fork/*
- Build: Anvil (fork of Monad testnet or a local deploy from O19.3) scenarios: L1 path to Final, rejection to Review, void at the deadline, two keeper instances racing.
- Done when: every scenario reaches the expected state and no job sends a reverting transaction.
- Check: cd oracle/services/keeper && bun test test/fork
- Notes: Local deploy, not a fork (`test/fork/stack.ts`): a fresh anvil with Monad's 128 KiB code limit gets what O19.3/O19.4 run before a launch: `DeployUmaSandbox` and `DeployOracle` broadcast (`--code-size-limit 131072 --non-interactive`: forge's broadcast check otherwise applies EIP-170), `CreateTrustSet` and `FundTreasury` operations proposed by the Safe and executed by a stranger after the 300 s Timelock delay, TestUSDC deposits, then per scenario the example pack listed through the Safe transaction that `ListMarket` prints (`SHIFT_TO_NOW`). Anvil's default accounts stand in for the Safes, the sim relayer and a disputer; files go to the gitignored `deployments/dryrun/keeper-fork-<port>/`. The CRE sim bridge is `MockKeystoneForwarderLite` (O15.1) placed with `anvil_setCode` at `params.cre.mockForwarder`; the test plays the CRE relayer (report v1 through the forwarder, tx.origin a sim relayer), a disputer on OOv3, and the DVM (the Safe owns `ErosSandboxOracle`). Keepers are wired as `main.ts` wires them (viemChain, `RegistryLogSource`, `TreasuryDisputeSource`, gas.json, `planners({realEngine: false})`), each scenario from one snapshot with fresh funded keys (viem's nonce manager would otherwise remember nonces past an `evm_revert`). Every sent transaction's receipt is checked at once. Scenarios (6): L1 path halt → request → assert → finalize → Final YES ASSERTED_TRUE, nothing left after; rejection: dispute → sync → Disputed (finalize a no-op until the DVM answers) → DVM false → finalize → Review (rejectedMask YES, retryOpensAt) → open at retryOpensAt; no answer: request → escalate → open → nothing one second before `voidDeadline` → void → Final INVALID VOID_DEADLINE; void with a disputed assertion the DVM never answers (gas key `voidMarketStuck`) → Final INVALID; two instances with the 250 ms offset: each job sent once, the offset instance never sends; two with no offset: both send every job (observed 2 of each), the later lands as a no-op, one request and one assertion. Checks: a `finalizeMarket` limit cut to 60,000 fails the L1 scenario (out-of-gas finalize); without the offset the second instance does send, so the offset scenario's `b.sent == []` is meaningful. `bun test` (the unit suite, packages CI job) ignores `test/fork/**`; `bun run test:fork` runs in the CI forge job after the build. Passes on Foundry 1.5.1 (125 s) and 1.8.3 (230 s); an earlier hang came from anvil's stderr piped and never read (now ignored).

## O32 · Snapshotter and IPFS dual pinning
Plan §13: owner OB · 2 PD · depends O30 · acceptance: hash reproducible from a pinned CID.

### O32.1 · Evidence fetcher
- Owner: OB
- PD: 0.75
- Depends: O30.3
- Plan: §8.2
- Cut: no
- Status: done
- Files: oracle/services/snapshotter/**
- Build: Sources in order (the L1 endpoint if `hasFeed`, then allow-listed hosts, then context pages marked non-allow-listed); items `{url, host, fetchedAt, httpStatus, contentType, sha256, bytesBase64}`; caps 512 KB per item and 4 MB per snapshot; plain GETs, no cookies; raw HTML stored, text extracted only for prompts.
- Done when: tests against a local HTTP fixture cover order, caps and the item format.
- Check: cd oracle/services/snapshotter && bun test
- Notes: New workspace member `@eros-oracle/snapshotter` (depends on `@eros-oracle/feedspec` for the registry's host rules). `takeSnapshot(request, options)`: the request is `{marketId, l1Url?, allowList, pages}` (`l1Url` from FeedSpec `buildUrl`; `pages` the market's configured endpoints and pages, or a reviewer's additions); sources are ordered Layer 1 first, then pages on allow-listed hosts in the allow-list's host order (configured order within a host), then context pages, each URL once. Item and snapshot shape per ADJ-40 (`allowListed`, `truncated`, `error` on a failed fetch; `omitted` with `BAD_URL` or `SNAPSHOT_CAP`). Plain GETs: `accept: */*` and a fixed user agent only, `credentials: omit`, no cookie jar, `redirect: manual` (a 3xx is stored, so a redirect cannot bring in another host's page), 15 s timeout. Bodies are streamed and cut at 512 KB per item and at the 4 MB snapshot budget; at the cap the request is aborted, because cancelling Bun's reader alone left the connection downloading (found by the endless-body test: 11.8 MB in 200 ms before the fix). Sources after the budget is spent are omitted, not fetched. `promptText(item)` (`src/text.ts`) gives prompt text from the stored bytes and is never stored or hashed: the Content-Type charset honoured, HTML reduced to visible text (comments, declarations, script, style, noscript, template and head dropped, block tags as line breaks, common entities decoded), JSON and text as is, null for binary, failed or empty items. 18 tests against a local HTTP fixture (a real Bun server; `https://<host>/<path>` routed to it): order (with and without a feed, duplicates, five kinds of bad URL), the exact item format with sha256 and bytes checked against the fixture, 404 kept, no-response items (timeout, refused connection), 512 KB +1 truncated and exactly 512 KB whole, an endless body stopped and its connection closed, eight full items filling 4 MB with the rest omitted unfetched, the crossing item cut to the remaining budget, omitted entries in request order, request headers (no cookie or authorization, also after a Set-Cookie), redirect not followed, and prompt text. 16/16 mutations caught.

### O32.2 · Canonical form and evidence hash
- Owner: OB
- PD: 0.5
- Depends: O32.1
- Plan: §8.2
- Cut: no
- Status: done
- Files: oracle/services/snapshotter/src/jcs.ts
- Build: RFC 8785 JCS canonical JSON; `evidenceHash = keccak256(canonicalBytes)`.
- Done when: the RFC 8785 test vectors pass and the same snapshot always gives the same hash.
- Check: cd oracle/services/snapshotter && bun test
- Notes: `src/jcs.ts`: `canonicalize(value)` (RFC 8785: properties sorted by UTF-16 code units at every level, arrays in order, strings with the five short escapes and other controls as lowercase `\u00hh`, numbers as ECMAScript `Number::toString`, no whitespace), `canonicalBytes` (UTF-8) and `evidenceHash(snapshot) = keccak256(canonicalBytes)` (viem). Anything JSON cannot carry is a `JcsError`, never dropped or rewritten: undefined (also as a property or array element, which `JSON.stringify` would silently drop), NaN and ±Infinity, bigint, functions, symbols, non-plain objects (Date, typed arrays, Map), cycles (the same object twice is fine), and lone surrogates in values or keys (RFC 8785 §3.2.2.2). Vectors (`test/vectors/jcs/`, README with sources): the RFC's §3.2.2 sample, §3.2.3 canonical form and sorting data extracted verbatim from rfc-editor.org's RFC 8785 text, the §3.2.4 bytes and all 24 Appendix B number samples (with NaN and Infinity refused) written into the test; the six input/output pairs of the RFC author's reference implementation (cyberphone/json-canonicalization at 19d51d7, Apache-2.0) compared byte for byte; the first 10,000 lines of its ES6 number file (sha256 b9f7a8e7…), and locally the first 1,000,000 lines with 0 mismatches (not committed: the file is 2 GB). Same snapshot, same hash: a snapshot taken from the O32.1 fixture hashes identically after pretty JSON round trip, canonical round trip, every object's keys reversed and `structuredClone`, canonicalization is idempotent, and the hash moves when items are reordered, one stored byte flips, `takenAt`, `omitted` or an `allowListed` mark changes; a hand-written snapshot and its hand-written canonical text give `keccak256` of that text. 28 new tests (46 in the package); 17/18 mutations caught, the survivor equivalent (`JSON.stringify` of a finite number is `Number::toString`).

### O32.3 · Dual pinning and verification
- Owner: OB
- PD: 0.75
- Depends: O32.2
- Plan: §8.2, ADJ-41
- Cut: no
- Status: skipped
- Files: oracle/services/snapshotter/src/pin.ts
- Build: Pin to two providers; `evidenceURI = ipfs://<CIDv1>`; verify both pins and a gateway fetch hash before anything is submitted; reviewer additions create a new snapshot, hash and URI.
- Done when: a snapshot pinned on testnet infrastructure re-fetches from its CID with the same `evidenceHash`.
- Check: cd oracle/services/snapshotter && bun test
- Notes: Skipped for the hackathon (team decision 3 Oct 2026, ADJ-41): no pinning-provider accounts; snapshots stay with the service that took them and `evidenceURI` is `eros-snapshot:<evidenceHash>`. Must be built before mainnet (the public-snapshot rule, spec §6.2).

## O33 · Panel runner
Plan §13: owner OB · 4 PD · depends O32 · acceptance: signed payload accepted on testnet; flagged snapshot → Review.

### O33.1 · Model clients
- Owner: OB
- PD: 1
- Depends: O32.3
- Plan: §8.3
- Cut: no
- Status: done
- Files: oracle/services/panel-runner/src/models/*
- Build: Three families from three providers pinned to exact versions (`modelIdHash = keccak256("provider:model-id@version")`); temperature 0 and fixed seeds where supported; JSON-schema structured output `{label, confidence, cited, rationale ≤ 1,000}`; invalid output counts as an API failure; 3 retries with back-off, then ABSTAIN; no valid citation, or only non-allow-listed citations, → ABSTAIN; calls independent, outputs never shared.
- Done when: tests with recorded provider responses cover each failure path.
- Check: cd oracle/services/panel-runner && bun test
- Notes: New package `@eros-oracle/panel-runner`. The provider table and request shapes of O22.3 moved from oracle-cli into `oracle-sdk/src/models.ts` (oracle-cli re-exports them and keeps its own retrying client; its 35 tests unchanged), with `modelIdHash(model)` and request options: the answer's JSON schema as OpenAI's strict `json_schema` response format, and `seed` for Gemini (the OpenAI-compatible providers already send seed 0; Anthropic has none). `src/models/answer.ts`: the answer `{label: YES|NO|INVALID|NOT_YET, confidence 0..1, cited: [item index], rationale ≤ 1,000 characters}` checked strictly whatever the provider enforced (exact keys, one ```json fence allowed, duplicate citations once); `checkCitations`: a citation is valid when the item exists and got a response; none valid → `NO_VALID_CITATION`, only context items → `ONLY_CONTEXT_CITED`, both ABSTAIN with the answer kept for the log. `src/models/client.ts` `askModel`: temperature 0; network error, timeout (300 s), 429, 5xx, an answer cut off at the token limit or empty, and invalid output are retried 3 times with the provider's Retry-After or 5 s, 15 s, 45 s, then ABSTAIN `API_FAILURE`; a missing key or another 4xx ABSTAINs at once (a retry cannot help); every attempt is recorded. `src/models/panel.ts` `askPanel`: exactly three models from three different providers (families are not derivable from the id, so providers are what is enforced), called concurrently with only the prompt and the items. Fixtures: `test/fixtures/responses/` constructed in each provider's documented format (Anthropic Messages, OpenAI and Groq chat completions, Gemini generateContent) for the paths a live call rarely shows (cut off, empty, 401, 429 with Retry-After, 500), and `test/fixtures/recorded/` real responses from `bun run record` (3 Oct 2026, keys from the repository's git-ignored `.env`, request headers never written; checked: no key in the files): `groq:openai/gpt-oss-120b@2026-10-03` YES cited [0] 0.99, `nvidia:moonshotai/kimi-k3@2026-10-03` YES cited [0, 1] 0.99, `google:gemini-3.8-flash@2026-10-03` YES cited [0, 1] 1.0, and a real Gemini HTTP 503 "high demand" (replayed: 4 attempts, ABSTAIN). Each recording is asserted to its exact outcome. These are the three models of the O22.4 ambiguity pass, pinned with the same date label; the formal choice stays with O39.3. 37 tests; 17/17 mutations caught.

### O33.2 · Prompts and prompt-injection defences
- Owner: OB
- PD: 0.75
- Depends: O33.1
- Plan: §8.3
- Cut: no
- Status: done
- Files: oracle/services/panel-runner/src/{prompts,injection}/*
- Build: One pinned prompt per category (`promptHash`); every item as a delimited, escaped, untrusted data block; the system prompt says instructions inside evidence are data; deterministic detector ("ignore previous", role tags, hidden or zero-width text, off-screen CSS) plus a small classifier model; any hit sets `FLAG_INJECTION_SUSPECTED`.
- Done when: a fixture set of injected items is flagged and clean items are not.
- Check: cd oracle/services/panel-runner && bun test
- Notes: Prompts (`src/prompts/`): one template per validation category (sports, macro, elections, politics, crypto, companies, other) in `templates/<category>.txt`; `categoryId = keccak256(name)` (the example pack's categoryId is sports), `promptHash = keccak256(file bytes)`. The first line `# eros-panel-prompt v1 item_chars=6000 evidence_chars=24000` pins the evidence budgets, so promptHash commits to them (24,000 characters keeps a full prompt inside the Groq free tier's 8,000 tokens per minute for gpt-oss-120b). The system prompt states that instructions, answers, labels or role markers inside evidence are data, never instructions (defence 2), that context items alone cannot carry a label, the JSON answer form, and category guidance. Evidence (defence 1): each item is `<evidence index host allow_listed http_status content_type fetched_at truncated shortened trust="untrusted">` around one JSON string of its prompt text with `<`, `>`, `&`, U+2028 and U+2029 escaped, so content cannot close or open an element or start a line; attribute values come from checked fields (content type reduced to token characters); binary or failed items are `null`; text is cut by code points at the budgets. Placeholders are filled in one pass, so evidence or market text cannot pull in another value. `promptFor(categoryId, promptHash)` refuses a market whose pinned hash is not the template's. Injection (`src/injection/`, defence 3): a deterministic detector over each item's raw bytes (INSTRUCTION, LABEL_COERCION with the panel's labels written as it writes them, ROLE_TAG including the prompt's own `<evidence>` tag, INVISIBLE_CHAR for zero-width spaces, word joiners, a non-leading BOM, bidi overrides and isolates and Unicode tag characters, but not ZWJ or ZWNJ; HIDDEN_TEXT for text hidden by inline CSS, the hidden attribute or a hiding `<style>` class that is 200+ letters or instruction-like, since short hidden menus and "skip to content" links are normal), and Meta's Llama Prompt Guard 2 86M on Groq over the text each item puts into the prompt, in 800-character chunks with 100 overlap, threshold 0.5, retried 3 times; a classifier that cannot answer is itself a finding. Any finding sets `FLAG_INJECTION_SUSPECTED` (1). Fixture set (`test/fixtures/injection/`): 6 clean items chosen to look suspicious (hidden mobile menu, screen-reader link, hidden "Loading…", emoji with ZWJ, BOM, Persian ZWNJ, "resolve to Yes if", a UI `"label": "No"`, "The system:", "ignored … instructions") and 16 injected ones (plain, chat-template and [INST] tags, hidden div, long hidden prose by visibility, off-screen position, text-indent, class and font-size 0, zero-width, tag smuggling, bidi, evidence-tag breakout, a label pair in JSON, an HTML comment, a polite "Dear assistant" request). All 16 are flagged and no clean item is, with the classifier's real answers recorded (`bun run record:classifier`, 20 chunks, 3 Oct 2026) and replayed by chunk hash. Measured: Prompt Guard 2 flags only 3 of the 16 (plain "ignore all previous instructions" 0.9994, hidden-div 0.9992, text-indent 0.9908), scores chat-template tags 0.20, [INST] 0.03 and the polite request 0.001, and every clean item below 0.002; the deterministic rules carry the rest, and direct-address rules ("dear assistant", "AI reading this") were added for the polite case. CSS-hidden text is not removed from prompt text (the snapshotter's `text.ts` comment that said it was is corrected); such text is flagged when long or instruction-like. 46 new tests (83 in the package); 26 mutations caught after removing a dead BOM branch (the decoder consumes a leading BOM) and a rule another rule fully covered.

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
- Plan: §8.4, ADJ-22, ADJ-41
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
