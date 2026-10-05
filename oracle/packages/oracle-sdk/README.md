# Oracle SDK validation

Run `bun test` from this package with the project's pinned Forge on `PATH`.
The ABI checks compare compiler output, checked-in JSON snapshots, generated
TypeScript modules and `oracle/abi/SHA256SUMS`. Run `bun run sync-abis` only when
intentionally refreshing snapshots after reviewing a source/ABI change.

ABI fingerprints use UTF-8 text with CRLF line endings converted to LF, matching
the generated and Git-stored files. This permits Windows checkouts without
rewriting snapshots. No other whitespace, property ordering or ABI fields are
normalized; substantive changes and extra/missing newlines still change the
fingerprint. `test/abiText.test.ts` verifies both portability and drift rejection.
Filesystem fixtures use file-URL conversion rather than URL pathnames, which
preserves Windows drive letters and paths containing spaces.

The ordinary deployment loader still requires the full oracle deployment
schema, including UMA metadata. The keeper's explicitly selected chain-31337
local integration mode has a separate mock-venue manifest schema; it does not
relax this SDK loader or pretend a mock is a deployed UMA adapter.

## Trading and frontend interface

The [version 1 frontend handoff](FRONTEND_HANDOFF.md) defines exact units,
lifecycle states, claim readiness, failure handling and event pagination.

Import `@eros-oracle/oracle-sdk/browser` for browser code. It exports the real
`RegistryBookRiskEngineAbi`, `MarketFactoryAbi` and `CollateralVaultAbi`, public
manifest validation and `createTraderClient`. The default package entry also
contains filesystem-based deployment loading and is intended for services.

`GET /manifest` from the read service returns `manifestVersion: 1`, chain and
deployment identities, source/provenance labels and verified block metadata. It
omits RPC URLs and transport credentials. Treat the server's configured manifest
as a trusted deployment allowlist; a hash advertised by an arbitrary server is
not independent source verification. The service verifies runtime and
registry/listing/vault bindings and returns reads from one canonical block.
`GET /snapshot?owner=0x...` accepts up to 16 repeated `owner` parameters and works
for wallets absent from the fixture accounts. Unregistered owners have null risk,
and unavailable prices remain null. `/events?fromBlock=N` returns at most 5,000
blocks with a continuation cursor. It is activity history, not an event-only
custody ledger. `/abi/engine`, `/abi/vault`, `/abi/factory`, `/abi/registry` and
`/abi/oracle` expose the same checked-in ABIs.

The read service remains bound to loopback. `READ_ALLOWED_ORIGINS` can specify a
comma-separated exact frontend-origin allowlist; defaults cover localhost ports
3000, 5173 and 8787. A private read manifest contains `rpcUrl`. Verified Monad
testnet manifests use `scope: "testnet-read-only"`, `chainId: 10143`, a factory
identity, `verifiedAt` and explicit collateral/INDEX/calibration/resolution
provenance. Local signing wrappers retain their separate chain-31337 schema and
never accept this testnet read mode. Synthetic calibration and collateral remain
fixtures even when INDEX comes from an external source.

```ts
import { createTraderClient, toPublicManifest, OrderKind } from '@eros-oracle/oracle-sdk/browser'

const manifest = toPublicManifest(await (await fetch(`${readApi}/manifest`)).json())
const trader = createTraderClient(manifest, 'demo', selectedOwner)
trader.assertWallet(await walletClient.getChainId(), selectedOwner)
// Amounts are bigint six-decimal collateral atoms; lots are 0.001 claim each.
// Submit each step separately, wait for its successful canonical receipt, then
// confirm state before proceeding. The selected owner must be the actual sender.
const approval = trader.approve(10_000_000n)
const deposit = trader.deposit(10_000_000n)
const allocation = trader.allocate(10_000_000n)
const block = await publicClient.getBlock()
const id = await publicClient.readContract({ ...trader.participantId(), blockNumber: block.number })
const order = { kind: OrderKind.LIMIT, isBuy: true, reduceOnly: false,
  tick: 500, size: 1_000n, maxFills: 8, expiryBlock: 0 }
const preview = await publicClient.readContract({ ...trader.previewOrder(id, order), blockNumber: block.number })
const simulation = await publicClient.simulateContract(trader.placeOrder(order))
// Recheck the connected owner/chain immediately before signing.
const hash = await walletClient.writeContract(simulation.request)
const receipt = await publicClient.waitForTransactionReceipt({ hash })
// Check success and canonical block hash, decode Fill/OrderPlaced, then refresh
// block-pinned account state. A submitted transaction alone is not a fill.
```

The code above illustrates request construction; approval, deposit and allocation
must actually be mined before looking up a nonzero participant or trading.
`cancel(id)`, `cancelAll()`, `release(atoms)`, `withdraw(atoms)` and `claim()` build
the remaining flows. Release returns collateral to vault free balance; withdrawal
sends it to the selected owner. Once claims are enabled, claim pays the selected
owner directly. No request builder computes its own margin, chooses leverage,
changes the beneficiary, stores a key or broadcasts. `transactionData(request)`
also provides wallet-neutral `to/data/value` together with the required account
and chain ID. The caller must enforce both identity fields with its wallet.

For disposable integration checks only, from `oracle/` run
`bun packages/oracle-sdk/scripts/local-trader-smoke.ts manifest.json prepare report.json`
after a fresh terminal INDEX is available. The helper verifies loopback chain 31337
and contract identities, uses independent actor 18, and exercises the real SDK
fund/order/cancel/release/withdraw path. It leaves one fixture token allocated
without exposure. Run the `claim` phase after terminal preparation to verify a
direct owner payout. Both reports contain actual receipts and transaction gas
limits. This helper refuses public endpoints and belongs outside frontend code.
