# Eros Markets frontend: complete build guide

Written 2026-10-05 against `feat/pricefeed` @ `273bc6e` (contains `integration/risk` @ `e2b48c5`).
This is the single guide for building the Eros Markets web app on top of the existing contracts,
SDKs and indexer. It says what to build, which contract function backs every button and number,
and which rules the UI must never break. Re-verify anything marked **verify** before relying on it.

Nothing in this guide authorizes a deployment, a mainnet release, a gate acceptance or use of an
operator key. The frontend is a client of contracts that already exist; it adds no economics.

---

## 0. Read this first

### 0.1 What exists and what does not

| Piece | State today | Where |
|---|---|---|
| Order book + risk engine (`BookRiskEngine`, one contract per market) | Deployed on Monad testnet, verified, **not activated**, no collateral minted, no INDEX feed | `contracts/src/engine/BookRiskEngine.sol`, address in `addresses.md` |
| Collateral vault, reserve vault, test collateral, manual resolution authority | Deployed with the engine | `addresses.md` |
| Resolution oracle stack (ResolutionOracle, MarketRegistry, BondTreasury, UmaAdapter, KeeperRouter, Timelock) | Deployed and configured; first market listed **on a stub engine**, not on the real engine | `oracle/`, `oracle/deployments/monad-testnet.json` |
| Real factory joining oracle registry and real engine (`RegistryBookRiskEngine`) | Implemented and tested locally; **not deployed** (RF-LIVE blocked on operator access and the INDEX publisher) | `oracle/src/integration/`, `docs/integration/REAL_FACTORY_INTEGRATION.md` |
| Risk read SDK (`@eros/risk-sdk`) | Exists; read-only decoders | `packages/risk-sdk/` |
| Oracle SDK (`@eros-oracle/oracle-sdk`) | Exists; ABIs, EIP-712, bond maths, indexer GraphQL queries | `oracle/packages/oracle-sdk/` |
| Envio indexer | Exists for **oracle events only** | `oracle/indexer/` |
| Independent INDEX price publisher | **Unfinished.** A diagnostic Polymarket feed and receiver exist but are not the engine's INDEX | `packages/pricefeed/` |
| Product frontend | **Does not exist on any branch.** The committee console is a CLI | this guide |

Consequences for the frontend:

1. You can build and test every read path against the deployed testnet engine today, but its
   market shows "not activated" and "no price". You cannot trade on it until an operator activates
   it and starts a signed INDEX feed (section 13.3).
2. For trading development, run a local Anvil chain with the real contracts (section 13.1).
3. The oracle pages (resolution timeline, Disputes Live) can be built against the real deployed
   oracle and its indexer today, but no oracle market is attached to a real engine yet.
4. Keep the app multi-market and manifest-driven from day one, so the factory-created markets
   drop in without code changes when RF-LIVE lands.

### 0.2 Non-negotiable rules (every screen, every PR)

These come from the risk spec, `docs/risk/HANDOFF.md` §9, `SPONSOR_INTEGRATION_PLAN.md` §4 and the
oracle plan §9.5. Treat a violation as a bug, not a style issue.

| # | Rule | Why |
|---|---|---|
| R1 | **Exact integer units only.** `bigint` for every atom, Q, lot, tick, WAD, timestamp. No `Number` or floats for amounts, ever. Parse user input as decimal strings into bigints. | Contracts are exact; float rounding creates wrong calldata and wrong balances |
| R2 | **Contracts are authoritative.** The UI never keeps its own ledger. Balances come from views or from `AccountBalance`/`MarketBalance` events. SDK outputs are labelled estimates. | Spec: "SDKs and indexers may reproduce views but cannot maintain an alternative authoritative balance" |
| R3 | **Read one coherent block.** All values on one panel come from one pinned `blockNumber`; label them with it. | Mixed-block reads show impossible states |
| R4 | **Unavailable is not zero.** An unavailable index/mark/settlement price shows "unavailable", never `0` or `0.000`. | `markAvailable=false` with `markWad=0` is not a price of 0 |
| R5 | **Only `claimsEnabled` enables a payout button.** Oracle "Final" alone never means claimable or paid. Use `isClaimable()` from the risk SDK. | Spec §8.6, DEC-07 |
| R6 | **The connected wallet is the account.** Never send trades/deposits from a backend key on a user's behalf. No `depositFor`, no relayer. | The sender owns the account; there is no delegation path |
| R7 | **Preview, then simulate, then send.** Use `previewOrder`/`previewRelease` for the ticket and `simulateContract` before every write. Execution re-checks; previews can go stale. | Previews are valid only for their block |
| R8 | **Parse receipts; never infer from submission.** `placeOrder` can succeed with id `0` (rejected, IOC, fully filled). Fills, rejections and cancels come from logs. | Section 9.4 |
| R9 | **Explicit gas limits on Monad.** Estimate, add a small margin (10%), send that limit. Never send a huge default limit. | Monad charges the gas **limit**, not gas used |
| R10 | **No secrets in the browser.** Only public addresses, chain IDs, public RPC URLs and public app IDs in `NEXT_PUBLIC_*`. | Anything shipped to the browser is public |
| R11 | **Disclose testnet stand-ins.** Banners for: test collateral, manual resolution authority, sandbox DVM, single-node CRE simulator, uncalibrated 1x profile. | Oracle plan §9.5, §12.10 |
| R12 | **Show the worst-case lock.** Show `voidSecs` ("capital may be locked up to N days") on every market. | Oracle plan §14.2 |

---

## 1. The product in one page

Eros Markets lists **binary event perpetuals**: each market is a YES/NO question that resolves at or
after a scheduled time `T`. A **claim** pays 1 USDC if YES and 0 if NO (INVALID pays a captured
price between 0 and 1). Traders buy or sell claims on a fully on-chain limit order book. Prices are
probabilities in **ticks** 1..999 (tick 500 = 0.500 = 50%).

- **Long** (positive `positionLots`) profits if YES. **Short** (negative) profits if NO.
- Size is in **lots**: 1 lot = 0.001 claim. 1,000 lots = 1 claim.
- Collateral is a 6-decimal USDC-like token, counted in **atoms** (1 atom = 0.000001 USDC).
- Internal cash is in **Q** = 1 atom × 10^18.
- The current deployment profile is **1x, fully backed**: every position must be fully paid for in
  both outcomes. Funding, leverage, recovery and token conversion are **off**. Trading fees are 0.

Cost of a fully backed trade, in atoms (fees are zero today):

| Action | Atoms needed | Example: 100,000 lots (100 claims) at tick 500 |
|---|---|---|
| Buy `L` lots at tick `t` | `L × t` | 50,000,000 atoms = 50 USDC |
| Sell `L` lots at tick `t` | `L × (1000 − t)` | 50,000,000 atoms = 50 USDC |
| Payout per lot at YES / NO | 1,000 atoms / 0 for a long | long 100 claims receives 100 USDC at YES |

Use these only for helper text and default size suggestions. The authoritative maximum is
`previewOrder(...).acceptedCapLots` (R2, R7).

### 1.1 Market lifecycle (what the UI must reflect)

```
listed ── activateMarket() ──► TRADING ──► BACKING_GRACE (T−12h30m) ──► BACKING_FLOOR (T−12h)
                                  │                                        │
                                  └─────── monitor restriction ──┐         ▼
                                                                 ▼   REDUCE_ONLY (T−1h)
                                                           REDUCE_ONLY      │
   oracle early halt ─────────────────────────────────────────────┐        ▼
                                                                  ▼     HALTED (at T or early halt)
                    oracle finality ─► snapshot/payout prep ─► CLAIMS_READY ─► claims paid (COMPLETE)
```

Orthogonal to the stage:
- **PricingMode**: `BOOTSTRAP` (no normal mark yet; only exactly backed orders inside the index band
  are allowed) or `NORMAL_PRICING`.
- **AccountingState**: `READY`, or a sweep in progress (`ROLLOVER_SWEEP`, `FLOOR_SWEEP`,
  `HALT_SWEEP`) during which trading and releases pause.
- **Settlement phase**: `LIVE → HALTED → PREPARING → READY → COMPLETE`.

Stage rules from risk spec §5:

| Stage | Starts | What users can do |
|---|---|---|
| TRADING | before T−12h30m | risk-checked trading, resting orders, releases |
| BACKING_GRACE | T−12h30m | new exposure must be fully backed (already true at 1x) |
| BACKING_FLOOR | T−12h | old orders invalidated; only fully backed new commitments |
| REDUCE_ONLY | T−1h, or monitor restriction | reduce/close only, top up, guarded excess-collateral release |
| HALTED | T or accepted early oracle halt | nothing economic; keepers prepare settlement |
| CLAIMS_READY | finality + price + allocation done | each trader claims once |

---

## 2. System map

```
                         ┌──────────────────────────── Browser app (apps/web) ───────────────────────────┐
                         │  wallet (wagmi) ── tx builder (viem: preview → simulate → send → parse logs)  │
                         │  read model: pinned multicall reads + risk-sdk decoders + indexer GraphQL     │
                         └───────┬───────────────────────┬─────────────────────────────┬────────────────┘
                                 │ JSON-RPC (reads/sends)│ GraphQL (history)           │ HTTPS (server routes)
                                 ▼                       ▼                             ▼
  ┌─────────────── Monad testnet (10143) ───────────┐  Envio HyperIndex        Next.js route handlers
  │ TestnetRiskCollateral (ERC-20, 6 dp)            │  oracle events today;    (optional: faucet proxy,
  │ CollateralVault  ── deposit/allocate/withdraw   │  extend with engine +    RPC proxy holding the
  │ BookRiskEngine   ── book + risk + settlement    │  vault events (§12)      private RPC key)
  │   └─ ReserveVault (created by the engine)       │
  │ TestnetResolutionAuthority (manual fixture)     │
  │                                                 │
  │ ResolutionOracle ─ MarketRegistry ─ BondTreasury│
  │ UmaAdapter ─ OOv3 (sandbox) ─ TestUSDC (faucet) │
  └─────────────────────────────────────────────────┘
   Off-chain, not called by the browser: INDEX publisher (signs observations), keeper, watchdog,
   panel runner, committee console, CRE workflow, market-ops relay.
```

There is **no separate order-book address**: the book is inside each `BookRiskEngine`. Use the
concrete engine ABI for both book and risk calls.

---

## 3. Recommended stack and repository layout

| Concern | Choice | Reason |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript strict | SSR shell, route handlers for the optional server-side proxies |
| Chain client | **viem 2.57.2** (same pin as `oracle/packages/oracle-sdk`) | Bit-identical encoding/EIP-712 with the oracle SDK |
| Wallet | wagmi 2.x + an injected/WalletConnect connector set (RainbowKit or ConnectKit) | Standard; sponsor wallet adapters (Privy/Dynamic) plug in later behind the same `useAccount` |
| Server state | TanStack Query (bundled with wagmi) | Block-keyed caching and polling |
| UI | Tailwind + shadcn/ui; a lightweight chart lib (lightweight-charts or Recharts) | Fast to build; dark trading UI |
| Runtime | Node 22 (matches the oracle workspace `engines`) | |
| Tests | Vitest for units/decoders, Playwright for flows against Anvil | Section 14 |

Layout (new directories are marked NEW):

```
apps/web/                         NEW  the Next.js app
  src/abi/                        NEW  generated `as const` ABIs (section 7.1)
  src/config/                     NEW  chain, manifest loader + validator (section 5)
  src/lib/units.ts                NEW  parse/format helpers (section 6)
  src/lib/reads/                  NEW  pinned snapshot readers per screen (section 8)
  src/lib/tx/                     NEW  one module per write flow (section 9)
  src/lib/indexer/                NEW  GraphQL client + queries (section 12)
  src/app/(routes)/...            NEW  screens (section 10)
  public/markets/*.json           NEW  market metadata manifests (section 5.3)
packages/risk-sdk/                existing, import its decoders; do not fork them
oracle/packages/oracle-sdk/       existing, import browser-safe modules only (section 7.3)
artifacts/risk/*.json             existing ABIs (source for codegen)
oracle/abi/*.json                 existing oracle ABIs (source for codegen)
```

Consuming the risk SDK: it ships TypeScript sources only (`packages/risk-sdk/src/index.ts`, no
`main` field, no build). Use a path alias in `apps/web/tsconfig.json`
(`"@eros/risk-sdk": ["../../packages/risk-sdk/src/index.ts"]`) and allow Next.js to compile files
outside the app directory (`transpilePackages` / `experimental.externalDir`, depending on the Next
version: **verify** with a build). Do not copy its code into the app; extend it in place when you
need a new decoder, and rerun `npm test --prefix packages/risk-sdk`.

---

## 4. Networks and chain facts

| Item | Value |
|---|---|
| Chain | Monad testnet, chain ID **10143**, native **MON** (18 decimals) |
| Public RPC | `https://testnet-rpc.monad.xyz` (rate-limited; `eth_getLogs` capped at **100 blocks**) |
| Explorer | `https://testnet.monadscan.com` (`/address/<a>`, `/tx/<h>`) |
| Envio HyperSync | `https://monad-testnet.hypersync.xyz` |
| Multicall3 | viem's `monadTestnet` chain definition carries one; **verify** `eth_getCode` at startup and fall back to single pinned reads |
| Gas | Monad charges the **gas limit**. Always `estimateGas` → limit = estimate × 1.10 (R9) |
| Finality | Show `pending` (sent) → `included` (receipt at `latest`) → `final` (block ≤ `finalized` tag) |
| Local dev | Anvil, chain ID **31337**, Forge/Anvil **1.8.3** (section 13.1) |

Use viem's built-in `monadTestnet` chain; override `rpcUrls` from config. Refuse to operate (show a
blocking "wrong network" state with a switch button) when `chainId` differs from the manifest.

---

## 5. Configuration

### 5.1 Environment variables (`apps/web/.env.local`, git-ignored by the root `.env.*` rule)

Only public values. Do not put a credentialed RPC URL here (R10); proxy it through a route handler
instead (`RPC_URL_SERVER`, server-only).

```dotenv
# Network
NEXT_PUBLIC_CHAIN_ID=10143
NEXT_PUBLIC_RPC_URL=https://testnet-rpc.monad.xyz
NEXT_PUBLIC_EXPLORER_URL=https://testnet.monadscan.com
NEXT_PUBLIC_DEPLOYMENT=monad-testnet          # selects public/deployments/<name>.json

# Indexer (oracle today; engine/vault events after section 12 lands). Blank = RPC-only mode.
NEXT_PUBLIC_INDEXER_URL=

# Wallet
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=

# Server-only (never NEXT_PUBLIC_): private RPC with provider token, used by /api/rpc proxy
RPC_URL_SERVER=
```

### 5.2 Deployment manifest (`apps/web/public/deployments/monad-testnet.json`)

Generate it from committed sources, never by hand-typing addresses: `addresses.md` (risk side) and
`oracle/deployments/monad-testnet.json` (oracle side). Validate with zod at startup (SP-00): refuse
to start on a wrong chain ID, a non-checksummed address, or missing code at an address.

```jsonc
{
  "chainId": 10143,
  "risk": {
    "collateralVault": "0xa8341d0343bc71b0f28e82dba2302c528608898d",
    "collateralToken": "0x99f93e9bfe3b2dd75fe27327789bd0a9236ff7b0",   // TestnetRiskCollateral, 6 dp, controller-mint only
    "abiDigest": "40e05c0e8034dcdba2a14fc19a97f2323412e69f92dc2146cac913ef8695cbb3"
  },
  "oracle": {
    "resolutionOracle": "0xa87D6E10a7199666ec9F2e04866201E35AAf36A6",
    "marketRegistry":   "0xEC11cC8fAfd47a1a92A7c9B43EEdee86a94B3DFa",
    "bondTreasury":     "0xA1AC1491dDc4DA8E72B69c12C01653dB62eEeB2a",
    "umaAdapter":       "0x1387bC4d10acd2aFB0C85b6f62a51Ad91600C3A1",
    "keeperRouter":     "0xa04109FfD14C8E2c8303b3F1047Eeb14D78a67A9",
    "oov3":             "0xdE3B884250333652aC2Bf27fE10A6483a50B0a26",
    "bondToken":        "0xFE854aEB0e1B5B568291f52696E5726c89a8d39e",   // TestUSDC, open faucet
    "deployBlock": 67901624
  },
  "markets": ["/markets/risk-fixture-2026-10-04.json"]
}
```

### 5.3 Market manifest (one file per market)

The engine stores only hashes (`listing().rulesHash`, `sourceHash`), not the question text. For
registry-listed markets the text is on chain (`MarketRegistry.getQuestion/getRules`); for the
current fixture engine it is not, so the manifest supplies a clearly labelled title.

```jsonc
// public/markets/risk-fixture-2026-10-04.json
{
  "engine": "0x58c63bfd94c13acb6f1da665406cc16cf80d1b69",
  "marketId": "0x75be8f1f39e85b942a81e019e98ae380c65da9a1fc2e90b531fddbe9ad96870a",
  "listingHash": "0x46a5cee0c75458e355018cde6e76ec94bb529c91489ed152c56ee2a4d597c95f",
  "deployBlock": 67915021,
  "title": "Testnet fixture market (no real-world question)",
  "oracleMarketId": null,                // set when the market is created through MarketRegistry
  "resolution": "MANUAL_TEST_AUTHORITY", // or "ORACLE"
  "fixture": true,                        // drives the R11 banners
  "role": "demo"                          // "demo" | "terminal-test": never mix (SP-00)
}
```

At load, read `engine.listing()` and `engine.listingHash()` and **refuse the manifest if
`marketId`/`listingHash` differ** from chain. For `resolution: "ORACLE"` also read
`MarketRegistry.getMarketCore(oracleMarketId).engine` and require it to equal `engine`.

---

## 6. Units and formatting (`src/lib/units.ts`)

| Field family | Unit | Display |
|---|---|---|
| `*Atoms`, vault balances, `claimableAtoms`, `usableReleaseAtoms` | 1e-6 USDC | `formatAtoms()` from risk-sdk → `"12.345678"` |
| `*Q` (`cashQ`, `e0Q`, `e1Q`, `mmQ`, `imQ`, fees) | 1e-24 USDC (atom × 1e18) | `qToMoney(q).usdc` (floors toward −∞ to whole atoms) |
| `lots`, `positionLots`, `size` | 0.001 claim | `lotsToClaims()` → `"100.000"` claims |
| `tick` | price = tick/1000 | `"0.500"` or `"50.0%"` |
| `*Wad` (`indexWad`, `markWad`, `settlementPriceE18`) | 1e18 = 1.0 | `wadToPrice()`; `undefined` → "unavailable" |
| `*At`, `scheduledT`, `asOfTime`, deadlines | Unix seconds (uint64) | absolute UTC + local + countdown |
| `expiryBlock` | block number; 0 = none | "good until block N (~mm:ss)" |

Risk-sdk already exports `Q`, `ATOMS_PER_USDC`, `LOTS_PER_CLAIM`, `WAD`, `qToMoney`, `lotsToClaims`,
`wadToPrice`, `formatAtoms`. Add only the **parsers** the SDK lacks:

```ts
// Strict decimal-string parsers. Reject, never round, anything more precise than the unit.
export function parseUsdcToAtoms(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s.trim());
  if (!m) throw new Error("amount: up to 6 decimals");
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}
export function parseClaimsToLots(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,3}))?$/.exec(s.trim());
  if (!m) throw new Error("size: up to 3 decimals (1 lot = 0.001 claim)");
  return BigInt(m[1]) * 1000n + BigInt((m[2] ?? "").padEnd(3, "0") || "0");
}
export function parsePriceToTick(s: string): number {
  const m = /^0?\.(\d{1,3})$/.exec(s.trim());
  if (!m) throw new Error("price: 0.001 to 0.999");
  const tick = Number(m[1].padEnd(3, "0"));
  if (tick < 1 || tick > 999) throw new Error("price: 0.001 to 0.999");
  return tick;
}
// Display-only helpers: fully backed cost at the current 1x profile, fees zero.
export const buyCostAtoms  = (lots: bigint, tick: number) => lots * BigInt(tick);
export const sellCostAtoms = (lots: bigint, tick: number) => lots * BigInt(1000 - tick);
```

Mark equity is `cashQ + 1000n * positionLots * markWad` and is already in Q: **do not divide by WAD
again** (risk-sdk `markedEquityQ`). Prefer the contract's `markEquityQ`.

---

## 7. Contract surface

### 7.1 ABIs and codegen

| Contract | ABI source | Notes |
|---|---|---|
| BookRiskEngine (concrete) | `artifacts/risk/book-risk-engine-abi.json` | 294 entries; JSON wraps it in `abi` |
| RegistryBookRiskEngine (factory variant, future) | compiler artifact under `oracle/out/` after `forge build` | adds `marketOiCapLots()` and two errors |
| CollateralVault | `artifacts/risk/vault-abi.json` | 35 entries |
| ReserveVault | `contracts/out/ReserveVault.sol/ReserveVault.json` after `forge build` | `notice()`, `maxRedeem(owner)`, `shares`, `noticeAt` |
| Collateral token | standard ERC-20 ABI | `TestnetRiskCollateral`, 6 decimals |
| Oracle contracts | `oracle/abi/<Name>.json` (`ResolutionOracle`, `MarketRegistry`, `BondTreasury`, `UmaAdapter`, `IOptimisticOracleV3`, `TestUSDC`, ...) | Hash-checked by `oracle/abi/SHA256SUMS` |

Write `apps/web/scripts/gen-abis.ts` that reads those files, unwraps `abi` when present and emits
`src/abi/<name>.ts` as `export const <name>Abi = [...] as const`. Run it in CI and fail when the
output differs from the committed files, mirroring the repo's existing ABI checks
(`scripts/export-risk-abis.py`). The risk digest above identifies the source the ABI came from.

### 7.2 Enums the UI decodes (values are ABI; never reorder)

Risk side (`contracts/src/math/RiskTypes.sol`, `MathTypes.sol`, `IBookRiskHooks.sol`, `Book.sol`,
`LifecycleMath.sol`, `LiquidationMath.sol`). The risk SDK already exports `Stage`, `PricingMode`,
`AccountingState`, `HealthStatus`, `LiquidationMode`, `FinalOutcome`, `ClearingPhase`,
`ConversionReason`, `ClaimMode`. Add the rest to the SDK, not to the app:

| Enum | Values |
|---|---|
| `Stage` | 0 TRADING, 1 BACKING_GRACE, 2 BACKING_FLOOR, 3 REDUCE_ONLY, 4 HALTED, 5 CLAIMS_READY |
| `PricingMode` | 0 BOOTSTRAP, 1 NORMAL_PRICING |
| `AccountingState` | 0 READY, 1 ROLLOVER_SWEEP, 2 FLOOR_SWEEP, 3 HALT_SWEEP |
| `HealthStatus` | 0 FLAT, 1 HEALTHY, 2 BELOW_IM, 3 BELOW_MM, 4 NONPOSITIVE |
| `OrderKind` (`Place.kind`) | 0 LIMIT, 1 IOC, 2 POST_ONLY |
| `Side` (`previewOrder` arg) | 0 BUY, 1 SELL |
| `RejectCode` (`OrderRejected.reason`, `previewOrder.rejection`, `previewRelease.reason`) | 0 NONE, 1 HALTED, 2 BAD_STAGE, 3 OUTSIDE_BAND, 4 BELOW_MIN_SIZE, 5 NO_REDUCIBLE_POSITION, 6 MAKER_BELOW_IM, 7 MAKER_BELOW_MM, 8 TAKER_CAPACITY, 9 ACCOUNT_DEFICIT_CAP, 10 MARKET_COVERAGE, 11 INVALID_PRICE_OR_SIZE, 12 STALE_ORDER |
| `CancelReason` (`OrderCancelled.reason`) | 0 USER, 1 SELF_TRADE, 2 FAILED_CHECK, 3 CLIPPED, 4 EXPIRED |
| `RemovalReason` (`OrdersInvalidated.reason`) | 0 USER_CANCEL, 1 EXPIRED, 2 STALE_MARKET_EPOCH, 3 STALE_ACCOUNT_EPOCH, 4 STALE_REDUCE_VERSION, 5 SELF_TRADE, 6 FAILED_READMISSION, 7 FILLED, 8 REDUCE_ONLY_EXHAUSTED, 9 CROSSED_REMAINDER, 10 REPLACED |
| `ClearingPhase` | 0 LIVE, 1 HALTED, 2 PREPARING, 3 READY, 4 COMPLETE |
| `FinalOutcome` (engine) | 0 UNSET, 1 NO, 2 YES, 3 INVALID |
| `ClaimsStatus` (`claimsStatus()`) | 0 AWAITING_OUTCOME, 1 ORACLE_FINAL_PRICE_PENDING, 2 ORACLE_FINAL_PREPARING, 3 RECOVERY_REQUIRED, 4 CLAIMABLE |
| `LiquidationMath.Result` | 0 NOT_ELIGIBLE, 1 DONE, 2 NEEDS_MORE_WORK, 3 TAKEOVER_AUTHORIZED, 4 DISABLED |
| `LiquidationMode` | 0 NONE, 1 REDUCE, 2 TAKEOVER |
| Order `flags` bits | 1 BUY, 2 REDUCE_ONLY, 4 LIVE |
| `pendingWork` bits | 1 FLOOR_SWEEP, 2 ROLLOVER_SWEEP, 4 HALT_SWEEP, 8 EPOCH_OPENING |

Oracle side (`oracle/src/types/OracleTypes.sol`):

| Enum | Values |
|---|---|
| `Outcome` (oracle) | 0 NONE, 1 YES, 2 NO, 3 INVALID. **Not** the engine's `FinalOutcome`; never cast between them |
| `Path` | 0 NONE, 1 L1, 2 L2_AUTO, 3 REVIEWED, 4 PERMISSIONLESS |
| `RState` | 0 None, 1 EarlyCheck, 2 EarlyReview, 3 L1Pending, 4 L2Pending, 5 Review, 6 Open, 7 Proposed, 8 Disputed, 9 Voided, 10 Final |
| `FinalReason` | 0 NONE, 1 ASSERTED_TRUE, 2 REJECTED_YES_AND_NO, 3 VOID_DEADLINE |
| `PanelLabel` | 0 ABSTAIN, 1 YES, 2 NO, 3 INVALID, 4 NOT_YET |

User copy for `RejectCode` (ticket and toast):

| Code | Message |
|---|---|
| HALTED | Market is halted; no new orders. |
| BAD_STAGE | Not allowed at this stage (pre-activation, reduce-only, sweep in progress or final-day restriction). |
| OUTSIDE_BAND | Price is outside the allowed band around the index while the market bootstraps. |
| BELOW_MIN_SIZE | Size is below the market minimum. |
| NO_REDUCIBLE_POSITION | Reduce-only order, but there is no position on the opposite side to reduce. |
| TAKER_CAPACITY | Not enough allocated collateral to fully back this order. |
| ACCOUNT_DEFICIT_CAP | Exceeds the per-account exposure cap. |
| MARKET_COVERAGE | Market reserve coverage would be exceeded. |
| INVALID_PRICE_OR_SIZE | Price or size invalid for the current price state (for example no valid index). |
| STALE_ORDER | Order became stale (epoch changed or expired). |
| MAKER_BELOW_IM / MAKER_BELOW_MM | A resting order failed re-admission and was removed. |

Revert errors to translate (full list in the ABI): `BadTick`, `BadSize`, `BadMaxFills`,
`BadExpiry`, `PostOnlyCrosses`, `BatchActionLimit`, `BatchStepLimit`, `NotLive`, `NotOwner`,
`BookFull`, `Stale`, `Rejected`, `Coverage`, `BadState`, `NotHalted`, `PreparationIncomplete`,
`OutcomeOrPricePending`, `ConversionDisabled`, `RiskUnauthorized`, `Unauthorized`, `BadUnits`,
`Reentrant`, `TransferFailed`, `Locked` (ReserveVault). Use viem's `decodeErrorResult` on simulation
failures and map names to messages; show the raw name in a details disclosure.

### 7.3 Oracle SDK: what is browser-safe

`oracle/packages/oracle-sdk/src/index.ts` re-exports modules that import `node:fs`/`path`
(`deployments.ts`, `abi/sources.ts`). Do **not** import the package root in client code. Import
the specific modules instead: `indexer.ts` (GraphQL query strings), `bond.ts` (bond/liveness/void
maths), `claim.ts` (claim rendering), `eip712.ts`, and the ABI constants. If the bundler still pulls
Node modules, add a browser entry (`src/browser.ts`) to the SDK rather than duplicating code.

---

## 8. Read model

### 8.1 Block-pinned snapshots

Every panel reads through one function that pins a block:

```ts
const block = await client.getBlockNumber();             // or a shared "head" from a block watcher
const results = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [...] });
return { block, chainId, engine, ...decode(results) };   // carry identity into every decoded value
```

The risk SDK's `ViewIdentity` / `ReadIdentity` types exist for exactly this; populate them from the
same read (`asOfTime`, `riskVersion`, `profileHash`, mark availability from `previewAccount.id`).
Show "as of block N" in a muted footer on each panel. Refetch on every new block for the active
market (throttle to ~1 s), and every 10–30 s for background markets.

### 8.2 Read sets by screen

**Market header / status bar** (one multicall):
`active()`, `halted()`, `priceReady()`, `currentStage()`, `marketRiskView()`, `getSettlementStatus()`,
`listing()`, `scheduledT()`, `bestBidAsk()`, `touch()`, `oiAllLots()`, `participantCount()`,
`epoch()`, `freshness()`, `invalidWindow()`, `maxFills()`, `maxBatchActions()`.

`marketRiskView()` returns `{asOfTime, stage, pricingMode, accountingState, indexAvailable, indexWad,
markAvailable, markWad, riskVersion, profileHash, secsToT, monitorRestricted, fundingFreshThrough,
floorStatus, floorCursor, floorCount, liquidationCapLots, liquidationRemainingLots, pendingWork}`.
Decode with `decodeMarket()` (extend the SDK's `MarketRiskViewRaw` with the newer fields).

**Account panel** (needs the trader id):
1. `participantId(owner)` → `uint32`; **0 = not registered** (no allocation yet). Registration
   happens on the first `allocate`.
2. `previewAccount(traderId)` → `{id: PreviewIdentity, cashQ, positionLots, projectedFundingQ,
   projectedPremiumQ, projectionsAreEstimates, e0Q, e1Q, markEquityQ, mmQ, imQ, fullBackingRequired,
   status, orders: {bidLots, bidValueQ, askLots, askValueQ, feeCapQ, maxBidTick, minAskTick},
   usableReleaseAtoms}`.
3. `accountRiskView(traderId)` → grace/liquidation fields; decode with `decodeAccount()`.
4. Vault: `freeAtoms(owner)`; token: `balanceOf(owner)`, `allowance(owner, vault)`.
5. After halt: `claimableAtoms(owner)`, `traderClaimed(owner)`, `vault.claimAtoms(engine, owner)`.

`previewAccount.cashQ` already includes projected funding and premium; never subtract them again.
`usableReleaseAtoms` is the **only** number for "available to release". `account(owner)` is the
stored snapshot (useful for debugging, not for the main balance).

Display, per account:

| Label | Source |
|---|---|
| Wallet balance | `token.balanceOf(owner)` |
| Vault (free) | `vault.freeAtoms(owner)` |
| Allocated cash | `qToMoney(previewAccount.cashQ)` |
| Position | `lotsToClaims(positionLots)` + "YES"/"NO" side |
| Value if YES / if NO | `qToMoney(e1Q)` / `qToMoney(e0Q)` |
| Mark equity / IM / MM | only when `markAvailable`; else "unavailable" |
| Health | `HealthStatus` text, or "unavailable (no valid mark)" |
| Reserved by open orders | `orders.bidValueQ`, `orders.askValueQ`, lots |
| Available to release | `usableReleaseAtoms` |
| Claimable (after halt) | `claimableAtoms(owner)`, live only when `isClaimable()` |

**Order ticket**: `previewOrder(traderId, side, limitTick, lots, reduceOnly)` →
`{id, rejection, acceptedCapLots, feeCapQ, mode, fullBackingRequired, eMinQ, requiredImQ, d0AfterQ,
d1AfterQ, marketCoverageAfter, halvingSteps}`. Debounce 250 ms on input change; show the rejection
text, and offer "max size" = `acceptedCapLots`. If `acceptedCapLots < lots`, say the order would be
admitted only up to that size.

**Settlement panel**: `getSettlementStatus()` → `decodeSettlementStatus()` and `STATUS_TEXT`;
`getHaltSnapshot()`; `invalidPrice()`; `finalOutcome()`; `claimsStatus()`;
`settlementPrice()` from the SDK (undefined while pending).

### 8.3 Order book ladder

There is **no depth getter** and the book keeps lazily cancelled orders. Build the ladder from:

1. `bestBidAsk()` → best bid/ask ticks (0 = none).
2. A window of `getLevel(isBuy, tick)` reads (e.g. 40 ticks each side of the touch) in one pinned
   multicall. `size` is **gross resting lots**, which can include orders that are already dead
   because of `cancelAll`, a market epoch bump or expiry. Label the ladder "resting size".
3. `bookDepth()` → `{bidWad, askWad, bidDepthLots, askDepthLots, examined, fingerprint}`: the
   stale-aware impact depth the sampler would use (bounded traversal). Show it as "executable depth"
   next to the ladder. It is a view, not accepted price history.
4. `touch()` → best bid/ask after the minimum-depth filter used for pricing.

When the indexer exists (section 12), render depth from indexed live orders instead and keep the
pinned reads as a consistency check.

### 8.4 "My orders"

Track the user's order ids from `OrderPlaced` logs in their own receipts (and from the indexer).
For each id read `getOrder(id)` → `{owner, size, next, prev, tick, flags, gen, reduceVersion,
marketEpoch, accountEpoch, expiryBlock, feeCapQ}`. Treat an order as live only when all hold:
`size > 0`, `flags & 4` (LIVE), `marketEpoch == marketOrderEpoch()`,
`accountEpoch == account(owner).orderEpoch`, and `expiryBlock == 0 || block <= expiryBlock`.
Otherwise show it as "stale (will be pruned)". This mirrors the engine's checks for display only;
the engine decides. Order id layout: `id = gen << 24 | slot`; an id is never reissued.

### 8.5 Events (live tape, fills, history)

Public RPC log reads are capped at 100 blocks, so:
- **Live tape**: poll `getLogs` for `Fill` over the last ≤100 blocks each new block.
- **Own activity in-session**: parse your own receipts (section 9.4).
- **History** (trades, candles, past orders, claims): the indexer only (section 12). Without it,
  show "history unavailable" instead of a partial list.

Do not count `Fill` and `PairedPosting` as two trades: each paired fill emits both. Use `Fill` for
the tape (maker/taker/tick/size) and `PairedPosting` only for owner addresses if needed.

### 8.6 Price chart

| Series | Source | Notes |
|---|---|---|
| Index | `ObservationAccepted` events (`priceWad`, `observedAt`, `depthValid`) | Independent INDEX; the risk authority |
| Index TWAP 300 s | `indexTwap300(end)` view | `available=false` → gap, not 0 |
| Perp mid / TWAP 60 s | `PerpObservationRecorded`, `perpTwap60(end)` | Book-derived |
| Basis TWAP 900 s | `basisTwap900(end)` | |
| Mark | `marketRiskView().markWad` when `markAvailable` | Only in NORMAL_PRICING |
| Trades | `Fill.tick` | |
| Bootstrap band | `indexWad ± listing().bootstrapBandWad` | Shade the admissible band during BOOTSTRAP |

---

## 9. Write flows

### 9.1 Transaction pipeline (all writes)

```ts
async function send(req) {
  const sim = await publicClient.simulateContract({ ...req, account });       // decode revert → message
  const gas = await publicClient.estimateContractGas({ ...req, account });
  const hash = await walletClient.writeContract({ ...sim.request, gas: (gas * 110n) / 100n });
  ui.pending(hash);                                                             // explorer link
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new TxFailed(hash);
  const events = parseEventLogs({ abi: engineAbi, logs: receipt.logs });        // section 9.4
  invalidateQueriesFor(receipt.blockNumber);                                     // refetch pinned reads
  return { receipt, events };
}
```

- Guard double submits (disable the button while pending; idempotency key per form submission).
- After the receipt, refetch at `receipt.blockNumber` or later; never show pre-tx reads as post-tx.
- Check the wallet's chain and account **again** right before sending; abort if either changed.

### 9.2 Get test collateral

`TestnetRiskCollateral.mint` is **controller-only**; users cannot self-faucet. Options, in order:
1. Operator mints to tester addresses out of band (section 13.3).
2. A server-side faucet route holding the controller key. **Not authorized today** (the key is not
   on this machine and handing out signer secrets is forbidden by `addresses.md`). Do not build it
   without explicit operator approval.
3. Local Anvil: the dev script mints to the default Anvil accounts (section 13.1).

Show "Get test collateral" as instructions when the wallet holds none.

For oracle bonds only, `TestUSDC` (`0xFE85…d39e`) has an open faucet: `mint(to, amount)` up to
`FAUCET_CAP()`. It is a **different token** from the trading collateral; never mix them.

### 9.3 Deposit and allocate (fund a market)

```
1. token.allowance(owner, vault) < atoms  →  token.approve(vault, atoms)
2. vault.deposit(atoms)                      emits Deposit(owner, atoms); exact-receipt only
3. read vault.freeAtoms(owner) ≥ atoms
4. vault.allocate(engine, atoms, false)      emits Allocation(engine, owner, atoms, false)
                                              engine emits CashAllocated, AccountRegistered (first time)
5. read participantId(owner) > 0
```

- One "Fund market" button may run steps 1, 2 and 4 as three wallet prompts with a stepper.
- `reserve = false` for traders. `true` is LP seeding (section 9.8).
- Allocation can wait for a sweep; if `accountingState != READY`, explain and retry later.
- The market has a hard cap of **1,024 traders** (`listing().maxTraders`); show remaining slots
  (`participantCount()`), and that allocation into a full market fails.
- New allocation at or after `T` is rejected.

### 9.4 Place an order

`placeOrder(Place)` with `Place = {kind, isBuy, reduceOnly, tick, size, maxFills, expiryBlock}`:

| Field | Type | Rule |
|---|---|---|
| `kind` | uint8 | 0 LIMIT (match, rest remainder), 1 IOC (match, drop remainder), 2 POST_ONLY (never match; reverts `PostOnlyCrosses` if it would cross) |
| `isBuy` | bool | true = buy YES (long) |
| `reduceOnly` | bool | only reduce an existing opposite position |
| `tick` | uint16 | 1..999 |
| `size` | uint64 | lots, ≥ `listing().minOrderLots`, ≤ `maxOrderLots` |
| `maxFills` | uint8 | makers the match may examine, ≤ `maxFills()` (8 today); read it, never hardcode |
| `expiryBlock` | uint32 | 0 = none; executable while `block.number <= expiryBlock`; must not already be past |

Flow:
1. Require `participantId(owner) > 0` (else route to "Fund market").
2. `previewOrder(...)`: block on `rejection != NONE`; clamp to `acceptedCapLots`.
3. Simulate and send (9.1).
4. Parse the receipt. The **return value is not the result**:

| Receipt contents | Meaning | UI |
|---|---|---|
| `OrderRejected(trader, reason)` | Risk admitted nothing. **The transaction still succeeded.** | Error toast with `RejectCode` text |
| `Fill(...)` × n | Matched against makers at their ticks | "Filled X of Y at avg tick" (size-weighted from logs) |
| `OrderPlaced(id, trader, tick, size, flags, expiryBlock)` | Remainder rests with id | Add to My orders |
| `OrderCancelled(id, size, reason)` for makers | Makers pruned/expired/self-trade during the match | Optional detail |
| `MakerPruned` | A stale/failed maker was removed | Optional detail |
| No `OrderPlaced` and no rejection | IOC remainder dropped, full fill, or `maxFills` ran out while still crossing | Say exactly which from fill totals |

Self-trades: an order reaching its own resting order cancels that maker (`SELF_TRADE`); warn in
the ticket when the user's own order sits at the opposite touch.

### 9.5 Cancel, cancel all, batch

- `cancel(id)`: reverts `NotLive`/`NotOwner` for dead or foreign ids; refresh "My orders" first.
- `cancelAll()`: O(1). Emits `AllOrdersCancelled(trader, marketEpoch, accountEpoch)`. Old orders
  stay in the book (counted in `getLevel.size`) until pruned but can never fill. Mark them stale.
- `batch(uint32[] cancels, Place[] places)`: cancels run first and are idempotent; total actions ≤
  `maxBatchActions()` (8); the sum of non-POST_ONLY `maxFills` ≤ `maxFills()`; a crossing POST_ONLY
  returns id 0 instead of reverting. Use for "replace order" (cancel + place) and quote ladders.
  Split larger work into separate transactions.

### 9.6 Release and withdraw

```
1. read previewAccount(traderId).usableReleaseAtoms  (and previewRelease(traderId, atoms) → ok, reason)
2. engine.release(atoms)          moves market cash back to vault free balance (emits vault Released)
3. read vault.freeAtoms(owner)
4. vault.withdraw(atoms)          tokens to the wallet
```

Releases are blocked while a sweep runs, without usable prices, after halt, and whenever risk checks
fail; show `previewRelease.reason` text. During REDUCE_ONLY a guarded excess-collateral release is
still allowed (RB-I08). The vault has **no withdraw event**; confirm with `freeAtoms` and the token
`Transfer`.

### 9.7 Settlement and claims

Status: `decodeSettlementStatus(getSettlementStatus())`:

| Status | Copy (from `STATUS_TEXT`) | Button state |
|---|---|---|
| LIVE | trading | — |
| HALTED_AWAITING_OUTCOME | halted, awaiting outcome | none |
| ORACLE_FINAL_PRICE_PENDING | INVALID final, waiting for scheduled TWAP window | none (keeper: `captureInvalidPrice`) |
| ORACLE_FINAL_PREPARING | outcome final, preparing balances | none (keepers: prepare chunks) |
| RECOVERY_REQUIRED | preparation failed: recovery required, claims disabled | none; link to support/ops |
| CLAIMABLE | claims ready | **Claim** enabled iff `isClaimable(v)` and `claimableAtoms(owner) > 0` and `!traderClaimed(owner)` |
| COMPLETE | all claims paid | none |

Claim: `engine.claimTrader(owner)` **or** `vault.claim(engine, owner)`; both pay the fixed owner,
once. Anyone may call it for an owner (useful for a "deliver payout" helper), but the recipient never
changes. Confirm with vault `Paid(engine, owner, atoms)` and token `Transfer`. Then the funds are in
the user's wallet (not in the vault free balance): verify on the receipt rather than assuming.

Show the payout explanation: YES → each long lot pays 1,000 atoms; NO → each short lot pays 1,000
atoms; INVALID → the captured `settlementPriceE18` (disclosed fallback 0.5 if the index window is
missing an hour after T, DEC-08).

### 9.8 Liquidity provider (reserve) flows

DEC-06: reserve shares are issued **only before activation**; no live redemption.

| Step | Call | When |
|---|---|---|
| Seed | `vault.allocate(engine, atoms, true)` | before `activateMarket()`: 1:1 shares. After activation it is a **donation** (no shares); warn loudly |
| Notice | `ReserveVault.notice()` | any time after holding shares; starts a 7-day notice |
| Redeem | `engine.redeemReserve(owner)` | after claims are prepared and 7 days after notice; `ReserveVault.maxRedeem(owner) > 0` |

Show `reserve()`, `reserveCapBaseQ()`, `coverageSlacks()` as "coverage slack" (never as tradable
NAV), `outstandingReserveAtoms()`, and holder count (max 256).

### 9.9 Permissionless operations (keeper console)

Anyone can call these; a small "Operations" page lets testers move a demo market forward. Gate each
button on the read that says it is due, show estimated gas, and warn that keepers usually do it.

| Action | Call | Due when |
|---|---|---|
| Epoch rollover | `beginRollover()`, `rollPage(32)` until complete, `finishRollover()` | `pendingWork & ROLLOVER_SWEEP`, or epoch end passed |
| PERP sample | `samplePerp()` | normal operation; publication needs a strictly newer INDEX later |
| Floor sweep | `floorSweep(32)` | from T−12h until reconciled (`floorProgress()`) |
| Scheduled halt | `materializeScheduledHalt()` | `now ≥ scheduledT` and not halted |
| INVALID capture | `captureInvalidPrice()` | INVALID final and price not ready |
| Snapshot prep | `prepareSnapshotChunk(32)` repeat until `done` | after halt |
| Payout prep | `preparePayoutChunk(32)` repeat until `done` | after finality and price |
| Finish | `finishPreparation()` | both cursors done |
| Liquidate | `liquidate(trader, maxLots, maxExaminations ≤ maxFills(), partner)` | `accountRiskView.liquidationMode != NONE`; returns a `Result` |
| Keeper fees | `withdrawKeeper()` | after payout scan |

Recorded local gas for reference: halt 457k, snapshot page of 32 ≈ 3.0M, payout pages ≈ 1.6M and
2.5M, finish with 256 reserve holders ≈ 10.7M (`REAL_FACTORY_INTEGRATION.md`). Monad charges the
limit, so always estimate first.

### 9.10 Role-gated admin (operator-only, behind a feature flag)

Visible only when the connected address equals the role in `listing()`. Never ship keys.

| Role | Calls |
|---|---|
| governance | `activateMarket()`, `stageRiskParams(params)` |
| monitor | `requestReduceOnly(reason)`, `clearReduceOnly(reason)`, `raiseHazards(h0, h1)` |
| fixture controller (testnet only) | `TestnetRiskCollateral.mint(owner, atoms)`; `TestnetResolutionAuthority.halt()`, `finalize(1 = YES / 0 = NO)`, `finalizeInvalid()` |

INDEX observations (`submitObservation(obs, sig)`) are signed off-chain by the pinned index signer
over the raw digest from `observationDigest(obs)` (no `personal_sign`, no EIP-712 prefix; signature
`r‖s‖v`). That belongs to the publisher service, not to the browser.

### 9.11 Resolution and disputes (oracle markets)

For markets with `oracleMarketId`:

Reads: `MarketRegistry.getQuestion(id)`, `getRules(id)`, `getMarketCore(id)` (engine, tau, hasFeed,
voidSecs, oiCapLots, monitor, groupId, ...), `ResolutionOracle.getResolution(id)` (state, proposed,
path, attempts, rejectedMask, outcome, finalReason, haltedAt, voidDeadline, retryOpensAt,
assertionId, bond, ...), `evidenceURIOf(id)`, `renderClaim(id)`, `bondFor(id)`, `livenessFor(id)`,
`UmaAdapter.statusOf(assertionId)`, `OOv3.getAssertion(assertionId)`.

Writes (Disputes Live, oracle plan §9.5):

| Button | Calls | Rules |
|---|---|---|
| Dispute | `TestUSDC.approve(OOv3, bond)` → `OOv3.disputeAssertion(assertionId, user)` | Only while the assertion is live and before `expiresAt`; show the exact bond and a countdown |
| Propose (state Open) | `TestUSDC.approve(UmaAdapter, B)` → `ResolutionOracle.proposePermissionless(id, outcome, evidenceURI, evidenceHash)` | Disable outcomes whose bit is set in `rejectedMask`; B = `bondFor(id)` |
| Progress (permissionless) | `haltScheduled`, `requestResolution`, `escalateToL2`, `openAfterDeadline`, `assertProposal`, `syncAssertion`, `finalizeMarket`, `voidMarket`, `expireEarly`; batch with `KeeperRouter.finalizeMany(ids)` | Most return `false` as a no-op instead of reverting; show "nothing to do" |

Required banners: "Disputes on testnet are decided by the Eros team through a sandbox oracle, not by
UMA voters." and, when the CRE simulator is the Layer 1 path, "Layer 1 runs on a single simulation
node, not a Chainlink DON." Show `voidDeadline` and the worst-case lock (R12).

Committee signing (EIP-712 `ReviewedProposal`) stays in the CLI committee console
(`oracle/services/committee-console`); a web version is optional and must reuse
`oracle-sdk/eip712.ts` (`eth_signTypedData_v4`) and collect signatures server-side.

---

## 10. Screens

### 10.1 Global shell
- Header: logo, market switcher, network pill (chain, block number, RPC health), wallet button.
- Persistent banners (R11): "Testnet: test collateral, not USDC", "Resolution is a manual test
  authority" (fixture markets), "Risk profile is uncalibrated: 1x fully backed", sandbox oracle
  banner on resolution pages.
- Wrong network → full-page blocker with "Switch to Monad testnet".
- Global tx tray: pending/included/final transactions with explorer links.

### 10.2 Markets list (`/`)
Cards/rows per manifest market: title, status chip (section 11), best bid/ask, index, OI
(`oiAllLots` as claims), time to T, participants `n/1024`, "fixture"/"oracle" badge. Filters:
trading / halted / claimable.

### 10.3 Market page (`/m/[engine]`)
- **Header**: question/title, rules (from registry) or rules hash (fixture), T (UTC + countdown),
  stage + pricing + accounting chips, index and mark (or "unavailable"), void/lock disclosure.
- **Chart** (8.6).
- **Order book** ladder + executable depth + spread; click a level to prefill the ticket.
- **Trade ticket**: Buy YES / Sell YES tabs, order kind, price, size (claims), reduce-only, expiry,
  cost preview (atoms), `acceptedCapLots`, rejection text, submit. Disabled with an explanation when
  not active, halted, BOOTSTRAP without a valid index, sweeping, or wallet unregistered.
- **Account strip**: wallet / vault free / allocated / position / value if YES / value if NO /
  available to release; buttons Fund, Release, Withdraw.
- **Tabs**: My orders (8.4), My fills (receipts + indexer), Trades tape (8.5), Market info
  (listing fields, addresses with explorer links, ABI digest, `profileHash`, `riskVersion`).
- **Settlement card** replaces the ticket once halted (9.7).
- **Resolution card** (oracle markets): state timeline from the indexer, current proposal, evidence
  link, deadlines; link to the Disputes page.

### 10.4 Portfolio (`/portfolio`)
Per market: position, cash, endpoints, open orders, claimable/claimed, reserve shares. Totals only
within one market type; never net across markets (no cross-margining).

### 10.5 Claims (`/claims`)
All markets where `claimableAtoms(owner) > 0` and not claimed; status per 9.7; one Claim button per
market.

### 10.6 Liquidity (`/m/[engine]/reserve`)
Pre-activation seeding with a hard warning about post-activation donation, notice/redeem flow,
coverage slack, holder count.

### 10.7 Disputes Live (`/disputes`)
List: `LIVE_MARKETS` query (Proposed, Disputed, Review, Open; soonest deadline first). Detail:
`MARKET_DETAIL` query plus on-chain reads; question, rules, proposed outcome + path, evidence URI +
hash (or L1 value hash + source URL), panel labels and calibrated confidences, bond, assertion
expiry, `voidDeadline`, attempts, rejected outcomes; Dispute and Propose buttons (9.11).

### 10.8 Operations (`/ops`)
Keeper buttons (9.9) and oracle progress buttons (9.11), each with "due/not due" reasoning and
estimated gas. Admin panel (9.10) only for matching role addresses.

### 10.9 Empty, loading and error states (required)
- Loading: skeletons, never `0`.
- Unavailable: explicit "unavailable" with the reason (no valid index, mark warming up, sweep).
- RPC down / indexer behind: banner with last good block; disable writes if the head is stale.
- Indexer lag: compare its `_meta.progressBlock` with the chain head; above a threshold show
  "history delayed by N blocks".

---

## 11. One status chip: derivation order

Evaluate top to bottom; first match wins.

| Condition | Chip |
|---|---|
| wrong chain / manifest mismatch | Configuration error |
| `settlement.claimsEnabled` and phase COMPLETE | All claims paid |
| `isClaimable(settlement)` | Claims open |
| `settlement.recoveryRequired` | Recovery required |
| halted and `oracleFinalityAccepted` | `STATUS_TEXT[decodeSettlementStatus(v)]` |
| `halted` | Halted, awaiting outcome (+ oracle `RState` name when linked) |
| `!active` | Not yet activated |
| `accountingState != READY` | Paused: accounting sweep |
| stage REDUCE_ONLY (`monitorRestricted` → "monitor restriction") | Reduce only |
| stage BACKING_FLOOR / BACKING_GRACE | Final-day backing |
| `pricingMode == BOOTSTRAP` and `!indexAvailable` | Waiting for index price |
| `pricingMode == BOOTSTRAP` | Bootstrap (fully backed, index band) |
| otherwise | Trading |

---

## 12. Indexer (Envio) for engine and vault history

Today `oracle/indexer` indexes oracle events only (`schema.graphql`: Market, Resolution, Assertion,
Proposal, PanelResult, Dispute, TreasuryLedger, TrustSet, ReportAttempt, Category, SandboxRequest,
Watchdog). SP-02 extends it; build this before history features.

Add to `oracle/indexer/config.yaml` (concrete engine ABI, vault ABI; start blocks from the
deployment receipts, e.g. engine block 67,915,021, vault 67,914,987):

| Entity | From events | Key fields |
|---|---|---|
| `EngineMarket` | engine `listing()` at registration, `MarketHalted`, `OracleFinalityAccepted`, `ClaimsEnabled`, `PricingModeChanged`, `MarketBalance` | engine, marketId, stage, halted, outcome, claimsEnabled, OI |
| `Order` | `OrderPlaced`, `OrderCancelled`, `Fill` (makerOrder), `AllOrdersCancelled`, `MarketOrdersInvalidated`, `OrderAmendedDown` | id, trader, tick, side, remaining, status, epochs |
| `Trade` | `Fill` | makerOrder, maker, taker, tick, size, fees, block, logIndex |
| `Account` | `AccountRegistered`, `AccountBalance`, `CashAllocated`, `AccountTakenOver` | owner, traderId, lots, cashQ |
| `Observation` | `ObservationAccepted`, `PerpObservationRecorded`, `BookDepthCaptured` | price, times, validity |
| `Settlement` | `SnapshotPreparationProgress`, `PayoutPreparationProgress`, `InvalidPriceCaptured`, `RecoveryRequired`, `ClaimsEnabled` | cursors, price |
| `VaultMovement` | vault `Deposit`, `Allocation`, `Released`, `Escrowed`, `Paid`, `FeesPaid` | owner, engine, atoms |
| `Candle` (derived) | `Fill` | per 1m/5m/1h OHLC in ticks, volume in lots |

Rules: the last `AccountBalance` per trader and last `MarketBalance` reconstruct the ledger
(`AccountingReplay` in the risk SDK); deterministic ids `chainId-block-logIndex`; reorg rollback on;
the vault has no withdrawal event, so current free balances come from pinned `freeAtoms` reads, not
events. Register future factory engines from the registry's `MarketListed` event (dynamic contract
registration) once the factory is live.

Client: plain `fetch` POST to `NEXT_PUBLIC_INDEXER_URL` with the query strings from
`oracle-sdk/src/indexer.ts` (`LIVE_MARKETS`, `MARKET_DETAIL`, `ASSERTION_HISTORY`,
`OPEN_ASSERTIONS`, ...). Always also query `_meta { progressBlock }` and treat data past it as absent.

Local indexer: `envio dev` needs Docker (on this Mac via Colima: set `DOCKER_HOST` to the Colima
socket). Hosted Envio needs `ENVIO_API_TOKEN` in `oracle/indexer/.env`.

---

## 13. Environments

### 13.1 Local trading environment (build this first)

The deployed testnet market cannot trade yet, so develop against Anvil with the real contracts.
`contracts/script/LocalBookRiskSmoke.s.sol` shows every step but runs a terminal scenario (it
halts and settles). Add a NEW dev script, e.g. `contracts/script/LocalFrontendDev.s.sol`, that:

1. Deploys `MockUSDC`, `CollateralVault`, `MockResolutionAuthority`, `BookRiskEngine` with the same
   `_configuration` as the smoke script (10-day T, 1x, `maxFills` from the engine).
2. `vault.registerEngine(engine)`, `oracle.bind(engine)`.
3. Mints e.g. 10,000 USDC to the first 5 Anvil accounts (do not allocate for them).
4. Optionally seeds reserve via `allocate(engine, atoms, true)` before activation.
5. `activateMarket()` and submits a 300-second signed INDEX window (31 observations, 10 s apart)
   with the local test key `0xA11CE`, exactly like `_submitIndex`.
6. Writes `apps/web/public/deployments/local.json` and a market manifest.

Plus a NEW `scripts/dev-index-feeder.ts` that keeps submitting a fresh observation every 10 s
(`sequence = lastSequence + 1`, `observedAt = latest block timestamp`, sign
`observationDigest(obs)` with `0xA11CE`). Without it the index goes stale after 30 s and every
new order fails with an index error. Both files are dev-only: the key is a public test key that
must never be used on a public network.

```bash
anvil --chain-id 31337 --block-time 1
export LOCAL_SMOKE_SENDER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   # Anvil default account 0 (public)
cd contracts && FOUNDRY_PROFILE=risk forge script script/LocalFrontendDev.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender "$LOCAL_SMOKE_SENDER"
bun scripts/dev-index-feeder.ts   # or node, from apps/web
NEXT_PUBLIC_DEPLOYMENT=local npm run dev --prefix apps/web
```

Use Anvil's `evm_increaseTime` + `evm_mine` from a dev panel to jump to T−12h, T−1h and T, and the
mock authority to halt/finalize, so every lifecycle screen can be exercised.

### 13.2 Testnet read-only (today)

Point at the deployed engine with `NEXT_PUBLIC_DEPLOYMENT=monad-testnet`. Expect: `active=false`,
`priceReady=false`, `halted=false`, `claimsEnabled=false`, zero OI. Every read screen must render
these states correctly. Scheduled halt `T` = **2026-10-13 19:39:36 UTC** whether or not it is
activated; after that, it can only exercise settlement.

### 13.3 Testnet with trading (needs the operator)

Not something the frontend can do alone. The fixture controller (`0x7676…da46`) must: mint test
collateral to testers, accept LP seeds before activation, call `activateMarket()`, and run a signed
INDEX feed with cadence well below 30 s for the whole demo. None of these keys are on this machine.
A real-oracle market additionally needs the factory switch (RF-LIVE): see
`docs/integration/REAL_FACTORY_INTEGRATION.md` "Operator handoff". Keep a demo market and a
terminal-test market separate.

---

## 14. Testing and acceptance

| Layer | What | How |
|---|---|---|
| Units | parsers/formatters, cost helpers, enum decoders | Vitest; property tests: parse(format(x)) == x for random bigints |
| Read model | decoders vs fixtures | `docs/app-state-fixtures.json` (accounts, markets, settlements with identities); reuse the risk-sdk read-model tests |
| Status chip | table in section 11 | one test per row |
| Contract flows | fund, place (rest/fill/IOC/reject/post-only), cancel, cancelAll, batch, release, withdraw, halt → claim, INVALID | Playwright against Anvil + `LocalFrontendDev` (13.1) with a test wallet |
| Receipt parsing | rejection with success status, id 0 paths, partial fills | Anvil scenarios with assertions on rendered toasts |
| Pinning | no panel mixes blocks | assert every panel's footer block equals its read block |
| Safety | no float math on amounts; no secret in bundle | lint rule banning `Number(`/`parseFloat` in `src/lib/tx` and `src/lib/units`; grep the build for `PRIVATE_KEY`/provider tokens |

Done when (from SP-01/SP-02): two different wallets can fund, trade, cancel and exit with balances
matching the contract views at named blocks; rejection, stale preview, wrong owner/chain and
duplicate receipt callbacks are handled; claims enable only from `claimsEnabled`; history matches
pinned reads after partial fills, epoch cancels, releases, finality, claims and a simulated reorg.

---

## 15. Build order

1. **Foundation**: `apps/web` scaffold, chain config, manifest loader/validator, ABI codegen,
   units module + tests, wallet connect, wrong-network blocker, banners.
2. **Read-only market**: market list, header/status chip, account panel, ladder, settlement card,
   all against testnet read-only (13.2). This works today.
3. **Local trading env**: `LocalFrontendDev.s.sol` + index feeder (13.1).
4. **Write flows**: fund, ticket with preview, place/cancel/cancelAll/batch, release/withdraw,
   receipt parsing, tx tray.
5. **Lifecycle**: time-travel dev panel, keeper console, halt → prepare → claim, INVALID path.
6. **Oracle pages**: resolution card, Disputes Live list/detail, dispute/propose, TestUSDC faucet.
7. **Indexer**: engine/vault entities, history tabs, candles, portfolio history.
8. **LP**: reserve seed/notice/redeem.
9. **Hardening**: Playwright suite, error mapping, reorg handling, indexer lag, accessibility.
10. **Integration**: switch the manifest to factory-created oracle markets when RF-LIVE completes.

---

## 16. Open dependencies and questions

| Item | Owner | Impact on the frontend |
|---|---|---|
| Operator access to activate the fixture market and mint test collateral | Risk operator (controller `0x7676…da46`) | No testnet trading until done |
| Independent INDEX publisher (continuous, < 30 s cadence) | Pricefeed / oracle owners | Index stays unavailable; all orders rejected |
| Factory switch and first real-oracle market (RF-LIVE) | Oracle governance (Timelock/lister keys) | Resolution card stays manual-authority for the fixture |
| Envio engine/vault indexing (SP-02) | Frontend/indexer | No trade history, candles or portfolio history before it |
| Faucet policy for test collateral | Operator | Decide out-of-band mint vs a guarded server faucet |
| Question/rules text for the fixture market | Operator | Manifest shows a generic fixture title |
| Multicall3 on Monad testnet, Next.js consumption of TS-only SDK | Frontend | Verify early (sections 4 and 3) |

---

## Appendix A. Addresses (Monad testnet, 10143)

Risk deployment of 2026-10-04 (`addresses.md`): verified, **not activated**.

| Contract | Address |
|---|---|
| BookRiskEngine (book + risk) | `0x58c63bfd94c13acb6f1da665406cc16cf80d1b69` |
| CollateralVault | `0xa8341d0343bc71b0f28e82dba2302c528608898d` |
| ReserveVault | `0xb4a8ff669f119aa5cad85c767dcbb2bf55813f04` |
| TestnetRiskCollateral (6 dp, controller mint) | `0x99f93e9bfe3b2dd75fe27327789bd0a9236ff7b0` |
| TestnetResolutionAuthority (manual) | `0x096545047a7a3a2453a417e21072c8b459d40c7c` |
| Controller / governance / monitor / index signer | `0x76765dc99c2c9aed0b2c23b39960f0de0ac5da46` |
| Market ID | `0x75be8f1f39e85b942a81e019e98ae380c65da9a1fc2e90b531fddbe9ad96870a` |
| Scheduled T | `1791920376` = 2026-10-13 19:39:36 UTC |

Oracle deployment (`oracle/deployments/monad-testnet.json`, deploy block 67,901,624):

| Contract | Address |
|---|---|
| ResolutionOracle | `0xa87D6E10a7199666ec9F2e04866201E35AAf36A6` |
| MarketRegistry | `0xEC11cC8fAfd47a1a92A7c9B43EEdee86a94B3DFa` |
| BondTreasury | `0xA1AC1491dDc4DA8E72B69c12C01653dB62eEeB2a` |
| UmaAdapter | `0x1387bC4d10acd2aFB0C85b6f62a51Ad91600C3A1` |
| KeeperRouter | `0xa04109FfD14C8E2c8303b3F1047Eeb14D78a67A9` |
| Timelock | `0xC2095b3DfD54328E59150bb70a3B541e21772F56` |
| OOv3 (sandbox) | `0xdE3B884250333652aC2Bf27fE10A6483a50B0a26` |
| TestUSDC (bond token, open faucet) | `0xFE854aEB0e1B5B568291f52696E5726c89a8d39e` |
| StubMarketFactory (testnet only) | `0xF58833b3b45ca45b5C10F396e39e675678751943` |
| First oracle market (on a stub engine) | `0xbb40e8e0ece7adae065af4f5a16f87abe4a912db0ada1696171ac7ef6b3be5ea` |

The older closed smoke market (`0x4ae7…7de72`) is historical; never load it as a live market.

## Appendix B. Source documents

| Topic | File |
|---|---|
| Engine handoff: entry points, units, events, views | `docs/risk/HANDOFF.md` |
| Economic rules, stages, views | `docs/spec/risk_spec.md` §§1–5 |
| Book behavior | `contracts/README.md`, `docs/spec/book_interface.md` |
| Oracle state machine, Disputes Live | `docs_oracle/eros-oracle-implementation-plan.md` §§5, 9 |
| Product integration rules (SP-00..SP-04) | `SPONSOR_INTEGRATION_PLAN.md` §§4–5 |
| Factory and live-integration status | `docs/integration/REAL_FACTORY_INTEGRATION.md` |
| Current status | `docs/merge/STATUS.md` |
| Lifecycle operations | `docs/runbooks/lifecycle.md` |
| INDEX observation format | `packages/pricefeed/README.md` "Risk output contract" |
