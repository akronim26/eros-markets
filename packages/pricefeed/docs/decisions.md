# CP-PRICE decisions and authorized scope

Updated 04 October 2026. This records the conversation's selections and the
existing risk contract; it does not convert a proposal, local implementation or
provider choice into named reviewer acceptance or production authorization.

The user explicitly authorized building the price-feed component on 2 October
2026, while forbidding edits to the risk engine, CLOB and oracle. Implementation,
tests, reference fixtures and documentation live only in `packages/pricefeed/`.
The existing `pricefeed` branch is preserved. The user performs commits; the agent
supplies reminders every ten minutes during active work and suggested messages
(updated at the user's request on 04 October 2026).
This overrides the risk-team commit/STATUS workflow for this separate workstream.
From 03 October 2026, the user requires suggested commit messages to start with
`feat:`, `test:` or `fix:`. Reminders apply during active work; commits remain manual.

This is the permitted implementation location, not a reviewer approval or a
production authorization. No risk-side fingerprints, gate records, shared STATUS,
counterpart code, existing documents or deployment configuration may be edited.

On 2 October 2026 the user additionally authorized a demo using actual Polymarket
data with a demo market. That permits the separate local-demo runner to create an
owned localhost Anvil chain, instantiate a test composition of real ingress/store,
use public test keys and submit local observations. It does not approve Q02-Q10,
an operational event mapping, deployment to an external network or changes to
risk/CLOB/oracle code. All temporary chain activity stays on chain ID 31337.

| Decision | Status | Implementation consequence |
|---|---|---|
| Q01 separate scope and location | User authorized this workstream; individual owner/reviewer names unassigned | Only this package is implemented |
| Q02 impact method/rounding/depth/fees | USER-SELECTED on 03 October 2026: before-fee VWAP, directed price rounding, validated two-sided displayed depth and floor-total lots; named counterpart review pending | Existing calculator matches pricing-v1; bind the reviewed policy through Q04 and keep other admission dependencies closed until supplied |
| Q03 source/publish timestamp meaning | Conservative handling selected on 03 October 2026; provider timestamp semantics remain OPEN | Preserve vendor time as observedAt; freeze publishedAt before signing; recheck freshness before signing/sending; retries cannot refresh timestamps. Delivery margin remains Q07; production admission remains blocked |
| Q04 canonical source-rules hash | Risk consumer IMPLEMENTED; candidate typed ABI/Keccak manifest IMPLEMENTED locally; canonical dossier/encoding approval OPEN | Follow existing listing/profile ABI conventions for the candidate; do not equate sourceHash, Listing.rulesHash and indexRulesHash or claim an approved production digest |
| Q05 quote/quantity/minimum-size normalization | Engine WAD/lot units FIXED; exact fractional aggregation, floor-total lots and source constraints SELECTED; provider quote equivalence/precision OPEN | Before-fee pricing does not approve collateral equivalence or imply arbitrary lot-sized trades meet provider precision |
| Q06 event semantics and exact initial mapping | OPEN | Three real source examples remain disabled for operational output |
| Q07 cadence/headroom/metadata age | Engine 30-second carry and full 300-second index coverage FIXED; producer budgets OPEN | Every diagnostic run declares its own settings; 30 seconds is not a production polling interval |
| Q08 invalid-packet representation/priority | Engine invalid-depth acceptance and zero coverage FIXED; local fresh zero-price/impact invalid-depth representation implemented; production policy/review OPEN | Preserve actual depths/times and failure reasons; no fabricated samples for missing/closed/stale source; closure/coalescing and operational priorities require review |
| Q09 live chain/engine/key/relay/finality | OPEN; user reports obtaining an Alchemy Monad RPC, endpoint not supplied/validated | A provider candidate does not supply a deployed engine, signing backend, finality/spend policy or transaction authority; local chain-31337 development only |
| Q10 calibration/soak/retention/release | OPEN | Read-only measurements cannot approve production parameters or release |

The eleven-field ABI and raw digest are fixed by existing `IPriceSource.sol` and
`PriceIngress.sol`; assumption I-3 still needs named counterpart confirmation.
Tests and diagnostic preparation do not accept PF-G0 or any other human gate.

## Choices made along the requirements review

These details preserve what was actually selected, why it fits the existing
contract and what remains. Q02/Q03 selections were made on 03 October 2026;
the operating/RPC explanations were recorded on 04 October 2026. Dates identify
the discussion, not a production approval or a new test campaign.

### Risk compatibility and output — existing contract, cross-checked

Use the engine's exact eleven-field Observation and
`submitObservation(obs, signature)`; no risk interface change is needed.
The output contains market/source identity, sequence, original source time,
publish time, midpoint price, impact bid/ask, both depths and the rules hash.
Prices use WAD, times Unix seconds and depths lots (one lot = 0.001 claim).
Sign the raw ABI/Keccak digest bound to all fields, chain ID and engine address;
do not use personal-message or EIP-712 signing. The engine emits acceptance
time, depth validity and payload digest itself. See [wire-contract.md](wire-contract.md).

The bot supplies authenticated observations. Risk owns TWAP, mark, margin,
funding, liquidation and INVALID-price capture/fallback; the oracle owns outcome
resolution. Neither a good signature nor an accepted packet proves the venue's
data is true or establishes full TWAP readiness. Named I-3 confirmation remains
separate from technical compatibility.

### Pricing, fees and depth — user-selected Q02/Q05 policies

- Use **VWAP at exactly the configured N**, rather than the marginal last level:
  walk bids descending and asks ascending, including a partial final level.
- **Floor impact bid, ceil impact ask, floor midpoint.** Both sides must cover N;
  valid bid/ask and maximum spread must satisfy the existing engine constraints.
- Use **quoted prices before venue fees**. Fees remain separate execution-cost
  and calibration evidence; this does not assert zero fees.
- Use **validated displayed two-sided depth from a complete outcome-token book**.
  Aggregate fractional quantities exactly, then floor each side's total claims
  multiplied by 1,000 for reported lots. Do not floor every level first or round
  depth upward. Displayed depth does not guarantee a later fill.
- Apply the source's tick, minimum-size and quantity constraints to the N-sized
  walk. Do not discard every small residual level solely because a new order
  has a minimum size. Keep constraints specific to the market.

See [impact-decision.md](impact-decision.md) for selected policy and evidence.
Actual production N/spread, quote/collateral equivalence, provider trade
precision and named counterpart review remain open; example values are fixtures.

### Source time and retries — conservative handling selected for Q03

Preserve vendor milliseconds in evidence and floor them for observedAt in Unix
seconds. Freeze publishedAt before signing; retry the identical signed packet
without changing either timestamp. Recheck age/headroom before signing and
sending; expired packets require genuinely new evidence and a new sequence.
Missing, future, backwards or expired source time prevents valid-price
publication. Receiving a response or mining a transaction never refreshes old
source time. Provider timestamp-generation semantics and the measured Q07
delivery budget still need confirmation. The engine's 30-second carry and full
300-second index coverage are fixed requirements, not approved polling settings.

### Rules hashing — candidate implementation, Q04 approval still open

The risk code already pins/checks the supplied index hash. The package candidate
uses a version-domain word plus fixed typed ABI fields and Keccak-256, following
the project's listing/profile conventions. It binds mapping and policy inputs;
arbitrary JSON formatting and abi.encodePacked are not the proposed format.
Required equality is packet.sourceRulesHash = listing.indexRulesHash =
sourceState.rulesHash. Listing.sourceHash and Listing.rulesHash remain separately
defined inputs. The implemented schema is **a proposal**, not an approved listing
dossier. See [rules-hash-proposal.md](rules-hash-proposal.md).

### Categories and event admission — shared design, mappings still open

Use one configurable service for crypto, sports and politics, with isolated
state/sequences/outboxes per engine/source and shared provider controls. Cricket
is a possible subcategory, not a separate bot or an approved market. Category
labels never establish question/outcome/deadline/exception equivalence. Each
actual listing needs Q06 review; the existing real-token examples stay disabled
for operational admission. The actual event is selected by approved IDs/rules,
not by the category name.

### Failure handling — risk facts fixed, local Q08 policy explicit

Archive failure/gap evidence and never fabricate a fresh price or source time.
Risk can accept authenticated ordered invalid-depth checkpoints with zero usable
coverage; that is not an oracle INVALID outcome. Silence and an invalid
checkpoint affect carry differently. The explicitly opted-in development builder
now emits zero price/bid/ask for fresh verified invalid depth while preserving
actual depths and original times. Valid-only development rules remain available.
Neither path approves production delivery priority, coalescing or closure policy.
Those remain Q08 decisions. See
[risk-requirements-crosscheck.md](risk-requirements-crosscheck.md).

### Lifecycle — existing risk rule, explicit development implementation

The scheduled `[T-24h,T]` history stays fixed after an early halt. Continue the
independent source recorder through the explicit requiredFeedUntil, which must
be at least T. RECORD_ONLY is a bot mode; it does not change engine enums or
resume trading/funding. Only pinned engine facts at a canonical named block can
report a halt; source closure and oracle proposals cannot substitute for them.
A closed source produces a truthful archived gap, not a manufactured final price.

The local controller persists decisions before granting output. It includes the
deadline itself and stops after a fresh verified block passes it. Stale/future
checkpoints or RPC failure block output; inconsistent pins/blocks, reorgs and
disappearing halts quarantine the worker. Signing and relay boundaries recheck
lifecycle. A signed reserved nonce blocked before broadcast is quarantined for
operator recovery, never reused or silently skipped. These are development
fail-closed choices, not approved production finality/closure/nonce policies.

Full signed 24-hour fixtures use accelerated VM time and scripted counterparts;
they verify complete/gapped/legacy/thin history and no economic resume against
real risk imports. They do not certify an actual elapsed 24-hour Polymarket soak
or authentic oracle integration. Concrete production lifecycle reads, closure
procedure and named review remain open. See [lifecycle.md](lifecycle.md).

### Operating settings, hosting and RPC — examples and candidates only

On 04 October 2026, the user withdrew the once-per-minute proposal in favor of
the continuous-service model: start one long-running bot and let its internal
scheduler poll each market independently. A supervisor should restart it after
failure or reboot. Do not repeatedly launch the continuous service from cron.
The existing 10-second example is an initial test cadence, not a selected
production interval. Q07 remains open until source age, calculation/signing,
relay/inclusion and safety margin fit within 30 seconds, and authentic valid
samples demonstrate complete 300-second coverage. Frequent polling cannot
refresh an unchanged old source timestamp. This operating-model selection does
not select a hosting provider or authorize deployment.

Example polling is 10 seconds; metadata refresh normally occurs around 50
seconds under the current 90-second metadata-age setting. A successful first or
refreshing poll uses three requests (event, market, book); a cached poll uses one.
The approximate 1.4-request average is an example workload without retries, not
a guaranteed cost or a new selected production policy. The CLI's 100-ms shared
limiter coordinates one process; IP-wide coordination, Retry-After handling and
measured load/freshness budgets remain to be completed/reviewed.

On 04 October 2026, the requested durable live-source/restart campaign measured
236/300-second crypto coverage and 294/300-second politics coverage at the
ten-second diagnostic cadence. A separate five-second politics repeat accepted
72 observations over six minutes, preserved 36 immutable packets through a
four-journal restart and passed full 300/300-second coverage. The engine TWAP
matched independent raw-book Fraction and time-segment reconstruction. All
three outcomes are retained in `artifacts/pipeline/live-review.json`. Five seconds
is **a tested diagnostic setting**, not a selected production Q07 interval.
Source age and genuine valid coverage remain authoritative; failed windows do
not become valid through repeat publication or relabeling timestamps.

No hosting provider, server capacity or production deployment was selected.
AWS/DigitalOcean were explanatory examples. An always-running service requires
its own hosting, persistent storage, monitoring and tested restart/recovery;
an Alchemy RPC does not host it. The PDF proposes SQLite for a measured
single-node pilot or PostgreSQL for multi-instance coordination. Current local
SQLite journals do not approve production capacity/retention or replicas.

The user reports obtaining an Alchemy Monad RPC through Monad Metropolis.
It is a **candidate, not a validated endpoint or deployment decision**. Polymarket
reads need no Monad RPC. Engine reads, signed transaction delivery and receipt
reconciliation need an RPC matching the actual engine's approved network.
Testnet/mainnet, deployed code/ABI/address, production signing backend, gas/spend
limits, canonical finality/reorg policy and transaction authority remain Q09.

Commit `42b4df5` includes `LocalPipeline`, a concrete loopback `localRpcTransport`
and a local demo runner; their source was inspected for this update, without a
new test run. They require disabled configs, public fixture keys and chain 31337.
These local additions supersede the earlier statement that no joined development
path or concrete local adapter existed. They do not enable an Alchemy endpoint,
resolve invalid/lifecycle policy or establish a production pipeline. Q10 still
requires calibration, soak/load evidence, retention, monitoring ownership,
independent review and release approval.

Local recovery drills now terminate processes with OS SIGKILL at thirteen journal
boundaries using scripted source/chain counterparts. Expired reserved deliveries
persist shared-account quarantine on restart or slow resimulation, preserving
packet/raw bytes and preventing new nonce allocation. Older packet/relay snapshot
checks and a development recovery runbook are present; production backup,
supervisor, transaction-signer and replacement policies remain open. See
[recovery-runbook.md](recovery-runbook.md).

A separate joined LocalPipeline.run/owned-Anvil SIGKILL campaign now verifies
five continuation paths and two expected recovery blocks across seven boundaries.
The local chain remains alive; actual lease deadlines and elapsed time govern
restart. Canonical on-chain events, immutable packet/signature/raw transaction
identity and the next nonce are checked. PREPARING/TX_SIGNED startup remains
blocked because the local transaction signer lacks an independent durable raw
transaction journal. This is fixture-source evidence, not a new real-source
campaign or production signer/backup certification.

Seven local workload cases now exercise mixed-category workers, 25-market signed
publication, provider queue pressure, RPC timeout/late completion and 100-worker
collection. An unreserved packet that expires in the shared publication queue
is durably marked EXPIRED without stopping the service; reserved deliveries keep
their quarantine/recovery rules. Timing/headroom measurements use scripted source/
RPC and declared small-book test settings. They do not approve cadence, capacity,
source timestamp semantics or buffering/coalescing/priority policy. See
[load-evidence.md](load-evidence.md).

The development runtime is pinned to Node 24.21.0 LTS, TypeScript 5.9.3 and viem
2.57.2, with a package-local lockfile. These are implementation tool choices, not
approved infrastructure capacity, storage, risk parameters or production release.
