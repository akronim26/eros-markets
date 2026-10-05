# Integrated backend handoff v1

This work connects the pricefeed, oracle, order book, risk engine and collateral
vault on `integration/risk`. The completed frontend from `origin/feat/pricefeed`
is merged at `5aa1202`. The user's final scope is backend flow validation;
frontend wiring/testing and public deployment belong to the frontend team.
Validation uses owned local chains and previously completed read-only public RPC
inspection. It does not deploy or change the existing public contracts. Start with
the [frontend-team handoff](FRONTEND_TEAM_HANDOFF.md) for the remaining connection
work, deployment inputs, operator policies and UI requirements.

The implementation starts from `dbab6128904dcd990ce5ef38b5a5274d29fa8a99`.
Final evidence must identify the exact source fingerprints and run directories;
an earlier passing report does not certify later changes.

## Current verification status

The connected deterministic lifecycle passed in
`tmp/local-leverage-20261005-212720`: 148 canonical transaction receipts,
independent owner SDK transactions, matched 5x positions, bounded oracle/keeper
settlement and full owner payouts. At NO settlement the reserve absorbed the
losing account's approximately 40-token deficit; winner entitlements were paid
in full. This proof used the three-call rollover operator and predates the
optional `RolloverBatcher` deployment.

The final existing oracle suite passed 342/342 tests, including 10,000 runs per
fuzz campaign and 256 invariant runs with depth 128. Risk/book default suites
passed 832/832 on both Prague and MonadTen. Eight new bounded rollover helper
tests passed on MonadTen. The extended risk/book CI run was stopped after the
user reduced the scope to hackathon-critical checks; it is recorded as cancelled,
not passed. Its empty output contains no completed test result. The prior default
suites remain the evidence for those contracts, with affected checks required
for any subsequent changes.

The merged display-only MarginLens adds two passing contract tests. A separate
canonical RPC campaign exercised 1,024 funded owners through two 16-page helper
transactions: 22,370,406 and 22,221,239 gas used, finalized completion in 17.275
seconds. Its broad wrapper detected concurrently changed, unused Python files;
the committed report preserves that failed wrapper result separately from the
successful canonical operator campaign and its unchanged execution inputs.

The authentic-source leveraged proof is still incomplete. The latest retired
run reached genuine pricing windows but did not demonstrate normal pricing,
5/5 leverage ceilings and a matched leveraged fill. Its five journals and
independent partial replay remain diagnostic evidence only. Read-only clock
measurements found the Windows host about 4.18 seconds ahead of external time;
that run was stopped without altering chain or source timestamps. The user has
since synchronized the host; a new clock preflight and genuine 120-second source
probe passed. The next run must use the merged, frozen backend inputs. Locally
validated readiness is not yet claimed for the complete
requested plan. No public transaction has been sent.

## What runs together

1. Governance authorizes the current `MarketFactory`. Its two immutable code
   stores reconstruct the constructor-bound `RegistryBookRiskEngine`; the factory
   also creates the shared `CollateralVault`. Registry listing registers the
   engine with that vault atomically.
2. A reserve owner funds the market, governance stages a risk profile, and the
   market activates. Leverage starts only after valid calibration, eligible epoch
   opening, sufficient reserves and all independent price windows permit it.
3. The collector archives external source books. The builder, signer and relay
   preserve their separate journals and deliver authenticated INDEX observations
   to the exact enrolled engine. Sampling captures executable owner-funded book
   depth and waits for a strictly later INDEX timestamp before promotion.
4. Owners approve/deposit collateral, allocate it, and place or cancel orders.
   Each admission uses the engine's current preview, margin and outcome-coverage
   checks. The SDK builds calls for the actual owner; operators do not place
   orders on behalf of arbitrary traders.
5. Operators sample prices, monitor event conditions, roll accounting epochs in
   bounded pages, and attempt eligible liquidation. Market makers remain separate
   owners and must maintain usable quotes after rollover or repricing.
   The optional stateless `RolloverBatcher` composes existing engine calls;
   operators verify its deployed code hash and select a bounded page count from
   current gas estimates. It cannot bypass the engine's pricing or accounting
   rules. Its fresh deployment and tests must be recorded separately from older
   proofs that used the individual rollover calls.
6. Oracle finality starts bounded settlement preparation. The keeper completes
   it before claims become enabled. Owners claim their full payout directly;
   bad debt consumes prefunded reserve capital under the existing coverage rules.

The read API serves coherent block-pinned states and raw paginated events. It
does not sign transactions. The frontend supplies its wallet client and checks
the manifest's chain, contract identities, availability flags and owner before
simulation/signing. See the versioned
[frontend interface](../../oracle/packages/oracle-sdk/FRONTEND_HANDOFF.md) and
[SDK examples](../../oracle/packages/oracle-sdk/README.md).

## Reproduce the local proofs

Install the pinned dependencies described in
[LEVERAGE_INTEGRATION.md](LEVERAGE_INTEGRATION.md#local-scenario): Foundry 1.8.3,
Solidity 0.8.30, Bun 1.3.13, Node 24.21.0 and Python 3.12+. The legacy UMA tests
also require Solidity 0.8.16. Build the pricefeed package before running a proof.
Use one Forge build/deployment process at a time: its output and broadcast
directories are shared.

```powershell
# Controlled source, full local oracle/keeper/owner lifecycle and SDK wallet.
python scripts/integration/local-stack.py run --scenario leveraged --rpc-port 18556 --read-port 8797 --keep-running
python scripts/integration/probe-local-api.py --scenario leveraged
python scripts/integration/local-stack.py stop --scenario leveraged

# Complete the same proof through leveraged NO settlement and full owner payouts.
python scripts/integration/local-stack.py run --scenario leveraged --settle-leveraged --rpc-port 18556 --read-port 8797

# External source, authentic vendor times and wall-clock mining.
python scripts/integration/local-stack.py run --scenario leveraged --source polymarket --rpc-port 18566 --read-port 8807 --max-duration-seconds 7200
python scripts/integration/local-stack.py status --scenario leveraged --source polymarket
```

The external-source command first discovers and probes a suitable binary market
for 120 seconds, then revalidates its pinned source identity, YES outcome, rules
and future deadline before deployment. `--source-config tmp/source.json` reuses
a prepared source dossier but still requires fresh source and identity validation. Source discovery can
fail because vendor books are stale, do not advance, lack depth, or have an
unsuitable deadline. It never silently substitutes synthetic prices.

Before source qualification, the publisher checks host time against three
bounded-latency HTTPS source-clock samples and checks the public Monad testnet
chain identity and latest block time. Clock uncertainty, stale responses,
backward time movement or unavailable checks fail closed. Synchronize the host
through the operating system before starting a new run if this gate fails;
never change an active chain's clock or rewrite an observation timestamp.

The 7,200-second limit starts at the engine's activation block, not process
startup or restart. The driver leaves timestamps authentic, maintains separate
maker and trading accounts, and rebuilds price windows after book changes. It
requires actual INDEX300, PERP60, BASIS900, normal pricing, an active profile and
5/5 ceilings, then derives owner collateral from live previews. It checks the
mined matched leveraged positions, outcome coverage and a subsequent valid book
sample. A stable external source and an eligible accounting epoch are necessary;
the full allowance can be needed even when individual transactions are fast.

The external-source proof closes its journals for replay/auditing and stops its
owned services at completion. It rejects `--keep-running`. Use the controlled
scenario for a persistent frontend development stack. `--keep-failed` retains an
owned local chain for debugging, while failed reports and source journals remain
on disk regardless. Use `stop --directory <run>` to stop only the recorded
process identities. Never delete/reset a journal to turn a failed run into a pass.
Actor journals reconcile exact signed pending transactions and canonical
receipts; they do not provide automatic workflow resume. Interrupted funding
(`LIVE_ACTOR_PARTIAL_SETUP_REQUIRES_REVIEW`) or a mined fill whose trade summary
was not saved (`LIVE_PARTIAL_TRADE_REQUIRES_REVIEW`) needs receipt/state review.
Review a stale exclusive lock before reuse. The orchestrator stops a failed
actor's owned stack and has no automatic actor-only resume path.

`--settle-leveraged` is a separate controlled proof and cannot be combined with
`--keep-running` or the real-source mode. It first validates the active trading
API, then resolves the leveraged demo to NO through the mock venue and real
oracle/keeper. Each owner signs its own nonzero claim. The independent audit
derives full entitlements, actual bad debt, premium effects and rounding dust
from frozen accounts, and reconciles wallet balances and remaining reserve
custody. `snapshot-final.json` preserves the open leveraged positions;
`snapshot-claimable.json` and `snapshot-settled.json` record closure.

Each run uses a new ignored `tmp/` directory. The pointers are deliberately
separate: `local-leverage-latest.json`, `local-live-leverage-latest.json`, and the
historical `local-integration-latest.json`. The API probe accepts `--runtime`
to select an exact run. Runtime manifests may contain local service URLs;
the versioned public manifest strips RPC endpoints and credentials.

`launch-source-hashes.json` records the input Solidity, service/SDK source,
compiled publisher JavaScript, dependency lockfiles and runner scripts. Before
declaring a pass, the runner writes `source-integrity.json` and rejects changed,
added or removed inputs. Command records include arguments, working directory,
elapsed time and failures, including startup and timeout failures. The API probe
archives `public-manifest.json` only after matching its chain and market
identities to the verified API snapshot. The real-source run also saves the
independent rational-price replay as `independent-pricefeed-review.json`.

## Evidence and deployment boundary

The controlled proof includes independently owned SDK approval, deposit,
allocation, order placement/cancellation, release, withdrawal and claim
transactions. The oracle suites separately cover YES, NO, INVALID, disputes,
rejection, void, replay protection, exclusive groups and multi-page preparation
against real integrated engines. Paid model/provider calls and external
adjudication remain explicit mocks in these tests.

The external-source proof records five pricefeed journals, raw source bodies,
signed observations, canonical receipt hashes, funding/order receipts, coherent
account states and the API probe. A separate Python replay uses integer/rational
arithmetic to recompute prices from the archived source, and a separate onchain
auditor checks actual owner calldata, positions, balances and coverage. A partial
archive or failed run is useful diagnostic evidence, not a completed proof.

Both local scenarios still use mintable test collateral and synthetic test risk
calibration. Real Polymarket INDEX publication does not provide empirical risk
calibration, reserve capital, oracle adjudication or control of governance keys.

The [deployment runbook](DEPLOYMENT_RUNBOOK.md) provides the integrated read-only
preflight, exact unsigned calls and disposable local/pinned-fork rehearsal.
The verified historical public registry still uses a stub factory. A local fork
can impersonate role owners and fund native gas for simulation; that does not
establish actual signer custody. Public deployment, operator enrollment,
reviewed listing/calibration, funded wallets/reserves and continuous service
hosting remain explicit external prerequisites. New public addresses must be
exported only after actual deployment receipts and bindings are verified.

Older 1x reports remain dated historical references. Fresh leveraged proofs
replace their leverage-sensitive evidence; unchanged arithmetic and custody
regressions remain part of the complete automated suites. No historical gate
acceptance or production approval is rewritten by this handoff.
