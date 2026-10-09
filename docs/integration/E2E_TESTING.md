# Complete-flow E2E testing

## What this tests

The local command runs real factory-deployed contracts, continuous price publication,
book sampling and epoch maintenance, then drives the actual frontend through Playwright.
It uses synthetic source data and a scripted local resolution venue. It does not use
the root deployment key, send public transactions, or certify real Privy by substituting
a fake login.

| Layer | Evidence |
| --- | --- |
| Frontend logic | Typecheck, unit tests, integration tests |
| Leveraged backend | Existing full local lifecycle, required observation windows, 5× admission, reserve loss, oracle finality, bounded preparation, owner claims, receipt/source audit |
| Browser ownership | Connect, reject a signature, switch accounts during funding, block wrong-network writes |
| Browser custody | Faucet, validation, approve → deposit → allocate, release → withdraw |
| Browser trading | Integer 1×–5× sizing, actual 5× fill and close, resting order, cancel, cancel all, IOC fill, reduce-only close, two independent browser owners trading |
| Browser recovery | RPC outage blocks writes and recovers; restricted browser storage, search, navigation, themes, all terminal tabs and 320/768/1024/1440-pixel layouts |
| Browser settlement | No early claim, scripted oracle finality, preparation, exact owner claim, withdrawal, no duplicate claim |
| Real Privy | Separate headed login checkpoint; requires a person |
| Public services/history | Separate public gate; local fixture success is not a hosting/indexer check |

## Run locally

Install the pinned tools/dependencies from [LEVERAGE_INTEGRATION.md](LEVERAGE_INTEGRATION.md).
Use Node 22+ for the frontend and the locally pinned Node 24 binary for the pricefeed,
as the backend runner specifies. From the repository root:

```sh
cd frontend
npm ci
npx playwright install chromium
npm run test:e2e
```

`LOCAL_FORGE` and `LOCAL_ANVIL` may point at the pinned Foundry 1.8.3 binaries.
The runner requires free loopback ports 18566, 18567, 8798 and 3111 by default.
Override with `--rpc-port`, `--read-port`, `--web-port` after `npm run test:e2e --`.
The complete backend proof deliberately fills real observation windows and takes
substantially longer than the browser actions. It is not part of every push's CI.

Every run writes a new `tmp/e2e-<UTC timestamp>/` directory containing a progress
`report.json`, individual stage logs, the Playwright HTML/JSON reports, and failure
traces/screenshots. Browser retries are disabled so failed transactions cannot be
silently resubmitted. A failed assertion fails the whole command. Cleanup stops only
the owned processes; `--keep-ui` preserves a failed fixture for diagnosis.

The browser uses a leveraged fixture by default. `--browser-scenario fully-backed`
selects the older 1× control scenario and explicitly skips the browser 5× proof.
The separate leveraged backend settlement proof still runs in either mode.

For development, `--proof-directory tmp/<passed-leveraged-run>` reuses a settled
proof only when its backend source fingerprints still match. `--ui-directory`
requires a fresh, passed, still-running fixture matching `--browser-scenario`; a test consumes it.
Do not reuse a fixture after trading or settlement. Restart from a fresh stack.

## Isolation

The public frontend continues to select its committed testnet manifest and Privy.
Only an explicit server-side `EROS_E2E_MANIFEST` selects the test modules. That path
must be under ignored `tmp/`, with a verified chain-31337 public manifest and a
credential-free `http://127.0.0.1` RPC. Test builds use `.next-e2e/`, have a visible
fixture banner, and clear public indexer/Privy configuration.

The browser's EIP-1193 bridge has no private key. The Node test process uses only the
public Anvil mnemonic, checks the chain and canonical deployment anchor, and permits
zero-value calls to the selected engine, vault and test token. Accounts 16 and 17
exercise the lifecycle; fresh accounts 20 and 21 exercise leveraged trading without
reusing the backend SDK owner. These accounts receive disposable local gas.
The leveraged scenario requires zero initial token, vault and market balances before
funding through the browser faucet. Fixture clock alignment keeps normal frontend stale-head
checks enabled despite the backend's explicit controlled-time advances.

## Real wallet checkpoint

Run the normal public frontend separately at `http://localhost:3100`, without any
`EROS_E2E_*` variables. Then, from `frontend/`:

```sh
node e2e/live-login.mjs
```

For a dedicated existing debugging browser, set `EROS_LIVE_CDP` to its loopback CDP
URL. Complete email/Google login inside that browser to test a real embedded wallet.
An external-wallet run requires the user's browser extension or WalletConnect approval.
Do not paste OTPs, passwords, wallet keys or access tokens into test files or chat.
The report stays `human-login-pending` unless the frontend exposes a selected address.
Login alone never marks transaction tests passed.

## Public completion gates

Local success leaves these gates explicit in the report:

1. Real embedded and external wallet login, chain selection and owner-confirmed writes.
2. Gas funding of those selected wallets, mint/fund/trade/cancel/close/withdraw receipts.
3. Continuous public publisher, book sampler, epoch/keeper services with durable journals;
   sufficient fresh observations for the live directional leverage caps.
4. An indexer bound to the same chain and deployment, with history checked against receipts.
5. Resolution of an eligible real event, followed by preparation and claims. The ongoing
   Polymarket event cannot be truthfully reported as already settled.
6. Separate configured policies and credentials for optional delegated trading/protection,
   if those features are included in the demo.

No credential or policy is implied by a public Privy App ID or an Envio API token.
The local test report and the real-wallet report preserve their separate boundaries.

## Local public-price campaign

For persistent startup, RPC failover checks, hourly prewarming and recovery, use
the [testnet operating runbook](TESTNET_OPERATIONS.md).

`scripts/e2e/pricefeed-watch.mjs` resumes the existing publication journals for a
bounded run. Pair it with `market-services.ts` using the same ignored
`EROS_PRICE_COORDINATION_DIR`. The publisher waits for the exact book-capture
acknowledgement, then requires a newer authentic source timestamp. A stopped
sampler or bounded acknowledgement timeout does not stop independent INDEX
publication; it leaves the last acknowledged timestamp unchanged. The engine
still rejects captures invalidated by a changed index checkpoint. The publisher
never substitutes the local clock for the
Polymarket timestamp. Fixture makers must keep the book funded and re-quote after
each epoch.

If the local DNS resolver returns an unreachable address for the Polymarket API,
the publisher supports explicit `EROS_SOURCE_DNS_SERVERS=1.1.1.1,1.0.0.1`. This
changes DNS lookup only for the two public Polymarket read hosts in that process.
It preserves HTTPS certificate verification, caches within the returned DNS TTL,
and does not change the laptop's DNS, RPC routing, wallets, or source identity.

Keep RPC URLs in ignored private configuration. `MONAD_READ_FALLBACK_URLS` accepts
up to seven comma-separated HTTPS alternatives to the primary. Public state and
confirmation reads use a shared routing implementation across the publisher,
market operations, makers and frontend. Providers must report chain 10143, a
recent finalized head and matching explicit-height block hashes; failing or
throttled endpoints enter a bounded cooldown. Pinned snapshots keep block affinity
and verify the original hash before failover. Identical concurrent reads coalesce;
JSON-RPC batching remains enabled with individual-read fallback when unsupported.
`MONAD_READ_RPC_CAPACITIES` optionally lists concurrent request limits for the
primary followed by each unique alternative (default eight per endpoint). These
limits are per process, not a global provider quota. Give frontend traffic its own
budget using `MONAD_FRONTEND_READ_FALLBACK_URLS` and
`MONAD_FRONTEND_READ_RPC_CAPACITIES`. Pending nonce, balance checks for signing,
simulation and broadcasts remain on the selected primary writer endpoint.
Never erase a journal to restart a failed campaign or treat a missing receipt as
a reverted transaction. This routing cannot repair stale Polymarket timestamps.

Fund each publisher and keeper address separately; funding the deployment wallet
does not replenish those accounts. The publisher refuses to reserve a transaction
when its balance is below the policy's maximum transaction cost. The campaign
wrapper waits for funding in that case and resumes the same journals. A pause can
invalidate the index's full five-minute window, even after new observations resume.
Keepers also wait at their gas floor, acknowledging that sampling is unavailable,
rather than terminating the publisher with them. `EROS_SERVICE_DURATION_SECONDS`
sets a bounded keeper/maker run (60–86400 seconds); the publisher has its own
duration argument and cumulative audited transaction/cost budget. Duration alone
does not extend that budget. Use `plan-monad-budget` and `apply-monad-budget` with
idle, reconciled journals and a funded sender to renew it; never edit the journal
profile directly. Budget snapshots stream archive rows and preserve the original
canonical hash, including archives too large for one JavaScript string.

For supervised operation, `EROS_SERVICE_MODE=persistent` removes only the worker
wall-clock deadline. Bounded mode remains the default. Publisher sessions rotate
after at most one day while retaining the same journals and cumulative policy;
transaction-budget exhaustion exits with code 78 for operator review. A persistent
process does not replenish gas, extend a cost budget or authorize journal resets.

The combined market worker schedules the existing liquidation planner before a
due sample at most once per `EROS_LIQUIDATION_INTERVAL_MS` (default 10,000). It uses
the same serialized sender and outbox as rollover and sampling. A measured
`gas.liquidate` is required; `EROS_LIQUIDATION_ENABLED=true` refuses startup without
it, while `false` explicitly disables scanning. Every productive liquidation
also receives a fresh primary-RPC gas estimate before signing. Its 25% margin
plus 10,000 must fit both the configured liquidation and keeper ceilings. This
does not establish a public liquidation proof when all current accounts are healthy.

The maker retains a locked, fsynced journal and resolves historical placement
receipts to exact owned order IDs. Replenishment/repricing uses an atomic targeted
cancel-and-place batch, never owner-wide cancellation. Defaults are 2,000,000 quote
lots, a 4,000,000-lot directional position limit, 12 actions per owner per epoch,
a 30-second requote cooldown and a five-tick repricing threshold. These are bounded
operator policies, not promises of permanent depth. Optional maintenance waits for
a newer accepted book observation, with a 15-second maximum deferral; empty or
insufficient liquidity can be repaired immediately. Contract capture invalidation
and freshness checks still apply. Unknown owner orders, depleted exposure capacity
or exhausted per-epoch action limits leave an explicit waiting state.

Normal pricing requires a valid 300-second index, 60-second book window, 900-second
basis window and a completed epoch opening. Epochs end on the hour. Read the actual
directional caps; a deployment ceiling of 5x does not imply immediate 5x admission.
The demo listing capacity helper reserves ten times the sampling depth as its OI
cap. Equal OI cap and sampling depth disable sampling after the first positive OI;
that immutable listing setting requires a replacement market.

`scripts/e2e/live-trader.ts` records a separate generated test owner and rehearses
each gas/funding/buy/close/release/withdraw plan before public execution. It checks
canonical receipts, exact fills, balances and positions. Release also waits for a
fresh index and sufficient `usableReleaseAtoms`. A successful receipt without the
expected fill fails the proof. These SDK-owned tests remain separate from the
human-approved Privy wallet checks.

`scripts/e2e/leveraged-trader.ts <private-market-directory> prepare|rehearse|broadcast
open|close` uses that same independent owner for a bounded 5x test. Set
`EROS_LEVERAGE_SIDE=buy` or `sell`. It uses the frontend sizing function, verifies
every integer leverage preview at a canonical block, requires the exact full size
to be admitted, rehearses on the disposable loopback fork, then verifies the real
fill, resulting leverage and return to zero position. The test requires a valid
normal mark; it does not bypass a bootstrap or stale-price limit. Each side and
phase has separate immutable plans and retained journals.
