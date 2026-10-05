# Frontend interface v1

This interface uses `manifestVersion: 1` and the concrete factory engine ABI.
Import `@eros-oracle/oracle-sdk/browser`. Keep wallet ownership explicit and use
the source-bound manifest as the deployment allowlist. No frontend branch or
wallet-provider integration is included here.

## Data and units

All bigint JSON values are decimal strings. Parse them with `BigInt`; never use
JavaScript floating point for calldata, balance comparisons or accounting.

| Field/unit | Meaning |
| --- | --- |
| `*Atoms` | Six-decimal collateral atoms: `1000000` is one token |
| `*Q` | `10^18` Q per atom: `10^24` Q is one token; cash and equity can be signed |
| `*Lots` | `1000` lots per claim; positions are signed |
| `*Wad`, `settlementPriceE18` | Probability scaled by `10^18`; zero is a valid probability when available |
| `tick` | Integer `1..999`, each tick equals probability `0.001` |
| `*At`, `*Time`, `scheduledT` | Unix seconds, not milliseconds |
| `expiryBlock` | Block number; zero means no explicit order expiry |
| `trader` / `participantId` | Engine-local participant ID; zero means unregistered, with `risk: null` |

`block.number/hash/timestamp` binds every field in a snapshot. A successful HTTP
response is a coherent read, not a statement that leverage or claims are ready.
Use `indexAvailable` and `markAvailable` independently. Unavailable INDEX, mark and
marked equity are returned as null; never turn them into zero. `source.lastObservedAt`
and `lastSequence` show accepted source progress, but do not replace the engine's
freshness/eligibility checks. A fresh INDEX alone does not establish a valid mark.

`provenance` labels collateral, INDEX, calibration and resolution separately.
An external INDEX does not make synthetic calibration, mintable collateral or
scripted resolution real. `leverage.directionalCaps` are ceilings; admission and
account margin still come from contract previews and simulation.

## Lifecycle and payouts

These enum values come from the engine. Oracle outcome enums use a different
ordering and must never be cast into engine outcomes.

| Field | Values in numeric order starting at zero |
| --- | --- |
| `risk.stage` | TRADING, BACKING_GRACE, BACKING_FLOOR, REDUCE_ONLY, HALTED, CLAIMS_READY |
| `risk.pricingMode` | BOOTSTRAP, NORMAL_PRICING |
| `risk.accountingState` | READY, ROLLOVER_SWEEP, FLOOR_SWEEP, HALT_SWEEP |
| `settlement.phase` | LIVE, HALTED, PREPARING, READY, COMPLETE |
| `settlement.finalOutcome` | UNSET, NO, YES, INVALID |
| Contract `claimsStatus()` | AWAITING_OUTCOME, ORACLE_FINAL_PRICE_PENDING, ORACLE_FINAL_PREPARING, RECOVERY_REQUIRED, CLAIMABLE |

`risk.pendingWork` is a bitmask: 1 floor sweep, 2 rollover sweep, 4 halt sweep,
8 pending epoch opening. Show work in progress without manufacturing a zero
balance. Settlement exposes `snapshotCursor`, `payoutCursor`, `accountCount`,
`oracleFinalityAccepted`, `accountingComplete` and `claimsEnabled` separately.

After completed preparation, `totalDeficitQ` is the exact sum of negative trader
equity at the frozen final price. During an unfinished payout scan, zero is an
unavailable intermediate value; use preparation state before displaying a final
bad-debt total. `ClaimsEnabled.reserveContributionAtoms` reports whole reserve
atoms consumed after payout rounding dust, rounded down. It compares frozen
reserve equity with the final residual, so premium income or a reserve position
is not confused with original reserve seed capital. The exact deficit remains
available in Q; these reporting fields do not alter payouts.

Enable a claim only when **`claimsEnabled` is true and that owner's `claimAtoms`
is positive**. `claimAvailability(settlement, claimAtoms)` and snapshot account
`claimability` expose `CLAIMS_DISABLED`, `NO_CLAIM` or `CLAIMABLE`. Final oracle
outcome, completed accounting or a nonzero escrow balance alone do not enable
payouts. Re-simulate immediately before signing. After a successful claim, refresh
the owner token balance and claim escrow; the funds go directly to the owner.
Release instead credits vault free balance, followed by a separate withdrawal.

## Requests, failures and history

| Request/result | Client behavior |
| --- | --- |
| `GET /manifest` | Require version 1, expected chain, source and deployment identity; contains no RPC URL |
| `GET /snapshot?owner=...&owner=...` | Up to 16 owners, with addresses absent from fixture accounts supported |
| HTTP 400 `INVALID_OWNER_QUERY` / `INVALID_FROM_BLOCK` | Correct the bounded query; do not retry the same invalid input |
| HTTP 403 `ORIGIN_NOT_ALLOWED` | Configure the exact frontend origin in the read server |
| HTTP 405 `READ_ONLY` | This service never signs or submits transactions |
| HTTP 503 `READ_UNAVAILABLE` | Chain, identity, canonicality, transport or query checks failed; retain last data as stale and disable actions requiring fresh reads |
| SDK `WRONG_WALLET_CHAIN` / `WRONG_WALLET_OWNER` | Stop signing and require the expected connected wallet/network |
| Preview rejection or accepted capacity below requested size | Display contract result; do not silently claim a full fill |
| Simulation revert / failed receipt | Surface failure, refresh state, and reconcile the original hash before retrying |

Builders validate integer ranges and owner/chain identity but are not a substitute
for current contract simulation. Preserve custom revert data using the concrete
ABI. Decode actual `Fill` and `OrderPlaced` events, then read remaining order state.
Submission or a zero returned order ID does not prove a fill or universal failure.

`GET /events?fromBlock=N` returns inclusive `fromBlock`/`toBlock`, `records`, a
canonical head `block`, and `nextFromBlock`. Each page covers at most 5,000 blocks,
internally fetched in 250-block chunks, and rejects more than 10,000 records.
If a page is too dense, use a dedicated indexer; this bounded interface does not
silently truncate. Follow `nextFromBlock` until null. Deduplicate by the returned
ID (`chainId:blockHash:transactionHash:logIndex`). Persist block hashes, invalidate
or replay history after a reorg, and never count `Fill` plus accounting events as
two trades. Raw events do not provide a complete historical free-cash ledger;
current custody balances come from block-pinned contract reads.

## Local SDK evidence

The deterministic leveraged runner executes SDK preparation after terminal INDEX
publication and before fixture trading. Independent Anvil actor 18 mints 11 fixture
tokens, deposits 11, allocates 6, posts/cancels orders, releases 5, and withdraws 10.
One token remains allocated with zero position. After oracle finality and keeper
preparation, SDK claim pays that token directly to actor 18 before the original
fixture owners claim their 105/95 payouts.

`sdk-prepare.json` and `sdk-claim.json` record actual receipts and owner snapshots.
The local auditor separately verifies their canonical sender/target/calldata,
gas, nonce ordering, direct-owner Paid event and historical owner balances. SDK
receipts join the global duplicate check and are counted separately from Forge,
keeper and upkeep transactions. This evidence uses loopback chain 31337 only.

The live-source runner separately produces `live-state-audit.json`. Its read-only
auditor reads the two independent owners at the actor trade block and final
snapshot block, checks deployment/listing identity, actual positions, cash,
outcome coverage and custody, and reconciles their funding calldata with the
matched `Fill` event. A later sample receipt must contain a valid observation
captured after the fill. Publisher, sampler, actor and deployment receipt hashes
share one duplicate check. Input digests and canonical checkpoint hashes bind
the cached audit to this run; edits or replaced blocks invalidate it.

The live actor persists signed pending transactions before broadcast and can
reconcile those exact bytes and their canonical receipt. This does not make the
whole workflow automatically resumable. Interrupted funding raises
`LIVE_ACTOR_PARTIAL_SETUP_REQUIRES_REVIEW`; a fill mined before its trade summary
was saved raises `LIVE_PARTIAL_TRADE_REQUIRES_REVIEW`. The orchestrator stops a
failed actor's owned stack and has no automatic actor-only resume. Preserve the
journals, reconcile receipts and partial state, and review any stale exclusive
lock before deciding how to continue. Never erase a journal to retry a proof.

Before bootstrap rollover, the live driver requests a valid seal captured within
15 seconds of the upcoming epoch boundary. Once maker quoting and valid sampling
have succeeded, missing boundary evidence fails with
`LIVE_BOOTSTRAP_ROLLOVER_SAMPLE_UNAVAILABLE`. The protocol's 30-second observation
lifetime and activation-anchored run budget remain authoritative. Initial cold
startup can perform an accounting-only rollover while prices are still warming.

New local deployments enroll a separate permissionless `RolloverBatcher` helper.
Operator upkeep uses measured bounded batches and records the expected epoch,
work, cursor, selected pages, gas estimate, signed limit and estimation duration.
The canonical auditors verify the helper and engine runtime at each receipt block,
the exact operator calldata and the helper's actual progress event. This does not
change owner trading builders or the engine's 30-second pricing lifetime. Older
manifests retain the original begin/page/finish operator path; their earlier
receipts do not prove that the batching helper was executed.

This live-source evidence covers external INDEX delivery and local leveraged
trading. Terminal claim preparation and direct-owner payouts are covered by the
deterministic SDK proof above. These are distinct evidence files; neither run
implies public-chain deployment or production calibration.
