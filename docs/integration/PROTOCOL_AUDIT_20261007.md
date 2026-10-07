# Independent protocol audit — 2026-10-07

## Scope and conclusion

This review started after the frontend, price-feed and v3 deployment integration was wired. An independent lead reviewed frontend custody, transactions, Privy permissions, pricing display and runtime harnesses, delegated a contract accounting/sampler review, and delegated an oracle, service, SDK and source review. The contract reviewer subsequently repaired frontend pagination and investigated process cleanup. Findings were reproduced, repaired and regression-tested in the shared working tree. Existing integration work was preserved.

The initial pass confirmed eight actionable defects: one high-severity watchdog intake defect and seven medium-severity service, interface or harness defects. A subsequent live-observation follow-up confirmed and repaired the additional medium-severity publication/sampler coupling in PA-09. A later malformed-history check confirmed the low-severity chart timestamp defect in PA-10. The findings below identify their preconditions and actual effects. None establishes theft or insolvency in the deployed contracts. The initial source pass found no additional production Solidity defect; subsequent canonical v3 runtime traces confirmed the sampler liveness defect in PA-11. Its narrowly scoped contract repair is tracked separately from the earlier wrapper fixes. Final adversarial review additionally confirmed delegated retry, price-row binding, deployment receipt, keeper gas and private replacement-orchestration defects (PA-12 through PA-16). This conclusion is a scoped source review and regression result, not a proof that the protocol has no other bugs.

The audit agents did not broadcast transactions, deploy contracts on chain, rotate keys, rewrite private journals, change public manifests, restart live services, commit or push. Existing v3 runtime verification and live transaction evidence remain the deployment owner's separate responsibility. The repository already contained the `samplePerp` continuity implementation on entry; this audit independently reviewed and tested it.

Evidence summaries and sanitized test logs are in `artifacts/integration/protocol-audit-20261007/`. Detailed working reports and raw local test output are in the ignored `tmp/protocol-audit-20261007/`. Test totals below overlap and must not be added together.

## Confirmed findings

| ID | Severity | Component | Defect | Status |
| --- | --- | --- | --- | --- |
| PA-01 | High | Watchdog intake | A capped indexer response permanently skipped resolution events | Fixed |
| PA-02 | Medium | Oracle SDK indexer | Unready, wrong-chain or inconsistent progress was trusted | Fixed |
| PA-03 | Medium | Pricefeed worker | Rejected future timestamps poisoned durable source ordering | Fixed |
| PA-04 | Medium | Watchdog source fetch | Body-size guard ran after unbounded response buffering | Fixed |
| PA-05 | Medium | Frontend RPC | Unfinished uploads could occupy every RPC slot indefinitely | Fixed |
| PA-06 | Medium | Frontend history/discovery | Short server-capped pages were incorrectly treated as complete | Fixed |
| PA-07 | Medium | Authenticated frontend APIs | Valid browser origins were rejected behind a bind address/proxy | Fixed |
| PA-08 | Medium | Local process harness | macOS zombie probing falsely failed owned-process cleanup | Fixed |
| PA-09 | Medium | Live publication wrapper | Sampler timestamp gating can create avoidable INDEX outages | Wrapper fixed; continuous v3 MARK liveness not established |
| PA-10 | Low | Frontend history | Unbounded observation timestamps can break chart rendering | Fixed; malformed-time regression passes |
| PA-11 | Medium | Concrete book sampler | Raw INDEX checkpoint identity rejects unchanged capture pricing | Source repaired; 36 sampler regressions and independent review pass; v4 deployment owned by operator |
| PA-12 | Medium | Delegated frontend orders | Lost successful API responses permit duplicate submission under a new request key | Fixed; actual server/API and client recovery regressions pass |
| PA-13 | Low | Frontend price history | Valid rows from another engine can enter the requested chart | Fixed; wrong-engine/kind regressions pass |
| PA-14 | Medium | Deployment execution | Replacement receipt can be paired with the original transaction | Source repaired; exact canonical receipt regressions pass |
| PA-15 | Medium | Testnet keeper wrapper | A valid sample above the fixed gas cap terminates unrelated keeper work | Fixed; explicit bounded ceiling and 7 actual-Operations regressions pass |
| PA-16 | Medium | Private v4 orchestration | Unbound reports and partial file publication break safe replacement/resumption | Fixed; 27 fixture tests pass; operator source selection required |

### PA-01: watchdog intake can silently miss proposals and assertions

**Paths:** `oracle/services/watchdog/src/chain.ts`, `oracle/packages/oracle-sdk/src/indexer.ts`.

When Hasura/Envio capped rows in the requested 10,000-block interval, the old unpaginated query returned only a prefix. The intake cursor nevertheless advanced past the entire interval. Omitted proposals were never checked and omitted assertions could understate the watched bond float. A false proposal could therefore miss the watchdog's automatic challenge path. Other resolution safeguards still apply; this does not by itself bypass the oracle contracts' authorization.

The regression supplied three same-block proposals under a one-row server cap. The original implementation returned log index `[0]` instead of `[0, 2, 4]`. The repair uses stable ordering and independent proposal/assertion offsets, advances by actual rows returned, and requires empty pages from both lists before committing the range cursor. A later-page failure discards partial data and uses RPC for the original interval.

**Verification:** capped same-block proposals, unequal list caps, later-page failure and existing RPC/indexer transitions in `oracle/services/watchdog/test/intake.test.ts`; the changed GraphQL query validates against the generated indexer schema.

### PA-02: incomplete indexer progress is treated as authoritative

**Path:** `oracle/packages/oracle-sdk/src/indexer.ts`.

The original progress validator accepted a numeric block without requiring the requested chain, safe integer bounds, consistent source height or `isReady === true`. A bootstrapping or misconfigured endpoint could be selected as fresh even while its event rows were incomplete. That could cause keeper/watchdog cursor advancement over missing data.

The repair validates chain identity, nonnegative safe integer heights, `sourceBlock >= progressBlock`, and explicit readiness. Failure takes the existing RPC fallback. An indexer ahead of a previously sampled RPC head remains allowed because that can be a normal race; watchdog intake still caps its range to that head.

**Verification:** `oracle/packages/oracle-sdk/test/indexer.test.ts` covers unready/missing readiness, wrong chain, negative/fractional/unsafe progress and inconsistent/missing source height, alongside valid metadata and existing keeper behavior.

### PA-03: a future source timestamp permanently poisons the ordering cursor

**Path:** `packages/pricefeed/src/worker.ts`.

A future-stamped response was rejected for publication but still replaced persisted `lastSourceMs`. The next correctly timed response then triggered the permanent `BACKWARDS_SOURCE_TIME` quarantine, including after a restart. The reproduction accepted time `1000000`, rejected future time `9999999999999`, and observed the future value incorrectly persisted as the ordering baseline.

Only monotone, non-future timestamps now advance the cursor. The rejected capture remains archived and unavailable. Genuine backwards movement still quarantines. Existing poisoned journals are preserved for explicit operator recovery; this fix does not silently erase prior evidence.

**Verification:** `packages/pricefeed/test/worker.test.ts` exercises healthy → future rejection → restart → healthy recovery, followed by a real backwards response. The regression failed before the source change and passes with the fix.

### PA-04: oversized provider responses can exhaust watchdog memory

**Path:** `oracle/services/watchdog/src/l1.ts`.

Primary and sports companion responses were fully read with `arrayBuffer()` before applying the 250 KiB evaluator cap. A large response from an allowed source could consume excessive memory and stop checks across all watched markets before returning a bounded evaluation error.

The repair reads bounded chunks, cancels as soon as the cap is crossed, and decodes only bounded bodies. Cancellation is not awaited, so a slow producer cannot delay rejection through its cancellation handler. The existing primary `BODY_TOO_LARGE` and companion `SPORTS_COMPANION_UNAVAILABLE` outcomes remain intact.

**Verification:** primary and F1 companion tests offer twenty 128 KiB chunks. The old implementation consumed all twenty; the repaired reader consumes two and cancels. Normal feed/provenance tests also pass.

### PA-05: six unfinished request bodies block the frontend RPC proxy

**Paths:** `frontend/src/app/api/rpc/route.ts`, `frontend/src/lib/rpc-proxy.ts`.

The proxy acquired one of six global in-flight slots before reading the body. The byte limit bounded completed data but there was no upload deadline. Six clients that opened bodies without completing them could hold all slots indefinitely, leaving legitimate market reads with HTTP 429. No authentication is required on this public read endpoint.

The body reader now has a five-second total deadline, retains the 256,000-byte limit, cancels unfinished readers, returns HTTP 408 on timeout and releases the slot through the route's `finally`. Upstream calls retain their separate timeout and read-only method allow-list.

**Verification:** `frontend/tests/rpc-proxy.test.mjs` covers timeout/cancellation and byte limits without Content-Length. `frontend/tests/integration/rpc-read-budget.test.ts` occupies all six slots, observes the seventh request rejected, waits for six 408 responses, verifies cancellation, and demonstrates that a subsequent request reaches validation. No upstream request or signing is needed for this test.

### PA-06: capped indexer pages truncate frontend history and market lists

**Paths:** `frontend/src/lib/history.ts`, `frontend/src/lib/market-discovery.ts`.

History and discovery assumed that fewer than 1,000 returned rows meant the end and incremented offsets by 1,000. Under a lower server cap, the UI omitted real events and could call incomplete account totals complete. The combined vault/transfer request also used one offset for differently sized lists. The regression returned eight of twenty available events while reporting complete history.

Pagination now advances by the actual row count and proves exhaustion with an empty page. Vault and transfer lists have independent offsets and limits. The 20,000-row per-history-list cap remains explicitly incomplete, and the 100,000-row discovery cap remains an error. An exhausted or capped list uses a zero limit while the other continues. New registry discoveries still cannot authorize owner transactions outside the verified manifest.

**Verification:** `frontend/tests/integration/history-pagination.test.ts` covers server caps, independently exhausted lists, bounded final pages, deduplication, malformed payloads and capped discovery.

### PA-07: public-origin mismatch disables authenticated API writes

**Paths:** `frontend/src/server/privy.ts`, `frontend/src/lib/request-origin.ts`, `frontend/src/lib/rpc-proxy.ts`.

`jsonBody()` compared the browser Origin directly to `request.url`. Next can construct that URL from `0.0.0.0` or an internal HTTP bind while the browser uses localhost or a public HTTPS authority. Legitimate trade/protection/permission requests then failed with `Invalid request origin` before execution. The RPC path already handled the public authority correctly, so behavior differed between routes.

Both paths now share the existing strict comparison of the parsed Origin to the requested Host and recognized forwarded protocol. Foreign origins, extra origin paths and mismatched scheme/port still fail. Wallet ownership, access-token validation, signing policies and transaction limits are unchanged.

**Verification:** `frontend/tests/integration/request-origin.test.ts` failed on the bind-address case before the repair and now passes localhost, HTTPS proxy and rejected foreign-origin cases. Existing RPC origin tests also pass.

### PA-08: non-Linux POSIX cleanup treats a zombie root as a live failure

**Paths:** `scripts/integration/owned_process.py`, `scripts/integration/test_owned_process.py`.

On macOS, `killpg(pid, 0)` can return EPERM when the owned root has become an unreaped zombie after SIGTERM. The original non-`/proc` probe propagated that error before reaching `wait()`, reporting cleanup failure even though the root had exited. The tests also assumed `/proc` existed on every POSIX platform, incorrectly reporting live macOS children as absent. The initial harness audit ran 90 tests and reported six failure outcomes and five Windows-only skips, all failures in this ownership suite.

The minimal reproduction created a dedicated `sleep` session, observed a successful running group probe, terminated it, observed EPERM before reaping, then observed ESRCH after `wait()`. The repair promptly reaps the owned root and uses numeric PID/PGID/status enumeration on systems without `/proc`. It excludes zombie rows and unrelated groups, treats unknown owned states conservatively as live, and fails closed on malformed, empty, failed or timed-out enumeration. Cleanup still signals only the dedicated owned group. Test liveness checks now use the platform's process information.

**Verification:** new regressions cover zombie-only groups, exact group membership, unknown states and enumeration failures. Actual macOS subprocess tests cover child/grandchild trees, a stubborn tree, an exited parent and unrelated-process survival. The focused suite ran 14 tests: nine passed and five Windows-only tests skipped. The complete integration Python suite ran 93: 88 passed and five Windows-only tests skipped.

### PA-09: sampler coordination can suppress authentic INDEX updates past expiry

**Paths:** `scripts/e2e/pricefeed-watch.mjs`, `scripts/e2e/sampler-coordination.mjs`, `scripts/e2e/market-services.ts`, `scripts/e2e/sample-capture.mjs` and their tests/types.

The deployment owner observed INDEX sequence 64 at source time 22:25:55, a book capture at 22:26:08, and repeated `WAITING_FOR_SOURCE_AFTER_BOOK_SAMPLE` while authentic intermediate source data was available. The next selected source timestamp was 22:26:28: a 33-second gap, exceeding the contract's 30-second carry. The wrapper had made the last sampler acknowledgement a permanent lower bound on independent INDEX selection. It also awaited sampler acknowledgement before resuming publication. A further issue was that acknowledgement time came from the receipt block, although `samplePerp` can succeed without emitting a new capture.

Simply publishing every intermediate observation asynchronously would preserve INDEX but could repeatedly invalidate pending captures. With a five-second source cadence, seven-second publication latency and five-second sampler latency, a newer publication can still have a source timestamp before the pending capture and change its INDEX predecessor. The deployed v3 contract invalidates that candidate on any changed predecessor identity. The v4 repair in PA-11 instead invalidates changed exact capture pricing inputs; economically equivalent renewals may pass.

The repair makes coordination nonblocking, retains one persistent outstanding request, coalesces newer finalized sequences, and requires the exact acknowledgement before replacing that request. Seal requests use actual `BookDepthCaptured` event timestamps from canonical finalized blocks. No-op calls retain verified prior capture evidence; legacy receipt timestamps are not reinterpreted as captures. Signed packet journals supply the exact finalized observation timestamp; restart recovery verifies the stored relay checksum, packet digest and canonical finalized block.

Publication now gives a pending capture only a bounded preference. The preference expires unconditionally at the latest valid finalized INDEX source timestamp plus 22 seconds, reserving eight seconds for delivery against its unchanged 30-second lifetime. At that deadline, ordinary source freshness selection wins even if the keeper is slow, stopped or never acknowledges. If an intermediate INDEX changes the pending capture's predecessor, v3 invalidates it. In v4, invalidation instead requires changed exact economic capture inputs as described in PA-11. The source timestamp is never rewritten and no journal is reset.

**Verification:** 16 combined coordinator/capture tests pass, including late/wrong acknowledgements, coalescing, restart/shutdown, no-op/legacy capture evidence, canonicality, and three timing traces. The five/seven/five-second trace seals successive captures aged 15 seconds. The Senate trace releases preference at 22:26:17, admitting the authentic 22:26:05 observation; with the tested seven-second delivery assumption it finalizes at 22:26:24, before the old observation expires at 22:26:25. These are deterministic scheduler traces, not live continuity certification. Runtime TypeScript and publisher syntax checks pass. A source outage or delivery exceeding the reserved time can still cause a real gap; no scheduler can manufacture missing fresh observations or guarantee external RPC latency.

### Read-only observation after the first live wrapper restart

The deployment owner restarted keepers and publishers at approximately 22:41:43–47 UTC, preserving their journals. Independent receipt inspection confirmed Republic's actual captures and PERP events against canonical block hashes. Capture 22:41:57 was invalidated when a subsequently accepted source observation at 22:41:54 changed its predecessor. Valid promotions then continued from capture 22:42:17 through 22:43:42. Captures 22:43:58, 22:44:20 and 22:44:44 were subsequently invalidated by authentic intermediate source updates. Stable book fingerprints and ages below 30 seconds distinguish these provenance changes from book mutation or expiry. Valid promotions resumed from capture 22:45:09.

The initial 12-second delivery reserve caused premature fallback relative to this feed's actual update cadence. Archived source evidence shows observation 22:44:07.491 received at 22:44:08.038, and observation 22:44:27.869 received at 22:44:28.068. Canonical publication receipts show signed publication time to inclusion of 4–6 seconds. The revised eight-second reserve admits these later observations before selecting an intermediate update. A regression uses the actual archived arrivals and each measured inclusion latency, with additional finality/capture delay; both successive captures seal under their original 30-second lifetime. This is an operational tradeoff supported by the measured trace: an inclusion delay exceeding eight seconds or a source outage can still create a real INDEX gap. The repair changes scheduling only, without changing contract freshness, source timestamps, signatures or provenance checks.

Senate's restart crossing had an independently confirmed source gap from sequence 134 at 22:41:17 to sequence 135 at 22:41:49, leaving two seconds uncovered in its 300-second INDEX window. The resulting zero `bookDepth` was the contract's unavailable-INDEX gate, not evidence that funded orders disappeared. The keeper correctly reported `book-not-ready` and retained the actual old capture timestamp. INDEX recovery must precede new book capture and subsequent complete BASIS recovery; neither may be fabricated by a successful transaction receipt.

A portable sanitized evidence bundle is retained in `artifacts/integration/protocol-audit-20261007/runtime-followup-evidence.json`. Working evidence is retained in `tmp/protocol-audit-20261007/republic-postrestart-receipts.json`, `republic-postrestart-index-receipts.json`, `postrestart-packet-health.json`, and `republic-source-arrival-trace.json`. These are read-only observations of a finite interval, not continuous uptime certification. The deployment owner owns subsequent restarts and live validation. A separate counterfactual replay of 337 archived arrivals, using shifted captures and each fixed 4/5/6-second inclusion latency plus two seconds of finality and three seconds to capture, produced no invalid candidates under the eight-second reserve (27/25/22 valid samples). The corresponding twelve-second reserve produced 4/8/9 invalid candidates. These are stable-book timing models, not a replay of the full contract or a guarantee under variable latency.

### Later eight-second-reserve live observations

The operator restarted the publishers with the eight-second reserve around 22:49 UTC. Canonical Republic receipts subsequently confirmed two more invalidations: capture 22:51:37 was rejected at 22:52:06 (age 29 seconds) after sequence 143, observed 22:51:36, was accepted at 22:51:52; capture 22:53:03 was rejected at 22:53:31 (age 28 seconds) after sequence 149, observed 22:53:01, was accepted at 22:53:18. Book fingerprints remained identical and inclusion latency remained 4–6 seconds. The bounded fallback correctly preserved INDEX priority, but its intermediate observations changed the raw checkpoint identity. This demonstrates that the earlier finite timing replay was insufficient to establish continuous live MARK availability. No report of a fixed scheduler should be interpreted as successful v3 MARK liveness validation.

### Bounded initial rollover scheduling

The wrapper may defer an expired BOOTSTRAP epoch's ordinary rollover for at most 20 seconds while complete pricing windows become available. It requires active TRADING state, no monitor restriction, unchanged READY storage work and only rollover pending, a valid current INDEX/PERP window, and accepted PERP carry extending another eight seconds. All reads are pinned to one block. Candidate readiness releases the delay immediately. A signed pending journal entry, NORMAL pricing, a started sweep, activation, floor/halt work, approaching time restrictions or expired carry bypasses deferral.

This is a narrow operator scheduling aid. After the epoch expires, virtual accounting reports `ROLLOVER_SWEEP`; eligible book sampling stops until the rollover completes. Therefore only already accepted observations' original carry can finish a nearly complete window. The delay cannot recover minutes of missing BASIS, extend freshness or guarantee NORMAL admission. The contract performs final admission at transaction execution. Ten helper regressions cover the nine-second recovery case, carry expiry, absolute deadline, exact invalid endpoint, pending transaction bypass, NORMAL/lifecycle exceptions and read failure. A cached future epoch deadline skips all deferral RPC reads while the ordinary operations poll remains responsible for lifecycle work.

### PA-10: nested observation timestamps bypass chart bounds

The history validator bounded the enclosing event timestamp but accepted arbitrary decimal strings for `ObservationAccepted.observedAt` and `PerpObservationRecorded.t`. A reproduced 400-digit payload converted to `Infinity`, reaching the chart's end time and producing invalid Date labels and SVG coordinates. A malformed indexer response could therefore break the chart despite passing history validation.

Both payload timestamps now require safe integer seconds within JavaScript Date bounds and cannot exceed their enclosing event timestamp. Tests cover overflow, future times, negative/fractional values, historical/equal times and the maximum valid Date boundary for both event kinds. The focused history/chart suite passes 10/10. The change is confined to `frontend/src/lib/history.ts` and `frontend/tests/integration/history-pagination.test.ts`; it does not alter contract observations.

### PA-11: raw INDEX checkpoint identity overconstrains sampler liveness

In v3, the pending capture commits to the raw floor checkpoint, including its observation timestamp and cumulative fields at that timestamp. An authentic same-price, continuously valid update at or before the capture changes this identity even when the exact INDEX300 integral, covered seconds and instantaneous capture value are unchanged. The resulting invalid PERP/BASIS observation creates a historical availability gap. Canonical quiet-book v3 receipts establish the effect; the service deadline changes cannot guarantee its absence.

The agreed invariant compares retained-history availability, exact cumulative integral and covered seconds at both capture time minus 300 seconds and capture time, plus instantaneous INDEX availability and value at capture. It retains the strict newer-source seal and every existing block, age, book/account, epoch, risk and current-depth guard. Same-price refreshes may then preserve a candidate without changing its timestamp or lifetime. Any change in the committed capture pricing inputs rejects it. A same-time endpoint correction is checked separately because it has zero integral weight.

This is economic capture equivalence, not literal equality of every intermediate price. Compensating two-second deviations at 0.49 and 0.51 against a 0.50 baseline can have identical exact endpoints and capture value; that case is accepted by design if all other guards match. Once the source advances strictly beyond capture, monotone ingress seals the actual resulting prefix and protects recorded BASIS. The detailed invariant and historical-policy distinction are documented in `docs/questions/RB-I11-index-prefix-seal.md`.

The source repair changes only `_indexCheckpointAt` and its comments in `BookRiskEngine.sol`. Nine new regressions cover authentic same-price renewal with strict seal waiting, compensated changes, an exact integral change hidden by TWAP rounding, same-time price/validity changes, introduced and repaired coverage gaps, unchanged PERP age at the freshness boundary, and both cumulative endpoints. Three positive cases failed on the old source; the final concrete sampler suite passes 36/36. The same-time validity regression keeps current INDEX300 available to isolate the capture-point check. Two existing 64-account/full-history gas benchmarks pass, with maximum measured promotion gas 5,878,672. A separate reviewer inspected the implementation and adversarial cases and found no blocker; that reviewer did not independently rerun the compiler. Existing v3 manifests, journals, receipts and source hashes remain historical evidence. They must not be relabeled as validation of a revised deployment; the operator owns v4 compilation, deployment and fresh full-suite/live proof.

### PA-12: retrying a lost delegated-order response can submit twice

**Paths:** `frontend/src/lib/tx.ts`, `frontend/src/lib/delegated-attempt.ts`, `frontend/src/lib/privy-api.ts`, `frontend/src/server/trade.ts`, trade API, ticket and finality helpers.

The actual server reproduction persisted a successful request as `sent`, discarded its HTTP response, then repeated the same user intent using the UI's newly generated request nonce. Because the server only deduplicated an identical key and excluded completed `sent` entries from its uncertain-request lock, the retry broadcast a second order. Reusing the original exact request returned the first hash without another broadcast. Contract admission still applies, but a network timeout could duplicate intended exposure.

The repair saves the exact public request body, preview block and nonce before POST, bound to owner, chain, engine and calldata. Explicit recovery precedes fresh simulation because the first fill may have changed the account. A known hash triggers receipt tracking only. An unresolved attempt blocks changed trading intent and is retained across reload in session storage. It is removed only after exact canonical completion/revert or an authoritative durable rejection. Ownership is checked before returning an existing hash, while new sends retain current signer-policy and revocation checks.

The server now claims the request transactionally before asynchronous preflight. This prevents a second copy's preflight rejection from being interpreted as terminal while an older copy could still sign. Pre-send failures become durable `rejected` outcomes; signing uncertainty remains blocked. Typed delivery outcomes distinguish these states from transport/authentication ambiguity. This avoids both blind retry and permanent deadlock after a deterministic rejection. The focused actual-server, API and client-helper regressions pass, including a lost response after persisted `sent`, concurrent request copies, durable rejection, known-hash recovery after revoked permission/stale preview, exact owner/chain/call/session binding and canonical-revert identity. Full unit tests pass 58/58 and integration tests pass 28/28; no live hosted Privy signer has been exercised by the audit agents.

### PA-13: price-history responses are not bound to their requested engine

**Paths:** `frontend/src/lib/history.ts`, `frontend/tests/integration/history-pagination.test.ts`.

A reproduced response returned a well-formed `ObservationAccepted` row for engine B to a query for engine A. Shape and timestamp validation passed, so engine B's price entered engine A's chart. This requires a misbound or untrusted indexer response and does not bypass RPC transaction admission. The repair requires price rows to match the queried engine and one of the requested price-event kinds. Vault/account history retains its deliberate separate query scope.

### PA-14: deployment confirmation must identify the exact signed transaction

**Paths:** `oracle/e2e/src/fresh-testnet.ts`, `oracle/e2e/test/fresh-receipts.test.ts`.

A receipt wait can return the receipt of a same-nonce replacement. The old confirmation guard checked the original transaction's intent and the receipt's canonical block without requiring both to identify the same transaction and mined block. A cached original transaction paired with a different successful replacement receipt could therefore mark a deployment step complete and discard its uncertain signed bytes.

The confirmation helper now binds the journal hash, receipt transaction hash, fetched transaction hash, transaction block number/hash, receipt block and canonical block before any journal mutation. Sender, target, nonce, value, calldata and successful creation address must also match the plan. An exact canonical revert remains a distinct known failure and retains signed evidence; a replacement revert remains an identity mismatch. The independent lead reviewed both the helper and its actual `executePlan` call site. Nine fixture regressions pass with 46 assertions, covering pending originals, replacement hashes, mismatched mined membership, every intent field, exact success, creation and canonical revert. The complete oracle E2E package passes 39/39 (215 assertions), and its TypeScript check passes. These runs do not compile or mutate the backend proof artifacts.

### PA-15: the testnet keeper's fixed gas cap can stop all work

**Paths:** `scripts/e2e/market-services.ts`, `scripts/e2e/keeper-gas-policy.mjs` and its declarations/tests.

The full-history 64-account promotion benchmark uses 5,878,672 gas. Its existing 25% margin plus 10,000 requires 7,358,340 gas, exceeding the wrapper's hard three-million ceiling. The resulting uncaught error stopped the process, including unrelated rollover work and heartbeat. This is an operational wrapper capacity defect; production market-ops already supports calibrated action limits up to 30 million.

The wrapper retains a three-million default and accepts explicit `EROS_KEEPER_MAX_GAS` between 21,000 and 30 million. An oversized unsigned action now emits an actionable waiting record and exact sample acknowledgement without signing, altering a pending journal or ending unrelated work. The runtime helper ceiling is also clamped before batch estimation, permitting smaller productive rollover batches without changing the stored manifest or journal identity. If no measured page fits, rollover waits unsigned while sampling remains available. Pending signed transactions still reconcile even if the configured ceiling is lowered. The operator authorized eight million for the new v4 keeper based on the measured benchmark and margin. The selected estimate remains the transaction gas basis; the ceiling does not replace it or raise the funding budget automatically.

Seven regressions exercise the actual `Operations` class: bounds/defaults, unsigned refusal followed by successful rollover submission, benchmark admission under eight million, pending reconciliation under a lower ceiling, and preservation of unrelated/pending errors. All seven pass with 49 assertions; runtime TypeScript, helper syntax and diff checks pass. A separate reviewer read the final wrapper/helper wiring and found no blocker in the measured v4 path; that reviewer did not rerun the tests. A market requiring more than the explicit bound still needs measured operator configuration and adequate funding; no continuous sampling guarantee follows from the higher ceiling.

### PA-16: private replacement orchestration lacks complete identity and resume guards

**Paths:** ignored `tmp/sports-unified-20261006/{deploy-v4-markets,wire-v4-frontend,start-v4-services,v4-state}.mjs` and private fixture tests.

An isolated filesystem reproduction allowed two market reports with different chains/factories to be published together. A simulated failure after the current manifest write left metadata/calibration only partly updated, and retry then stopped at an already-wired check. The original deployment wrapper also refused an existing market plan rather than resuming its durable execution journal. These are private operator-tool defects; they were found before v4 market preparation or public execution.

The repair binds base and market reports to their exact plans, shared chain/factory/vault/registry/oracle/token identities and current compiled/runtime identities. Previously confirmed broadcast steps require exact canonical receipts before being skipped; uncertain signed entries remain the execution planner's responsibility. A staged frontend intent records before/after file hashes and resumes an interrupted switch only when every current target matches one of those states. Unexpected concurrent edits fail closed.

Service restart now retains plans and journals, rejects every existing launcher lock pending explicit operator review, and validates recorded process identity before adoption or signalling. Newly launched and adopted services both report unexpected early exit as unhealthy. Failure drains owned children and identity-checked adopted services; surviving or uncertain process identities retain the lock. A valid existing journal admits a service to its own reconciliation, not to unverified new sends. No automatic budget extension or source reset occurs.

Source selection now requires an explicit operator-approved selection and hashed qualification envelope for each role-directory slot; no source is silently copied from v3. Qualification requires matching source/event/condition/token identifiers, a passing operator assessment and at least 900,000 milliseconds of observation. The old directory names identify retained roles and keys, not event identity. Frontend titles/categories must come from the exact selected candidate metadata. A changed approval or candidate cannot silently replace an already prepared plan. These gates record the operator's finite evidence and do not guarantee future vendor availability. All 27 private fixture tests and syntax checks of the four implementation modules pass. The lead independently reviewed identity checks and actual lifecycle wiring. Tests use temporary configuration files and synthetic RPC/process boundaries; no live deployment, switch or service restart was executed. A completed historical rehearsal is structurally bound to its exact plan and receipts; its destroyed fork cannot be independently queried, and incomplete rehearsals require retained history.

### Qualification-helper follow-up to PA-16

The tracked `scripts/e2e/selected-source.mjs` now uses a tested `source-qualification.mjs` helper. Candidate rules are checked against the Worker's live baseline on every poll. A rejected future timestamp may retain only a previous valid observation's original carry, and only when status is exactly DEGRADED, the reason is future/stale time, raw age is negative, time is monotone and book depth is valid. This matters because the actual collector evaluates future time before its invalid-depth outcome; checking the reason alone would mask a simultaneous thin book.

Receipt time is reconstructed from the source timestamp plus source age. Fifteen minutes of coverage starts at the first valid receipt, excluding cold startup, and requires at least 800 valid polls. Future polls never advance the accepted timestamp or valid count. The final report checks carry through its actual wall-clock endpoint, including the last sleep and processing delay. The original 30-second lifetime and configured headroom remain unchanged; current configuration requires carry below 25 seconds. The run has a bounded startup allowance and fails rather than shortening the coverage requirement.

Seven focused regressions pass, including one using the actual compiled `inspectSnapshot` to reproduce a future-stamped thin book, candidate-baseline mismatches, the final 25-second endpoint boundary, delayed startup, exact valid-poll counts and timing failures. Runner/helper syntax and diff checks pass. A separate reviewer inspected the helper and actual runner wiring and found no blocker without rerunning tests. No live probe, signing, deployment or frozen backend/frontend modification was performed for this repair. Its result is finite observed source-carry eligibility; it is not proof of accepted on-chain publication continuity or future uptime.

## Contract and economic review

The reviewers traced concrete book/engine composition, admissions, reservations, projected previews, rounding, coverage, account posting, funding/premium/fees, liquidation, floor/epoch/halt transitions, settlement snapshots and payout allocation, collateral custody, reserve notice/redemption and backstop boundaries. Selected invariants came from `docs/spec/risk_spec.md`, `docs/spec/book_interface.md`, `docs/math/units.md`, accounting/lifecycle runbooks, and `docs/questions/RB-I11-index-prefix-seal.md`.

The reviewed invariants include paired cash/position posting; exact token receipts and market-scoped vault movement; current reservation generations; both terminal coverage checks and per-account reserve limits; delayed calibration activation and full backing for missing/expired profiles; authenticated immutable finality; snapshot conservation before enabling claims; fixed claim recipients; atom-floor payouts with explicit residual Q; and reserve share notice requirements. Oracle outcome and engine outcome enums remain distinct and mapped explicitly.

The oracle trace covered authenticated CRE forwarder/workflow identity and revocation, exact report/domain/spec/time checks and replay rejection; EIP-712 panel/committee payloads, thresholds and signature uniqueness; pinned halt trust sets; authoritative UMA status readback; registry listing validation and OI limits; and registry-only factory creation with pinned code stores, listing hashes and vault registration. The later PA-11 repair changes only the concrete sampler’s internal INDEX fingerprint; the oracle authentication and accounting paths described here are unchanged.

### Independent `samplePerp` continuity assessment

Discarding an unsealed candidate after a book/account/epoch mutation does not publish a valid checkpoint, change the prior accepted observation time, or extend its original 30-second lifetime. A replacement candidate must independently pass later-block, unchanged-depth/account, epoch/profile, capture-time INDEX checkpoint and strict source-prefix checks.

The source seal still requires `lastObservedAt > pending.observedAt`. In v3, same-time correction or backfill that changes the raw predecessor identity invalidates capture-time provenance. In v4, a pre-seal update invalidates it only when exact committed economic inputs change; after sealing, nondecreasing source ingress prevents an observation at or before that capture time from arriving later. Explicit expiry, changed provenance, unavailable INDEX and a subsequently confirmed stable thin book still produce invalid PERP/BASIS observations.

Two added regressions make these boundaries concrete:

1. A changed book discards the pending capture, then a stable thin candidate confirmed one second later terminates PERP/BASIS carry while the old accepted observation is still younger than 30 seconds and INDEX remains available.
2. An authenticated same-time INDEX correction still invalidates PERP/BASIS when a book mutation occurs concurrently; the book-discard path cannot suppress source invalidation.

The concrete sampler suite passed 27/27 after the delayed-opening regression and 36/36 after the nine semantic-fingerprint regressions. The previously completed 837-test contract CI suite and 105/14 integration/factory evidence were inputs to this review, not newly rerun audit results. Existing source/runtime provenance must remain attached to their original test runs.

Operationally, at steady sample cadence C, one discarded candidate can create approximately a 2C accepted-observation gap. The observed 14–18-second service cycle therefore has insufficient headroom against a 30-second lifetime. The safe operational recommendation is a 5–10-second cycle where feasible, immediate recapture after a mutation, then promotion only after a newer authenticated INDEX and a later block. Repeated calls before that source seal give no freshness gain. Scheduling must use the accepted observation timestamp, not the transaction receipt time. This audit does not relax freshness or promise continuous MARK through arbitrary source outages or book churn.

## Other reviewed application boundaries

- Current and archived markets resolve owner builders through their own verified manifest and vault. Custody balances are read from each engine's bound assets. Archived terminals enforce reduction-only exposure in the UI and delegated API.
- Wallet sequences bind owner, connector, chain and login-session version, recheck asynchronous boundaries, preserve submitted transaction hashes and prevent dependent calls after wallet changes. Finality checks verify canonical receipts and exact owner/destination/calldata/value before continuing.
- Privy delegated execution verifies embedded-wallet ownership, exact signer policy and grant, preview identity/age, pinned simulation, gas bounds and durable request identity. Uncertain submissions block blind resubmission. Protection rules atomically move from active to sending and submit bounded reduce-only IOC actions.
- Leverage sizing uses bigint quantities, the adverse fill/mark difference and directional notional. Contract preview remains authoritative for fees, margin, reserve coverage and actual size. The 1–5× controls express requested sizing, not guaranteed leverage admission.
- Charts distinguish authenticated instantaneous source observations from the execution INDEX, retain invalid/stale gaps, and do not label reconstructed history as historical MARK. Book levels represent gross resting quantity, not guaranteed executable depth. Indexed display history remains bounded; it is not a complete archival indexer.
- Sports adapters bind provider endpoint, event, participants, competition, season, scheduled time and scope. Nonfinal, ambiguous or changed source data fails closed. F1 companion lookup is bound to the listed race/provider. Regression fixtures do not constitute a live future-event resolution.
- Pricefeed signatures bind chain, engine, market, source and rules; buffered reconnect generations and durable signer/relay journals preserve capture identity and avoid replacing signed evidence. Market operations save signed bytes before broadcast and reconcile exact canonical finalized receipts.
- Runtime scripts distinguish local fixture evidence, fork rehearsals, independently owned public test traders, and actual public receipts. The harness's source-fingerprint checks prevent silently reusing an old proof for changed sources. Audit agents did not run public transaction campaigns.

## Verification and remaining boundaries

| Check performed during this audit | Result |
| --- | --- |
| Concrete contract sampler, Foundry 1.8.3 | 36 passed |
| Concrete sampler full-history/64-account gas | 2 passed; max promotion 5,878,672 gas |
| Frontend unit suite after retry repair | 58 passed |
| Frontend integration suite after retry/history repair | 28 passed |
| Frontend TypeScript | Passed |
| Oracle non-fork units before final two streaming regressions | 434 passed across 36 files |
| Final watchdog suite including streaming regressions | 46 passed |
| Pricefeed collector/buffer/worker scope | 25 passed; build passed |
| Indexer GraphQL schema validation | 12 passed |
| Watchdog and oracle SDK TypeScript | Passed |
| Runtime sampler coordination | 3 passed |
| Follow-up bounded coordination and canonical capture tests | 16 passed (includes original coordination tests) |
| Bootstrap rollover readiness helper | 10 passed; combined wrapper suite 26 passed |
| Keeper gas ceiling and actual Operations behavior | 7 passed; 49 assertions |
| Exact canonical deployment receipts | 9 passed; 46 assertions |
| Oracle E2E package after receipt repair | 39 passed; 215 assertions; TypeScript passed |
| Private replacement orchestration fixtures | 27 passed; four module syntax checks passed |
| Source qualification helper | 7 passed; runner/helper syntax passed |
| Follow-up malformed history/chart scope | 10 passed |
| Follow-up Linux pricefeed deployment/load harness | 20 passed; 3 additional isolated orphan repetitions passed |
| Python harness | 88 passed; 5 Windows-only skips (93 total) |
| Whitespace/conflict-marker diff check | Passed |

The oracle agent's first aggregate invocation accidentally included local-fork tests and PATH's incompatible Forge ABI inspection. It was stopped and replaced with explicit non-fork unit selection. That initial invocation is not passing evidence. The Python ownership failures above are also retained as before-fix evidence, rather than omitted from the audit record.

The deployment owner subsequently reported the complete final risk-contract CI run passing 849 tests with zero failures. This separately reported aggregate does not establish live v4 readiness.

The deployment owner separately repaired the oracle CI package job after confirming that its integration-only Forge build omitted UMA Finder/Store artifacts used by package deployment tests. `.github/workflows/oracle.yml` now builds `test/uma/UmaImports.sol` under the default profile with the London target before those tests. The owner reported an isolated 31-file Solc 0.8.16 build and passing E2E package checks. This is separately attributed validation, not an additional audit-agent test run; the independent build does not change the Eros Prague contract artifacts.

The owner's full Linux pricefeed run initially passed 464 of 466 tests. Follow-up changes are confined to `packages/pricefeed/test/deployment.test.ts`, `load.test.ts` and `load-fixture.ts`. The load test now permits the intentionally parallel independent reads while directly checking serialized transaction preparation/broadcast and unique ordered nonces 0–49. The orphan fixture replaces a fixed sleep with an asynchronous source gate and actual supervisor-exit synchronization, checks inherited locking and an unchanged writer fence, then requires resumed persisted collection and graceful lease release. The original intermittent ESRCH was reproduced, but its exact process-exit cause was not established; this is classified as a test synchronization repair, not a proven runtime supervisor defect. The final focused run in `node:24.21.0-bookworm-slim` passed 20/20, with three isolated orphan repetitions also passing. The deployment operator subsequently reported the full Linux run passing 466/466 (`tmp/live-markets-v3-20261007/pricefeed-linux-final.log`); that aggregate result is separately attributed.

No new full live deployment, public future-event settlement, production CRE execution, funded interactive Privy session, configured hosted delegated signer, or matching hosted indexer was completed by these audit agents. Deployment owner reports and subsequent E2E checks must supply those facts independently. Service/source fixes require rebuilt artifacts and process restart before they affect live behavior; this review did not perform those operational mutations.

The deployment owner subsequently measured authentic 30–43-second vendor timestamp gaps in both political books and 45–66-second gaps in alternative football books. These exceed the unchanged 30-second carry and independently prevent continuous pricing during those intervals. PA-11 removes false invalidation under equivalent capture economics; it does not repair a missing fresh source. Any replacement event requires explicit operator selection and finite source qualification before preparing deployment plans. A quiet probe or passing replay cannot guarantee future provider uptime.

External source truth, provider availability, RPC/indexer canonicality, operator funding/keys, empirical risk calibration and configured oracle trust sets remain dependencies. Indexer pagination assumes that completed rows within the reported progress interval are stable; this audit did not prove reorg handling for every hosted indexer implementation. Windows-specific process containment requires Windows execution. Existing future-poisoned journals need explicit documented recovery. No finding is resolved by resetting state, inventing source prices, force-settling a future event, or claiming that a passing mock proves a live integration.

## Source cadence and publisher latency follow-up

This is an operational follow-up to PA-09, not a seventeenth finding. Read-only inspection of the policy and awake qualification journals found no timestamp-unit conversion or depth-validation defect. Four failed probes exhausted the five-second delivery reserve at approximately 25.1–25.7 seconds of carried source age while their books remained valid and monotone. Because qualification stopped there, those records alone do not establish a 30-second source expiry. The ECB candidate began with a genuinely old, 59.506-second source timestamp.

Nebraska independent candidate 634893 passed its finite qualification with 893 valid polls and seven rejected future polls. Its two tightest authentic arrivals left only 5.002 and 5.979 seconds until the previous source's nominal 30-second endpoint; those new observations arrived only 47 and 33 milliseconds after generation. Vendor cadence dominated these intervals. Inclusive integer-second block timestamps determine actual chain expiry. The passing qualification therefore establishes source eligibility, not delivery or MARK continuity. Polymarket documents a per-outcome order-book snapshot timestamp and market change streams, without a periodic freshness guarantee ([order books](https://docs.polymarket.com/market-data/prices-order-books), [real-time data](https://docs.polymarket.com/market-data/realtime-data)). HTTP receipt time and stream heartbeats are not substitutes for authenticated source time.

The v3 journals separate three different delays. Packet `publishedAt` to receipt-block inclusion was a median five seconds on both markets: Senate 240 packets, range 4–8 seconds, p90 six; Republic 208 packets, range 4–7 seconds, p90 five. Inclusion to FINALIZED callback added approximately 2.8 seconds median. Matched FINALIZED callback to sampling acknowledgement added approximately 5.3 seconds median. These are historical, quantized journal measurements across restarts, not new canonical RPC replays. Appended operations logs contain 128 Senate and 116 Republic finalized samples; smaller shutdown counters described only the last process. Depth and unfunded-keeper waits also contributed to unavailable sampling. The sanitized timing artifact records populations and limitations.

Two bounded changes reduce avoidable delay:

- Explicitly buffered pipeline workers retain their initial lifecycle check, but recurring consumption avoids a duplicate pre-poll preflight. Receipt reconciliation and a fresh process lifecycle check still precede allocation and signing, including quarantined-source paths. Cached terminal STOPPED state ends scheduling. Bootstrap or stream resync can coalesce a provider read; this change does not promise that an independent collector performs no reads after an as-yet unseen deadline.
- After existing-hash reconciliation, relay identity and gas simulation reads now overlap and settle before their results are evaluated in identity, listing, source-sequence, freshness and simulation order. Exact original-hash recovery remains authoritative. No nonce reservation, transaction signature or broadcast occurs before successful checks. Selected-gas verification and every subsequent lease, freshness and lifecycle guard remain. Freshness evaluated after both reads settle can take precedence over a simulation error when that read itself exhausts headroom; this deliberately fails closed.

Three new scheduler regressions fail against the prior scheduling behavior and pass with the fix; focused pipeline/service/lifecycle/buffer tests passed 38/38. Five new relay regressions likewise fail before the change and pass afterward; focused relay tests passed 23/23. The combined isolated Linux Node 24.21.0 suite passed **474/474, zero failures or skips**. Counts overlap and must not be added. The first full attempt lacked Python in the disposable image and is retained as an environment-failed run. The successful environment included Python and procps. No oracle compiler output or Solidity source changed.

The live workspace JavaScript is rebuilt from the final source, with source and output hashes in the latency verification artifact. These pricefeed source/output files are included in the integration harness fingerprint, so the preceding backend proof remains historical; a matching proof must be rerun after the new freeze. This follow-up has not measured the optimization's live latency benefit. Live validation must independently establish INDEX inclusion before prior accepted source expiry, pending-capture promotion within 30 seconds, and continuous accepted PERP/BASIS coverage. No scheduling optimization can guarantee continuity through a missing authentic source, arbitrary RPC stalls or book churn. All prior failure logs and journals remain intact; no public transaction or process restart was performed by these audit agents.
