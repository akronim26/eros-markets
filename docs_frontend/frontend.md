
# Eros Markets frontend: complete build guide

Written 2026-10-05 against `feat/pricefeed` @ `273bc6e` (contains `integration/risk` @ `e2b48c5`).
This is the single guide for building the Eros Markets web app on top of the existing contracts,
SDKs and indexer. It says what to build, which contract function backs every button and number,
how the leveraged risk engine works from a trader's point of view, and which rules the UI must
never break. Re-verify anything marked **verify** before relying on it.

Nothing in this guide authorizes a deployment, a mainnet release, a gate acceptance, enabling
leverage on a market, or use of an operator key. The frontend is a client of contracts that
already exist; it adds no economics.

Contents: 0 read first · 1 product · 2 system map · 3 stack · 4 networks · 5 configuration ·
6 units · 7 contract surface · **8 the leveraged engine** · **9 market capabilities** · 10 read
model · 11 write flows · 12 screens · 13 status chip · 14 indexer · 15 environments · 16 testing ·
17 build order · 18 open dependencies · **19 wallet layer: Privy** · appendices.

---

## 0. Read this first

### 0.1 What exists and what does not

| Piece | State today | Where |
|---|---|---|
| Order book + risk engine (`BookRiskEngine`, one contract per market) | Deployed on Monad testnet, verified, **not activated**, no collateral minted, no INDEX feed | `contracts/src/engine/BookRiskEngine.sol`, address in `addresses.md` |
| **Leverage, margin kernel, funding, jump premium, grace, liquidation (pair / book / takeover), reserve coverage** | **Implemented and tested** in the risk engine (`contracts/src/risk/`, `contracts/src/math/`), exercised by leveraged test compositions with a 5x cap. **Not enabled in any deployable engine**: the `BookRiskEngine` constructor reverts `UnsafeInitialConfiguration` unless `deploymentCapX == 1`, `fundingEnabled == false` and `maxLiqLotsPerBlock == 0` | `contracts/test/integration/RealBookIntegration.t.sol` (`RealBookEngine`, cap 5, funding on), `docs/spec/risk_spec.md` §§3–6 |
| Collateral vault, reserve vault, test collateral, manual resolution authority | Deployed with the engine | `addresses.md` |
| Resolution oracle stack (ResolutionOracle, MarketRegistry, BondTreasury, UmaAdapter, KeeperRouter, Timelock) | Deployed and configured; first market listed **on a stub engine** | `oracle/`, `oracle/deployments/monad-testnet.json` |
| Real factory joining registry and real engine (`RegistryBookRiskEngine`) | Implemented and tested locally; **not deployed** (RF-LIVE blocked on operator access and the INDEX publisher). Also 1x | `oracle/src/integration/`, `docs/integration/REAL_FACTORY_INTEGRATION.md` |
| Risk read SDK (`@eros/risk-sdk`) | Read-only decoders | `packages/risk-sdk/` |
| Oracle SDK (`@eros-oracle/oracle-sdk`) | ABIs, EIP-712, bond maths, indexer GraphQL queries | `oracle/packages/oracle-sdk/` |
| Envio indexer | **Oracle events only** | `oracle/indexer/` |
| Independent INDEX price publisher | **Unfinished.** A diagnostic Polymarket feed exists but is not the engine's INDEX | `packages/pricefeed/` |
| Product frontend | **Does not exist on any branch.** The committee console is a CLI | this guide |

Consequences for the frontend:

1. **Build the full leveraged product, gated by capability.** Every leverage widget (leverage
   meter, margin bar, liquidation estimate, funding, premium, grace, liquidation console) is built
   now and shown only when the market's on-chain capabilities enable it (section 9). The same code
   then serves today's 1x markets and future leveraged ones without a rewrite.
2. Develop leveraged flows on a **local leveraged chain** (section 15.2). Develop 1x flows on the
   local 1x chain (15.1) or read-only against testnet (15.3).
3. The deployed testnet market shows "not activated" and "no price"; trading needs an operator
   (15.4). Enabling leverage anywhere needs a new engine composition, a calibrated profile and the
   release gates in risk spec §5 "Funding rate and activation gates"; the frontend cannot do it.
4. Keep the app multi-market and manifest-driven, so factory-created and future leveraged markets
   drop in without code changes.

### 0.2 Non-negotiable rules (every screen, every PR)

From the risk spec, `docs/risk/HANDOFF.md` §9, `SPONSOR_INTEGRATION_PLAN.md` §4 and the oracle plan
§9.5. Treat a violation as a bug.

| # | Rule | Why |
|---|---|---|
| R1 | **Exact integer units only.** `bigint` for every atom, Q, lot, tick, WAD, rate, timestamp. No `Number`/floats for amounts. Parse input as decimal strings. | Contracts are exact |
| R2 | **Contracts are authoritative.** No client ledger. Balances, margin, health and eligibility come from views or `AccountBalance`/`MarketBalance` events. SDK/UI computations are labelled estimates. | Spec: SDKs cannot keep an alternative authoritative balance |
| R3 | **Read one coherent block.** One pinned `blockNumber` per panel; label it. | Mixed-block reads show impossible states |
| R4 | **Unavailable is not zero.** Unavailable index/mark/IM/MM/settlement price shows "unavailable", never `0`. | `markAvailable=false` with `markWad=0` is not price 0 |
| R5 | **Only `claimsEnabled` enables a payout button.** Use `isClaimable()`. Oracle Final is not "paid". | Spec §8.6, DEC-07 |
| R6 | **The user's wallet is the account.** No shared backend wallet or relayer trading for users. Privy delegated signing is allowed only because it sends **from the user's own wallet** under the policies in section 19.4. | The sender owns the account |
| R7 | **Preview, simulate, send.** `previewOrder`/`previewRelease` for tickets, `simulateContract` before every write. | Previews are valid only for their block |
| R8 | **Parse receipts.** `placeOrder` can succeed with id `0` (rejected, IOC, full fill). Fills, rejections, liquidations come from logs. | Section 11.4 |
| R9 | **Explicit gas limits on Monad**: estimate × 1.10. | Monad charges the gas **limit** |
| R10 | **No secrets in the browser.** Public addresses, chain IDs, public RPC URLs, public app IDs only. | Bundles are public |
| R11 | **Disclose testnet stand-ins**: test collateral, manual resolution authority, sandbox DVM, single-node CRE simulator, uncalibrated profile, fixture leverage on dev chains. | Oracle plan §9.5 |
| R12 | **Show the worst-case lock** (`voidSecs`) on every market. | Oracle plan §14.2 |
| R13 | **Capability-driven, never hardcoded.** Never assume 1x or 5x, funding on/off, fees zero, or liquidation enabled. Derive from chain (section 9). | The same UI serves different listings |
| R14 | **Leveraged users must see the end-of-market rules.** From T−12h30m new exposure must be fully backed; at T−12h any account with a negative outcome value is **taken over** (whole position and cash move to the reserve; payout zero). Show countdowns and blocking warnings. | Risk spec §5, DEC-04 |
| R15 | **No invented liquidation price.** Only show one from the exact kernel (section 10.6), labelled as an estimate with its assumptions; fully backed accounts show "not liquidatable by price". | MM depends on size, time-to-T and the profile |

---

## 1. The product

Eros Markets lists **binary event perpetuals**: each market is a YES/NO question resolving at or
after a scheduled time `T`. A **claim** pays 1 USDC if YES, 0 if NO; INVALID pays a captured
price between 0 and 1. Traders buy and sell claims on a fully on-chain limit order book, priced as
probabilities in **ticks** 1..999 (tick 600 = 0.600).

- **Long** (`positionLots > 0`) profits on YES; **short** (`< 0`) profits on NO.
- Size in **lots**: 1 lot = 0.001 claim. Collateral in **atoms** (1e-6 USDC). Internal cash in
  **Q** = atom × 1e18.
- An account is just `(cashQ, positionLots)` per market, isolated per market. Its value if NO is
  `E0 = cash`; if YES `E1 = cash + 1000·Q·lots`; at mark q, `E(q) = cash + 1000·lots·qWad`.

### 1.1 Fully backed versus leveraged

**Fully backed (1x)** means both outcome values are non-negative: the trader can never owe more
than they deposited. Buying `L` lots at tick `t` costs `L × t` atoms; selling costs
`L × (1000 − t)` atoms.

**Leveraged** means the account may have a negative value in one outcome. That **deficit** is
covered by the market's **reserve** (LP capital), and the trader pays the reserve an insurance
**jump premium** for it. Example from risk spec §5 "Executable direct 5x entry fixture":

| | Alice (long) | Bob (short) | Reserve |
|---|---:|---:|---:|
| Deposit | 120 | 100 | 100,000 seed |
| Trade | buys 1,000 claims at 0.60 | sells 1,000 claims at 0.60 | — |
| Cash after fill | −480 | 700 | 100,000 |
| Equity at mark 0.60 | 120 | 100 | |
| Value if NO / if YES | −480 / 520 | 700 / −300 | |
| Deficit NO / YES | 480 / 0 | 0 / 300 | covers one outcome |
| Leverage (exposure / equity) | 600 / 120 = **5x** | 400 / 100 = 4x | |
| Payout NO / YES / INVALID@0.5 | 0 / 520 / 20 | 700 / 0 / 200 | residual 99,520 / 99,700 / 100,000 |

A leveraged long **has negative cash**; that is normal, not an error. Losses beyond collateral
never become a debt the user must repay: they are capped at zero payout and absorbed by the reserve.
The cost of that protection is the premium, margin requirements, liquidation risk and the final-day
takeover rule.

### 1.2 Market lifecycle

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
- **PricingMode**: `BOOTSTRAP` (no normal mark; only exactly backed orders inside the index band;
  no leverage, funding or mark liquidation) or `NORMAL_PRICING`.
- **AccountingState**: `READY`, or a sweep (`ROLLOVER_SWEEP` hourly, `FLOOR_SWEEP`, `HALT_SWEEP`)
  during which trading and releases pause.
- **Settlement phase**: `LIVE → HALTED → PREPARING → READY → COMPLETE`.

| Stage | Starts | Leveraged accounts | All users |
|---|---|---|---|
| TRADING | before T−12h30m | leverage up to the directional cap; funding and premium run | risk-checked trading, resting orders, releases |
| BACKING_GRACE | T−12h30m | **must top up or reduce to full backing before T−12h** (unless below MM) | new exposure must be fully backed |
| BACKING_FLOOR | T−12h | **accounts with E0<0 or E1<0 are taken over** by the floor sweep; funding frozen | old orders invalidated; only fully backed new commitments |
| REDUCE_ONLY | T−1h, or monitor restriction | reduce, top up | no new exposure; guarded excess-collateral release |
| HALTED | T or accepted early halt | frozen | keepers prepare settlement |
| CLAIMS_READY | finality + price + allocation | claim once | claim once |

---

## 2. System map

```
                         ┌──────────────────────────── Browser app (apps/web) ───────────────────────────┐
                         │  Privy embedded wallet (wagmi) ── tx builder (preview → simulate → send → logs)│
                         │  read model: pinned multicall reads + risk-sdk decoders + indexer GraphQL     │
                         │  margin lens: deployless eth_call into the exact kernel (estimates only)      │
                         └───────┬───────────────────────┬─────────────────────────────┬────────────────┘
                                 │ JSON-RPC              │ GraphQL (history)           │ HTTPS (server routes)
                                 ▼                       ▼                             ▼
  ┌─────────────── Monad testnet (10143) ───────────┐  Envio HyperIndex        Next.js route handlers
  │ Collateral token (ERC-20, 6 dp)                 │  oracle events today;    /api/trade (Privy delegated
  │ CollateralVault  ── deposit/allocate/withdraw   │  extend with engine +    signing, 19.5), RPC proxy
  │ Engine per market ── book + risk + settlement   │  vault events (§14)
  │   └─ ReserveVault (LP shares, created by engine)│
  │ Resolution authority (manual fixture / oracle)  │
  │ ResolutionOracle ─ MarketRegistry ─ BondTreasury│
  │ UmaAdapter ─ OOv3 (sandbox) ─ TestUSDC (faucet) │
  └─────────────────────────────────────────────────┘
   Privy: auth, embedded wallets, policy-restricted delegated signing; services/automation (19.6)
   signs stop-loss / risk-guard orders from users' own wallets through Privy.
   Off-chain, never called by the browser: INDEX publisher (signs observations), risk keepers
   (rollover, sampler, liquidation, floor sweep, settlement prep), oracle keeper, watchdog, panel
   runner, committee console, CRE workflow, market-ops relay.
```

There is **no separate order-book address**: the book is inside each engine.

---

## 3. Stack and repository layout

| Concern | Choice | Reason |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript strict | SSR shell, server route handlers |
| Chain client | **viem 2.57.2** (same pin as the oracle SDK) | Identical encoding/EIP-712 |
| Wallet | **Privy** (`@privy-io/react-auth` + `@privy-io/wagmi`) over wagmi 2.x | Chosen sponsor wallet (B14); embedded wallets, delegated signing, policies (section 19) |
| Server state | TanStack Query | Block-keyed caching and polling |
| UI | Tailwind + shadcn/ui; lightweight-charts or Recharts | Dark trading UI |
| Runtime | Node 22 | Matches the oracle workspace |
| Tests | Vitest + Playwright against Anvil | Section 16 |

```
apps/web/                         NEW  the Next.js app
  src/abi/                        NEW  generated `as const` ABIs (section 7.1)
  src/config/                     NEW  chain, manifest loader + validator (section 5)
  src/lib/units.ts                NEW  parse/format helpers (section 6)
  src/lib/capabilities.ts         NEW  per-market feature detection (section 9)
  src/lib/reads/                  NEW  pinned snapshot readers per screen (section 10)
  src/lib/margin/                 NEW  margin-lens client, leverage/liquidation estimates (10.6)
  src/lib/tx/                     NEW  one module per write flow (section 11)
  src/lib/indexer/                NEW  GraphQL client + queries (section 14)
  src/app/api/trade/              NEW  Privy delegated one-click trading route (19.5)
services/automation/              NEW  stop-loss / take-profit / risk-guard worker via Privy (19.6)
  src/app/...                     NEW  screens (section 12)
  public/deployments/*.json       NEW  deployment manifests (5.2)
  public/markets/*.json           NEW  market manifests (5.3)
contracts/src/lens/MarginLens.sol NEW  pure wrapper over MarginMath for deployless calls (10.6)
packages/risk-sdk/                existing; extend in place, do not fork
oracle/packages/oracle-sdk/       existing; browser-safe modules only (7.3)
```

Consuming the risk SDK: it ships TypeScript sources only (no `main`, no build). Use a tsconfig path
alias (`"@eros/risk-sdk": ["../../packages/risk-sdk/src/index.ts"]`) and let Next.js compile files
outside the app (`transpilePackages` or `experimental.externalDir`, depending on version: **verify**
with a build). Add new decoders to the SDK and rerun `npm test --prefix packages/risk-sdk`.

---

## 4. Networks and chain facts

| Item | Value |
|---|---|
| Chain | Monad testnet, chain ID **10143**, native **MON** |
| Public RPC | `https://testnet-rpc.monad.xyz` (rate-limited; `eth_getLogs` capped at **100 blocks**) |
| Explorer | `https://testnet.monadscan.com` |
| Envio HyperSync | `https://monad-testnet.hypersync.xyz` |
| Multicall3 | viem's `monadTestnet` definition carries one; **verify** code at startup, fall back to single pinned reads |
| Gas | Monad charges the **limit**: `estimateGas × 1.10` (R9) |
| Finality | `pending` → `included` (receipt) → `final` (≤ `finalized` tag) |
| Local dev | Anvil 1.8.3, chain **31337**, run with `--disable-code-size-limit` (the engine runtime is ~120 KB, above Ethereum's 24 KB; Monad allows 128 KB) |

Use viem's `monadTestnet`; override `rpcUrls` from config. Block on wrong `chainId`.

---

## 5. Configuration

### 5.1 Environment (`apps/web/.env.local`, git-ignored by the root `.env.*` rule)

```dotenv
NEXT_PUBLIC_CHAIN_ID=10143
NEXT_PUBLIC_RPC_URL=https://testnet-rpc.monad.xyz
NEXT_PUBLIC_EXPLORER_URL=https://testnet.monadscan.com
NEXT_PUBLIC_DEPLOYMENT=monad-testnet          # selects public/deployments/<name>.json
NEXT_PUBLIC_INDEXER_URL=                       # blank = RPC-only mode
RPC_URL_SERVER=                                # server-only private RPC for an /api/rpc proxy
# Privy variables: section 19.8
```

### 5.2 Deployment manifest (`public/deployments/<name>.json`)

Generated from `addresses.md` and `oracle/deployments/monad-testnet.json`, validated with zod at
startup (SP-00: refuse a wrong chain ID, bad address, or missing code).

```jsonc
{
  "chainId": 10143,
  "risk": {
    "collateralVault": "0xa8341d0343bc71b0f28e82dba2302c528608898d",
    "collateralToken": "0x99f93e9bfe3b2dd75fe27327789bd0a9236ff7b0",   // 6 dp, controller-mint only
    "abiDigest": "40e05c0e8034dcdba2a14fc19a97f2323412e69f92dc2146cac913ef8695cbb3"
  },
  "oracle": {
    "resolutionOracle": "0xa87D6E10a7199666ec9F2e04866201E35AAf36A6",
    "marketRegistry":   "0xEC11cC8fAfd47a1a92A7c9B43EEdee86a94B3DFa",
    "bondTreasury":     "0xA1AC1491dDc4DA8E72B69c12C01653dB62eEeB2a",
    "umaAdapter":       "0x1387bC4d10acd2aFB0C85b6f62a51Ad91600C3A1",
    "keeperRouter":     "0xa04109FfD14C8E2c8303b3F1047Eeb14D78a67A9",
    "oov3":             "0xdE3B884250333652aC2Bf27fE10A6483a50B0a26",
    "bondToken":        "0xFE854aEB0e1B5B568291f52696E5726c89a8d39e",
    "deployBlock": 67901624
  },
  "marginLens": null,                       // bytecode hash of MarginLens if bundled (10.6)
  "markets": ["/markets/risk-fixture-2026-10-04.json"]
}
```

### 5.3 Market manifest (one per market)

The engine stores hashes, not text, and exposes the risk profile only as `activeProfile().profileHash`.
The manifest supplies human text and the **full risk profile**, which the app verifies on chain.

```jsonc
{
  "engine": "0x58c63bfd94c13acb6f1da665406cc16cf80d1b69",
  "engineKind": "BookRiskEngine",          // or "RegistryBookRiskEngine", or a future leveraged composition
  "marketId": "0x75be8f1f39e85b942a81e019e98ae380c65da9a1fc2e90b531fddbe9ad96870a",
  "listingHash": "0x46a5cee0c75458e355018cde6e76ec94bb529c91489ed152c56ee2a4d597c95f",
  "deployBlock": 67915021,
  "title": "Testnet fixture market (no real-world question)",
  "oracleMarketId": null,
  "resolution": "MANUAL_TEST_AUTHORITY",   // or "ORACLE"
  "fixture": true,
  "role": "demo",                           // "demo" | "terminal-test"
  "riskProfile": null                       // MarginMath.RiskParams as JSON strings (below); null = unknown
}
```

`riskProfile` shape (all integers as decimal strings; mirrors `MarginMath.RiskParams`):
`h0Secs, absorptionClaimsPerMin, queueSecs, hazard0WadPerDay, hazard1WadPerDay, epsilonWad,
gammaWad, sWad, lambdaWadPerClaim, template, calibrated, deploymentCapX,
realized {hSecs[], sigmaWad[], validFrom, validUntil}, templateEnv {…}`.

Load-time checks (refuse the manifest on any mismatch):
1. `engine.listing().marketId` and `engine.listingHash()` equal the manifest.
2. If `riskProfile` is set: `engine.profileHashOf(riskProfile) == engine.activeProfile().profileHash`
   (`profileHashOf` is a public pure function). Without a verified profile, all margin estimates
   (10.6) are disabled; contract views still work.
3. For `resolution: "ORACLE"`: `MarketRegistry.getMarketCore(oracleMarketId).engine == engine`.

---

## 6. Units and formatting (`src/lib/units.ts`)

| Field family | Unit | Display |
|---|---|---|
| `*Atoms`, vault balances, `usableReleaseAtoms`, `claimableAtoms` | 1e-6 USDC | `formatAtoms()` |
| `*Q` (`cashQ`, `e0Q`, `e1Q`, `markEquityQ`, `mmQ`, `imQ`, fees, deficits, premium, funding) | atom × 1e18 | `qToMoney(q).usdc` (floors toward −∞) |
| lots | 0.001 claim | `lotsToClaims()` |
| tick | tick/1000 | `"0.600"` |
| `*Wad` (`indexWad`, `markWad`, hazards/day, `settlementPriceE18`) | 1e18 = 1.0 | `wadToPrice()`; unavailable → "unavailable" |
| funding rate `epoch().rate` | Q per lot per second, signed | USDC per claim per day: `rate × 1000 × 86400 / 1e24` (exact bigint division for display) |
| funding index `fundingFQ` | Q per lot, cumulative | internal; show payments, not the index |
| hazard `*WadPerDay` | probability intensity per day | percent per day |
| times | Unix seconds | UTC + local + countdown |
| `expiryBlock` | block; 0 = none | "good until block N" |

Risk-sdk already exports `Q`, `ATOMS_PER_USDC`, `LOTS_PER_CLAIM`, `WAD`, `qToMoney`, `lotsToClaims`,
`wadToPrice`, `formatAtoms`. Add parsers and display helpers to the SDK:

```ts
export function parseUsdcToAtoms(s: string): bigint {            // max 6 decimals, reject otherwise
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s.trim());
  if (!m) throw new Error("amount: up to 6 decimals");
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}
export function parseClaimsToLots(s: string): bigint {           // max 3 decimals
  const m = /^(\d+)(?:\.(\d{0,3}))?$/.exec(s.trim());
  if (!m) throw new Error("size: up to 3 decimals (1 lot = 0.001 claim)");
  return BigInt(m[1]) * 1000n + BigInt((m[2] ?? "").padEnd(3, "0") || "0");
}
export function parsePriceToTick(s: string): number {
  const m = /^0?\.(\d{1,3})$/.exec(s.trim());
  const tick = m ? Number(m[1].padEnd(3, "0")) : 0;
  if (tick < 1 || tick > 999) throw new Error("price: 0.001 to 0.999");
  return tick;
}
// Fully backed cost at tick t (atoms); fees excluded, so show fees separately from previewOrder.feeCapQ.
export const buyBackedAtoms  = (lots: bigint, t: number) => lots * BigInt(t);
export const sellBackedAtoms = (lots: bigint, t: number) => lots * BigInt(1000 - t);
// Exposure the engine uses for leverage display (MarginMath.sideMargin worstQ): |x|·1000·w, w = q long, 1−q short.
export const exposureQ = (lots: bigint, qWad: bigint) =>
  (lots < 0n ? -lots : lots) * 1000n * (lots >= 0n ? qWad : 10n ** 18n - qWad);
// Display leverage, MarginMath.displayLeverageBps: floor(exposure·1e4 / equity); undefined when equity ≤ 0.
export const leverageBps = (expQ: bigint, equityQ: bigint) =>
  equityQ > 0n ? (expQ * 10_000n) / equityQ : undefined;
```

Mark equity is `cashQ + 1000n * positionLots * markWad`, already in Q: **do not divide by WAD
again**. Prefer the contract's `markEquityQ`.

---

## 7. Contract surface

### 7.1 ABIs and codegen

| Contract | ABI source | Notes |
|---|---|---|
| BookRiskEngine (deployed, 1x) | `artifacts/risk/book-risk-engine-abi.json` | 294 entries; JSON wraps `abi` |
| RegistryBookRiskEngine (factory, 1x) | `oracle/out/...` after `forge build` | adds `marketOiCapLots()` + 2 errors |
| Leveraged engine composition (future; today test-only `RealBookEngine`) | its compiler artifact | Expect the same public surface (risk + book + settlement); regenerate and diff, never assume |
| CollateralVault | `artifacts/risk/vault-abi.json` | 35 entries |
| ReserveVault | `contracts/out/ReserveVault.sol/ReserveVault.json` | `notice()`, `maxRedeem`, `shares`, `noticeAt`; error `Locked` |
| Collateral token | standard ERC-20 | 6 decimals |
| MarginLens (NEW, 10.6) | its compiler artifact (ABI + **bytecode**) | deployless calls only |
| Oracle | `oracle/abi/<Name>.json` | hash-checked by `oracle/abi/SHA256SUMS` |

`apps/web/scripts/gen-abis.ts` unwraps `abi` and emits `src/abi/<name>.ts` (`as const`); CI fails
when the output drifts (mirrors `scripts/export-risk-abis.py`).

### 7.2 Enums (values are ABI; never reorder)

Risk-sdk already has `Stage`, `PricingMode`, `AccountingState`, `HealthStatus`, `LiquidationMode`,
`FinalOutcome`, `ClearingPhase`, `ConversionReason`, `ClaimMode`. Add the rest to the SDK:

| Enum | Values |
|---|---|
| `Stage` | 0 TRADING, 1 BACKING_GRACE, 2 BACKING_FLOOR, 3 REDUCE_ONLY, 4 HALTED, 5 CLAIMS_READY |
| `PricingMode` | 0 BOOTSTRAP, 1 NORMAL_PRICING |
| `AccountingState` | 0 READY, 1 ROLLOVER_SWEEP, 2 FLOOR_SWEEP, 3 HALT_SWEEP |
| `HealthStatus` | 0 FLAT, 1 HEALTHY, 2 BELOW_IM, 3 BELOW_MM, 4 NONPOSITIVE |
| `Template` (`listing().template`) | 0 SCHEDULED, 1 CONTINUOUS, 2 DEADLINE, 3 UNSCHEDULED |
| `AdmissionMode` (`previewOrder.mode`) | 0 NORMAL, 1 VOLUNTARY_REDUCTION, 2 FORCED_REDUCTION |
| `OrderKind` | 0 LIMIT, 1 IOC, 2 POST_ONLY |
| `Side` (`previewOrder` arg) | 0 BUY, 1 SELL |
| `RejectCode` | 0 NONE, 1 HALTED, 2 BAD_STAGE, 3 OUTSIDE_BAND, 4 BELOW_MIN_SIZE, 5 NO_REDUCIBLE_POSITION, 6 MAKER_BELOW_IM, 7 MAKER_BELOW_MM, 8 TAKER_CAPACITY, 9 ACCOUNT_DEFICIT_CAP, 10 MARKET_COVERAGE, 11 INVALID_PRICE_OR_SIZE, 12 STALE_ORDER |
| `CancelReason` (`OrderCancelled`) | 0 USER, 1 SELF_TRADE, 2 FAILED_CHECK, 3 CLIPPED, 4 EXPIRED |
| `RemovalReason` (`OrdersInvalidated`) | 0 USER_CANCEL, 1 EXPIRED, 2 STALE_MARKET_EPOCH, 3 STALE_ACCOUNT_EPOCH, 4 STALE_REDUCE_VERSION, 5 SELF_TRADE, 6 FAILED_READMISSION, 7 FILLED, 8 REDUCE_ONLY_EXHAUSTED, 9 CROSSED_REMAINDER, 10 REPLACED |
| `LiquidationMode` | 0 NONE, 1 REDUCE, 2 TAKEOVER |
| `LiquidationMath.Result` (`liquidate` result, `LiquidationOutcome.result`) | 0 NOT_ELIGIBLE, 1 DONE, 2 NEEDS_MORE_WORK, 3 TAKEOVER_AUTHORIZED, 4 DISABLED |
| `takeoverPredicate` | 0 none, 1 FRESH_NONPOSITIVE (mark equity ≤ 0), 2 FLOOR_DEFICIT (backing floor, an endpoint < 0), 3 BOTH_ENDPOINTS (E0 ≤ 0 and E1 ≤ 0) |
| `ClearingPhase` | 0 LIVE, 1 HALTED, 2 PREPARING, 3 READY, 4 COMPLETE |
| `FinalOutcome` (engine) | 0 UNSET, 1 NO, 2 YES, 3 INVALID |
| `ClaimsStatus` | 0 AWAITING_OUTCOME, 1 ORACLE_FINAL_PRICE_PENDING, 2 ORACLE_FINAL_PREPARING, 3 RECOVERY_REQUIRED, 4 CLAIMABLE |
| Order `flags` | 1 BUY, 2 REDUCE_ONLY, 4 LIVE |
| `pendingWork` bits | 1 FLOOR_SWEEP, 2 ROLLOVER_SWEEP, 4 HALT_SWEEP, 8 EPOCH_OPENING |

Oracle side (`oracle/src/types/OracleTypes.sol`): `Outcome` 0 NONE, 1 YES, 2 NO, 3 INVALID (**not**
the engine's `FinalOutcome`; never cast); `Path` 0 NONE, 1 L1, 2 L2_AUTO, 3 REVIEWED,
4 PERMISSIONLESS; `RState` 0 None, 1 EarlyCheck, 2 EarlyReview, 3 L1Pending, 4 L2Pending, 5 Review,
6 Open, 7 Proposed, 8 Disputed, 9 Voided, 10 Final; `FinalReason` 0 NONE, 1 ASSERTED_TRUE,
2 REJECTED_YES_AND_NO, 3 VOID_DEADLINE; `PanelLabel` 0 ABSTAIN, 1 YES, 2 NO, 3 INVALID, 4 NOT_YET.

`RejectCode` copy:

| Code | Message |
|---|---|
| HALTED | Market is halted; no new orders. |
| BAD_STAGE | Not allowed now (not activated, reduce-only, sweep running, or final-day restriction). |
| OUTSIDE_BAND | Price is outside the band around the index allowed while the market bootstraps. |
| BELOW_MIN_SIZE | Size is below the market minimum. |
| NO_REDUCIBLE_POSITION | Reduce-only, but there is no opposite position to reduce. |
| TAKER_CAPACITY | Not enough margin for this size. Reduce size or add collateral. (Shows `acceptedCapLots`.) |
| ACCOUNT_DEFICIT_CAP | Your worst-case loss beyond collateral would exceed the per-account cap (2% of the reserve base). |
| MARKET_COVERAGE | The market reserve cannot cover more leveraged exposure right now. |
| INVALID_PRICE_OR_SIZE | Price or size invalid for the current price state (e.g. no valid index or mark). |
| STALE_ORDER | Order became stale (epoch changed or expired). |
| MAKER_BELOW_IM / MAKER_BELOW_MM | A resting order failed margin re-check and was removed. |

Revert errors to translate (full list in the ABI): `BadTick`, `BadSize`, `BadMaxFills`,
`BadExpiry`, `PostOnlyCrosses`, `BatchActionLimit`, `BatchStepLimit`, `NotLive`, `NotOwner`,
`BookFull`, `Stale`, `Rejected`, `Coverage`, `BadState`, `NotHalted`, `PreparationIncomplete`,
`OutcomeOrPricePending`, `ConversionDisabled`, `RiskUnauthorized`, `Unauthorized`, `BadUnits`,
`HazardDecrease`, `ProfileHashMismatch`, `ProfileListingMismatch`, `ZeroWorkBudget`,
`BadWorkBudget`, `Reentrant`, `TransferFailed`, `Locked`. Decode with viem `decodeErrorResult`.

### 7.3 Oracle SDK: browser-safe imports

The oracle SDK root re-exports Node-only modules (`deployments.ts`, `abi/sources.ts` use `fs`).
Import `indexer.ts`, `bond.ts`, `claim.ts`, `eip712.ts` and ABI constants directly, or add a
`src/browser.ts` entry to the SDK.

---

## 8. The leveraged engine (the protocol core)

Everything here is implemented in `contracts/src/risk` and `contracts/src/math`. Spec references
are `docs/spec/risk_spec.md`. The UI explains and displays these mechanics; it never recomputes
them as an authority.

### 8.1 Account model and the reserve

Per market, each trader has signed `positionLots` and signed `cashQ`. Trades move cash and position
between the two counterparties exactly (`lots × tick × Q` each way). There is no entry price, no
borrowed balance, no separate collateral field: **collateral is the cash**, and leverage shows up
as negative cash on a long or a large negative YES value on a short.

The **reserve** is a ledger account funded by LPs before activation. It must always cover, for each
outcome y separately, the sum of all trader deficits plus the unspent funding budget:
`R_y ≥ D̄_y + B` (INV-04). `coverageSlacks()` returns the two slacks; when slack runs out, new
leveraged exposure is rejected (`MARKET_COVERAGE`). Per account, the worst endpoint deficit is capped
at **2% of `reserveCapBaseQ()`** (the reserve at activation): `ACCOUNT_DEFICIT_CAP`.

### 8.2 Margin kernel (MarginMath)

For a position of `|x|` claims at mark `q` (`w = q` long, `1−q` short), with `T−t` remaining:

- **Worst loss** `W = |x|·w` (in the engine `worstQ = |x|·1000·w` per lot).
- **MM** = `min(W, |x|·(m_side + k·σ_h + s) + ½·λ·x²)`, where `m_side` is a conservative adverse
  drift from the hazards, `k` a tail multiplier from `ε` and the adverse hazard, `σ_h` the volatility
  over the closeout horizon `h = h0 + |x|/v + queue` (max of theory `sqrt(q(1−q)h/(T−t))`, realized
  and template envelopes), `s` a spread/slippage term and `λ` a size-impact term.
- **IM** = `min(W, max(γ·MM, W / cap))`.
- **Full backing is forced** (IM = MM = W) when the directional cap is 1, the profile is
  uncalibrated, calibration is missing or expired, hazards leave the domain, or IM meets W.

Directional cap (`MarginMath.directionalCap`), then `min(cap, deploymentCapX)`; uncalibrated → 1:

| Template | Long | Short |
|---|---:|---:|
| SCHEDULED | 5 | 5 |
| CONTINUOUS | 3 | 3 |
| DEADLINE | 3 | 1 |
| UNSCHEDULED | 1 | 1 |

The model can impose a lower effective cap than this table, and it grows stricter with size (`λ`,
horizon) and as T approaches. Never display "5x" as a promise: display the cap as "up to", and the
actual admissible size from `previewOrder`.

Fixture seeds (`RiskFixture.profile`, test only, not calibration): `h0Secs=300`,
`absorptionClaimsPerMin=1000`, `queueSecs=0`, hazards `1e14` WAD/day (0.01%/day), `epsilon=1e16`
(1%), `gamma=1.5e18`, `s=5e15` (0.005), `lambda=1e12` WAD/claim, SCHEDULED.

### 8.3 Order admission with resting orders (spec §7 "Reservations and both-outcome admission")

Leverage is **not a per-order parameter**. An order is admitted if, counting every resting order
as possibly filled at its worst limit:

- `Emin = cash + x·m − (adverse marked-fill terms for bids above mark and asks below mark) − feeCap`
- `Emin ≥ IM_upper`, where `IM_upper` is IM at the largest reachable long and short sizes
  (`x + bidLots`, `x − askLots`), plus terminal-deficit, account-cap and market-coverage checks.

Consequences for the UI:
- A flat account bidding at the mark can open 5x directly (the bought inventory offsets the cash
  spent). Bidding far **above** mark consumes margin immediately (adverse fill term).
- **Resting orders consume margin** even unfilled. Show "margin used by open orders" from
  `previewAccount.orders` (`bidLots`, `bidValueQ`, `askLots`, `askValueQ`, `feeCapQ`, `maxBidTick`,
  `minAskTick`). Cancelling orders frees margin; `maxBidTick`/`minAskTick` can stay pessimistic until
  the account's order epoch resets (`cancelAll` resets it).
- `previewOrder` returns `acceptedCapLots` (largest admissible size found by halving,
  `halvingSteps`), `requiredImQ`, `eMinQ`, `d0AfterQ`/`d1AfterQ` (your deficit if NO/YES after the
  order), `marketCoverageAfter`, `fullBackingRequired`, `mode` and `feeCapQ`. Use these, not
  local maths, for the ticket.
- Reductions: an order that shrinks the position without flipping sign is admitted as
  `VOLUNTARY_REDUCTION` even below IM, if it does not worsen either endpoint deficit or the MM slack.
  **An order cannot flip a position through zero as a reduction**: close first (reduce-only), then
  open the other side as new exposure. The ticket must split or warn.
- Fees: configurable (zero in today's profile). `feeCapQ` is reserved per order; show it.

### 8.4 Health and grace

`previewAccount.status` / `accountRiskView.status`:

| Status | Meaning | UI |
|---|---|---|
| FLAT | no position | — |
| HEALTHY | equity ≥ IM (or fully backed) | green |
| BELOW_IM | MM ≤ equity < IM | amber: cannot add exposure or release; **1-hour grace** to top up or reduce, then reducible by keepers |
| BELOW_MM | equity < MM | red: **liquidatable now**, no grace |
| NONPOSITIVE | equity ≤ 0 | red: **takeover** (whole account to reserve) |

Grace: `GRACE_SECS = 3600`, anchored at the risk epoch the account first fell below IM, never
renewed by touching, capped at T−12h. Read `accountRiskView.graceActive`/`graceEndsAt` or
`graceState(trader)`; events `GraceStarted`, `GraceCleared`. Show a countdown.

Health uses the mark: when `markAvailable` is false, health shows "unavailable", mark liquidations
stop, and releases are blocked (only the price-free takeover routes remain, 8.5).

### 8.5 Liquidation (`liquidate(trader, maxLots, maxExaminations, partner)`)

Permissionless and bounded. Eligibility (`LiquidationMath.eligibility`, checked in order):

1. Backing floor active (from T−12h) and E0 < 0 or E1 < 0 → **TAKEOVER**.
2. E0 ≤ 0 and E1 ≤ 0 (not both zero) → **TAKEOVER** (price-free).
3. Mark stale → **NONE** (a stale mark never authorizes a mark liquidation).
4. Mark equity ≤ 0 → **TAKEOVER**.
5. Equity < MM → **REDUCE**.
6. Grace expired and equity < IM → **REDUCE**.

Routes inside one call:
- **Pair reduction**: if `partner != 0` is an opposite, eligible account, both reduce against each
  other at one tick `clamp(floor(qWad/1e15),1,999)`; `PairReduction` / `PairSkipped` events.
- **Book close**: a reduce-only IOC through the normal book, never below the account's bankruptcy
  tick, capped by `maxLots`, `maxExaminations ≤ maxFills()` and the per-block market budget
  `liquidationBlockBudget()` (`maxLiqLotsPerBlock`; **0 means book-close liquidation is disabled**,
  result `DISABLED`). `BookCloseAttempt` event.
- **Takeover**: the entire account (cash and position) moves to the reserve; the trader is zeroed
  and their orders invalidated. No fee. `AccountTakenOver` event. **The user's remaining claim in
  this market becomes zero.**

Result: `NOT_ELIGIBLE` (no effect, no reward), `DONE`, `NEEDS_MORE_WORK` (call again; lack of
liquidity never authorizes takeover of a positive-equity account), `TAKEOVER_AUTHORIZED`,
`DISABLED`. `LiquidationOutcome(trader, keeper, mode, result, takeoverPredicate, pairedLots,
bookLots, cutoff)`.

Liquidation fee: **one atom per lot closed** (0.001 USDC per claim) on executed book/pair
reductions, half to the reserve and half to the keeper (`keeperQ(keeper)`), waived if it would
breach the predicate; takeovers pay nothing. Keeper fees are withdrawable with `withdrawKeeper()`
after the settlement payout scan.

What the trader should see: their status, which route would apply, the grace deadline, and that
reductions happen at market against the book (they can pre-empt by reducing or topping up).

### 8.6 Funding (hourly epochs; spec §6 "Funding")

- At each epoch opening the engine fixes a rate for the epoch: daily per-claim funding
  `f = clamp(q − I, −0.05·min(I,1−I), +0.05·min(I,1−I))`, converted once to `rate` in Q/lot/second
  (`epoch().rate`). **Positive rate: longs pay shorts.** Each account pays `p = x·(F − F_i)`.
- A cash **budget** `B` is authorized at opening from reserve slack; funding stops early for the
  rest of the epoch on budget exhaustion, stale index, T−12h, OI reaching 0, or halt
  (`epoch().stopped`, `stop`). It never resumes within the epoch. Zero OI at opening disables the
  whole epoch.
- Funding is lazy: it is booked when an account is touched; `previewAccount.projectedFundingQ`
  shows the unbooked amount (positive = account pays) and is **already included** in
  `previewAccount.cashQ`. Never subtract it again.
- Epoch rollover (hourly) pauses trading and releases until keepers finish `beginRollover`,
  `rollPage(32)…`, `finishRollover` (`AccountingState.ROLLOVER_SWEEP`).
- Disabled when `fundingFeatureEnabled()` is false (today) and in BOOTSTRAP.

Views/events: `epoch()`, `fundingFQ()`, `fundingBudgetQ()`, `fundingCushionQ()`,
`fundingClearingQ()`, `freshness()`, `EpochOpened(epoch, start, end, rateQPerLotSec, budgetQ)`,
`FundingAdvanced`, `AccountSynced(owner, fundingPaymentQ, premiumQ, cutoff)`, `FreshnessGap`.

### 8.7 Jump premium (spec §6 "Premium")

Leveraged accounts pay the reserve for covering their deficit:
`premium = ∫ (1 + load) · hazard_y · multiplier · principalDeficit_y dt`, summed over the outcome(s)
where the account has a deficit (a long's deficit is in NO, y=0; a short's in YES, y=1).

- `tariff()` → `hazard0WadPerDay`, `hazard1WadPerDay`, `loadWad` (load 1 in the fixture profile, so
  2× hazard). The tariff for an epoch is fixed at its opening; monitor hazard raises
  (`raiseHazards`, `HazardRaiseRequested`) take effect at the next epoch.
- **New-deficit surcharge**: multiplier **4×** until `account(owner).surchargeUntil` (6 hours after a
  new deficit is created), then 1×.
- Non-compounding within an epoch; capitalized at rollover. Booked on touch;
  `previewAccount.projectedPremiumQ` is the unbooked part, **already included** in `cashQ`.
- Fully backed accounts pay no premium.

Display: "Insurance premium ≈ X USDC/day" with `X = deficit × (1+load) × hazard × multiplier`
(display estimate), the surcharge countdown, and premium paid this epoch
(`account(owner).premiumPaid`).

### 8.8 Prices: index, perp, mark (spec §4)

- **Index I**: independent source, signed observations, 300 s time-weighted impact-mid TWAP at depth
  N (`indexTwap300`). Stale after 30 s per sample; a gap makes the window unavailable.
- **Perp**: the book's own impact mid, sampled by keepers (`samplePerp`, `PerpObservationRecorded`),
  60 s TWAP (`perpTwap60`); **basis** = perp − index, 900 s TWAP (`basisTwap900`).
- **Mark** = median(I + basisTWAP, perpTWAP60, live perp impact mid), clamped to
  `I ± b(t)`, `b(t) = 0.05 · (T−t)/(T−listedAt)`. All three must be valid; otherwise the mark is
  unavailable and only bootstrap (fully backed, index band) trading works.
- A move above 0.10 in 300 s triggers REDUCE_ONLY (`MovementRestriction`).
- BOOTSTRAP → NORMAL_PRICING only at a completed epoch opening with all windows valid
  (`PricingModeChanged`).

### 8.9 Release with a leveraged position

`release(atoms)` requires the account to stay ≥ IM (order-aware) at a usable mark, plus final-day
backing and market coverage. Only `previewAccount.usableReleaseAtoms` is the releasable amount.
During REDUCE_ONLY a guarded excess-collateral release is still allowed (RB-I08).

### 8.10 Disabled extensions

Token conversion (`selectConversionMode` reverts, DEC-10), recovery haircut
(`recoveryEnabled() == false`; `RECOVERY_REQUIRED` keeps claims disabled), live reserve
issuance/redemption (DEC-06). Show nothing for them except the recovery status.

---

## 9. Market capabilities (feature detection)

Read once per market (and on `RiskProfileActivated`), then gate UI features. `src/lib/capabilities.ts`:

| Capability | Read | Enables |
|---|---|---|
| `maxLeverageLong/Short` | `listing().template`, `listing().deploymentCapX`, verified `riskProfile.calibrated` → `directionalCap` table (8.2) | leverage meter, target-leverage slider, liquidation widgets (only if > 1) |
| `funding` | `fundingFeatureEnabled()` (and `listing().fundingEnabled`) | funding panel, projected funding |
| `premium` | `tariff()` hazards > 0 **and** leverage > 1 | premium panel |
| `bookLiquidation` | `liquidationBlockBudget().cap > 0` (`listing().maxLiqLotsPerBlock`) | book-close liquidation in keeper console |
| `fees` | `previewOrder.feeCapQ`, `Fill` fees | fee lines (never assume zero) |
| `recovery` | `recoveryEnabled()` | recovery explanation |
| `oiCap` | `marketOiCapLots()` (factory engines only; may not exist) | OI capacity bar |
| `marginLens` | verified `riskProfile` + lens bytecode available | liquidation-price and what-if estimates |
| `pricing` | `marketRiskView().pricingMode`, `indexAvailable`, `markAvailable` | ticket mode (bootstrap band vs leveraged) |

Today's deployed market: leverage 1, funding off, book liquidation off, fees 0, recovery off. The
UI must render this as a clean fully backed market with leverage widgets hidden, not disabled
widgets showing zeros.

---

## 10. Read model

### 10.1 Block-pinned snapshots

```ts
const block = await client.getBlockNumber();
const results = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [...] });
return { block, chainId, engine, ...decode(results) };
```

Populate the SDK's `ViewIdentity`/`ReadIdentity` from the same read (`asOfTime`, `riskVersion`,
`profileHash`, mark availability from `previewAccount.id`). Show block provenance in Market info's
contract details, rather than in the primary trading workspace. Active market:
refetch each new block (throttle ~1 s); others every 10–30 s.

### 10.2 Market header and risk dashboard

One multicall: `active()`, `halted()`, `priceReady()`, `currentStage()`, `marketRiskView()`,
`getSettlementStatus()`, `listing()`, `scheduledT()`, `bestBidAsk()`, `touch()`, `bookDepth()`,
`oiAllLots()`, `participantCount()`, `epoch()`, `freshness()`, `tariff()`, `activeProfile()`,
`fundingFeatureEnabled()`, `fundingBudgetQ()`, `reserve()`, `reserveCapBaseQ()`, `coverageSlacks()`,
`deficitSum0()`, `deficitSum1()`, `liquidationBlockBudget()`, `floorProgress()`, `invalidWindow()`,
`maxFills()`, `maxBatchActions()`.

`marketRiskView()` → `{asOfTime, stage, pricingMode, accountingState, indexAvailable, indexWad,
markAvailable, markWad, riskVersion, profileHash, secsToT, monitorRestricted, fundingFreshThrough,
floorStatus, floorCursor, floorCount, liquidationCapLots, liquidationRemainingLots, pendingWork}`.
Extend the SDK's `MarketRiskViewRaw` with the newer fields.

Market risk dashboard (leveraged markets): OI (`oiAllLots` as claims), reserve cash and position,
coverage slack per outcome (`coverageSlacks`, labelled "conservative slack, not LP NAV"), trader
deficit sums, per-account deficit cap (`reserveCapBaseQ × 2%`), funding rate/budget/stopped,
tariff, liquidation budget remaining this block, floor sweep progress.

The compact terminal header shows the event and status, YES mark/index, open interest,
current leverage limits and close time. Risk and reserve diagnostics are available through
the Market details selector; source history and resting bid/ask prices stay in the chart and book.

### 10.3 Account panel

1. `participantId(owner)` (0 = not registered; first `allocate` registers).
2. `previewAccount(traderId)` → `{id, cashQ, positionLots, projectedFundingQ, projectedPremiumQ,
   projectionsAreEstimates, e0Q, e1Q, markEquityQ, mmQ, imQ, fullBackingRequired, status, orders,
   usableReleaseAtoms}`.
3. `accountRiskView(traderId)` → `graceActive`, `graceEndsAt`, `liquidationMode`,
   `takeoverPredicate`, `orders` (+ `maxBidTick`, `minAskTick`).
4. `account(owner)` → stored `orderEpoch`, `surchargeUntil`, `premiumPaid`, `deficit0`, `deficit1`,
   `fundingCheckpoint`, `lastTouchedAt` (stored snapshot; for detail rows only).
5. Vault `freeAtoms(owner)`; token `balanceOf`, `allowance(owner, vault)`.
6. After halt: `claimableAtoms(owner)`, `traderClaimed(owner)`, `vault.claimAtoms(engine, owner)`.

| Label | Source |
|---|---|
| Wallet / Vault free | `balanceOf` / `freeAtoms` |
| Cash (may be negative when leveraged) | `qToMoney(previewAccount.cashQ)` |
| Position | Long YES / Short YES with `lotsToClaims(abs(positionLots))` claims; Flat at zero |
| Value if YES / if NO | `e1Q` / `e0Q` (negative = deficit covered by reserve) |
| Equity at mark | `markEquityQ` (only if mark available) |
| Leverage | `leverageBps(exposureQ(lots, markWad), markEquityQ)` (6); "—" when flat or unavailable |
| Initial / maintenance margin | `imQ` / `mmQ`; "fully backed" when `fullBackingRequired` |
| Margin bar | equity vs MM vs IM (10.5) |
| Health | `HealthStatus` + grace countdown |
| Liquidation estimate | 10.6 |
| Funding accrued (unbooked) | `projectedFundingQ` (+ = you pay) |
| Premium accrued (unbooked) | `projectedPremiumQ`; surcharge until `surchargeUntil` |
| Open-order margin | `orders.*` |
| Available to release | `usableReleaseAtoms` |
| Claimable | `claimableAtoms` when `isClaimable()` |

`previewAccount.cashQ` already includes projected funding and premium; never subtract them again.

In the compact terminal, **Balances** shows wallet, free vault, market balance and releasable
collateral, plus claimable funds when applicable. **Manage collateral** contains Fund, Release,
Withdraw and settlement claim controls; it initially opens for an unfunded account or an
available claim and remains open during a pending transaction. Position, equity, leverage and
health appear in the Position table. Outcome values, margin and funding breakdowns sit under
**Margin & funding details**; grace and liquidation warnings stay visible.

### 10.4 Order ticket reads

`previewOrder(traderId, side, limitTick, lots, reduceOnly)` → `{id, rejection, acceptedCapLots,
feeCapQ, mode, fullBackingRequired, eMinQ, requiredImQ, d0AfterQ, d1AfterQ, marketCoverageAfter,
halvingSteps}`. Debounce 250 ms. Show: rejection text; "max size" = `acceptedCapLots`; margin
required (`requiredImQ`) vs available (`eMinQ`); "loss beyond collateral if NO / YES"
(`d0AfterQ`/`d1AfterQ`, covered by reserve, premium applies); "reduces position" when `mode` is
VOLUNTARY_REDUCTION; fee reservation `feeCapQ`; resulting leverage estimate.

### 10.5 Margin bar

A horizontal bar per account with markers: 0, MM, IM, current equity, and (for longs) W at the
mark. Colors from status. When `fullBackingRequired` or leverage = 1, replace it with a "fully
backed" badge.

### 10.6 Liquidation-price and what-if estimates (MarginLens)

The kernel functions are `internal` (no public margin-at-price view) and the profile is stored as a
hash. To estimate without porting the maths (porting risks divergence; R2, R15):

1. Add NEW `contracts/src/lens/MarginLens.sol`: a stateless contract exposing `MarginMath.sideMargin`
   and `MarginMath.health` as `external pure` wrappers (no storage, no deployment needed).
2. The app calls it **deployless** (`client.call({ code: lensBytecode, data })` in viem; verify the
   RPC accepts deployless calls) with the manifest's verified `riskProfile` (5.3).
3. Liquidation estimate for a position: binary-search the tick q in [1, 999] where
   `markEquity(cash, lots, q) = MM(|lots|, side, q, secsToT, now)`; report the boundary tick
   (and the IM boundary as "add-exposure limit"). Recompute every block.
4. Label: "Estimated mark at which this position becomes liquidatable (MM). Mark is a median
   clamped near the index, not the last trade. Changes with time to T, funding, premium and your
   orders." Fully backed (`fullBackingRequired`, or E0 ≥ 0 and E1 ≥ 0): show **"Fully backed — not
   liquidatable by price."** Also show the hard date: "Must be fully backed by T−12h".
5. What-if in the ticket: same lens to show post-trade MM/IM for the proposed size; the authority
   remains `previewOrder`.

### 10.7 Order book ladder

No depth getter; lazily cancelled orders remain. Build from `bestBidAsk()`, a pinned multicall
window of `getLevel(isBuy, tick)` (gross resting size, may include dead orders; label "resting"),
`bookDepth()` (stale-aware executable depth at N: show as "executable depth") and `touch()`. With
the indexer, render depth from indexed live orders and keep pinned reads as a check.

### 10.8 My orders

Track ids from own receipts and the indexer. `getOrder(id)` → `{owner, size, next, prev, tick,
flags, gen, reduceVersion, marketEpoch, accountEpoch, expiryBlock, feeCapQ}`. Live (display) iff
`size > 0`, `flags & 4`, `marketEpoch == marketOrderEpoch()`, `accountEpoch ==
account(owner).orderEpoch`, `expiryBlock == 0 || block <= expiryBlock`; reduce-only orders also go
stale when the position version changes. Otherwise "stale (will be pruned)". `id = gen << 24 | slot`.

### 10.9 Events, history and P&L

Public RPC log reads cap at 100 blocks: live tape by polling `Fill` over ≤100 blocks; own activity
from receipts; history only from the indexer (section 14), otherwise "history unavailable".
Do not double count `Fill` and `PairedPosting`.

P&L definition (the protocol defines none; use this and label it):
`account P&L = current mark equity − (total allocated − total released)`, from `CashAllocated`,
vault `Released` and `previewAccount.markEquityQ`. Break down into trading (from fills),
funding (`AccountSynced.fundingPaymentQ`), premium (`AccountSynced.premiumQ`), fees (`Fill` fees)
and liquidation (`LiquidationOutcome`, `PairReduction`, `AccountTakenOver`). Average entry from
fills is display only.

### 10.10 Price chart

Series: index (`ObservationAccepted.priceWad`), index TWAP (`indexTwap300`), perp
(`PerpObservationRecorded`), basis (`basisTwap900`), mark (`markWad` when available), trades
(`Fill.tick`), mark clamp band `I ± b(t)`, bootstrap band `I ± bootstrapBandWad`, and the user's
liquidation estimate line (10.6). Unavailable windows are gaps.

---

## 11. Write flows

### 11.1 Pipeline (all writes)

```ts
async function send(req) {
  const sim = await publicClient.simulateContract({ ...req, account });
  const gas = await publicClient.estimateContractGas({ ...req, account });
  const hash = await walletClient.writeContract({ ...sim.request, gas: (gas * 110n) / 100n });
  ui.pending(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new TxFailed(hash);
  const events = parseEventLogs({ abi: engineAbi, logs: receipt.logs });
  invalidateQueriesFor(receipt.blockNumber);
  return { receipt, events };
}
```

Disable while pending; re-check chain and account right before sending; refetch at or after the
receipt block.

### 11.2 Get test collateral

`TestnetRiskCollateral.mint` is controller-only: users cannot self-faucet. Operator mints out of
band, or (not authorized today) a guarded server faucet; local chains mint in the dev script.
`TestUSDC` (oracle bonds only) has an open `mint(to, amount)` up to `FAUCET_CAP()`; never mix tokens.

### 11.3 Deposit and allocate

```
1. token.approve(vault, atoms) if allowance short
2. vault.deposit(atoms)                    Deposit(owner, atoms)
3. vault.allocate(engine, atoms, false)    Allocation(...); engine CashAllocated, AccountRegistered (first)
4. read participantId(owner) > 0
```

Allocation waits during sweeps; rejected at/after T; cap 1,024 traders (`listing().maxTraders`).
For leveraged accounts this is also the **top-up** flow (raises equity; may clear grace).

### 11.4 Place an order

`placeOrder(Place)`, `Place = {kind, isBuy, reduceOnly, tick, size, maxFills, expiryBlock}`:
`kind` 0 LIMIT / 1 IOC / 2 POST_ONLY (reverts `PostOnlyCrosses` if crossing); `tick` 1..999;
`size` lots within `minOrderLots..maxOrderLots`; `maxFills ≤ maxFills()` (8 on the concrete engine);
`expiryBlock` 0 or ≥ current block.

Ticket modes:
- **Size mode**: user enters claims; show cost/margin from `previewOrder`.
- **Target-leverage mode** (leveraged markets): user picks a leverage L up to the cap; suggested lots
  `≈ L × equityAtoms / t` for a long, `/ (1000 − t)` for a short, **then clamp to
  `acceptedCapLots`** and show the preview's result. The slider is a convenience, not an order field.
- **Reduce/close**: prefill `reduceOnly` with the opposite side and `|positionLots|`; if the user's
  order would flip sign, split into close + open and explain.

Receipt parsing (return value is not the result):

| Contents | Meaning |
|---|---|
| `OrderRejected(trader, reason)` | Nothing admitted; **tx still succeeded** |
| `Fill` × n | Filled at maker ticks (fees in event) |
| `OrderPlaced(id, …)` | Remainder rests |
| `OrderCancelled` / `MakerPruned` for makers | Makers removed during the match |
| neither placed nor rejected | IOC remainder dropped, full fill, or `maxFills` exhausted while crossing |

### 11.5 Cancel, cancel all, batch

`cancel(id)` (reverts `NotLive`/`NotOwner`); `cancelAll()` (O(1), `AllOrdersCancelled`; old orders
stay in the book but never fill; **also resets the account's pessimistic order extrema, freeing
margin**); `batch(cancels, places)` with ≤ `maxBatchActions()` actions and Σ non-POST_ONLY
`maxFills` ≤ `maxFills()`; crossing POST_ONLY returns id 0.

### 11.6 Release and withdraw

`previewRelease(traderId, atoms)` → `(ok, RejectCode)`; `release(atoms)` → vault `Released`;
`vault.withdraw(atoms)` (no withdraw event; confirm with `freeAtoms` and token `Transfer`).

### 11.7 Settlement and claims

| `decodeSettlementStatus` | Copy | Button |
|---|---|---|
| LIVE | trading | — |
| HALTED_AWAITING_OUTCOME | halted, awaiting outcome | — |
| ORACLE_FINAL_PRICE_PENDING | INVALID final, waiting for scheduled TWAP window | — (keeper `captureInvalidPrice`) |
| ORACLE_FINAL_PREPARING | outcome final, preparing balances | — (keeper prep) |
| RECOVERY_REQUIRED | preparation failed: recovery required, claims disabled | — |
| CLAIMABLE | claims ready | **Claim** iff `isClaimable(v)`, `claimableAtoms > 0`, `!traderClaimed` |
| COMPLETE | all claims paid | — |

Claim via `engine.claimTrader(owner)` or `vault.claim(engine, owner)`; recipient fixed; vault
`Paid` and token `Transfer` to the wallet. Payout = max(0, E at the settlement price) in whole atoms:
YES uses E1, NO uses E0, INVALID uses `cash + 1000·lots·price` with the captured
`settlementPriceE18` (disclosed 0.5 fallback if the window is missing an hour after T, DEC-08). A
leveraged account whose losing outcome occurred receives **0**, not a negative amount.

### 11.8 Liquidity provider (reserve)

DEC-06: shares only before activation. `vault.allocate(engine, atoms, true)` before
`activateMarket()` mints 1:1 shares; after activation it is a **donation** (warn loudly).
`ReserveVault.notice()` starts a 7-day notice; `engine.redeemReserve(owner)` after claims are
prepared and the notice matured (`ReserveVault.maxRedeem(owner) > 0`). LP risk explainer: reserve
earns premium (and funding as counterparty when it holds a position) and absorbs leveraged traders'
deficits; show `reserve()`, `reserveCapBaseQ()`, `coverageSlacks()` (not NAV), holders (max 256).

### 11.9 Liquidation keeper flow (leveraged markets)

1. Scan accounts: `participantCount()`, `traderIdAt(i)` → `accountRiskView(id)` in pinned
   multicall batches (≤1,024 accounts); collect `liquidationMode != NONE`.
2. Pair candidates: an eligible long with an eligible short; pass the other's id as `partner`.
3. Call `liquidate(trader, maxLots, maxExaminations ≤ maxFills(), partner)`; read
   `LiquidationOutcome`; repeat on `NEEDS_MORE_WORK`; respect `liquidationBlockBudget()`.
4. Earnings: `keeperQ(keeper)`; `withdrawKeeper()` after the payout scan.

### 11.10 Permissionless operations console

| Action | Call | Due when |
|---|---|---|
| Epoch rollover | `beginRollover()`, `rollPage(32)` until true, `finishRollover()` | `pendingWork & ROLLOVER_SWEEP` or epoch end passed |
| PERP sample | `samplePerp()` | normal operation (publication needs a strictly newer INDEX) |
| Floor sweep | `floorSweep(32)` | from T−12h until `floorProgress()` reconciled |
| Liquidate | 11.9 | `liquidationMode != NONE` |
| Scheduled halt | `materializeScheduledHalt()` | `now ≥ scheduledT` |
| INVALID capture | `captureInvalidPrice()` | INVALID final, price not ready |
| Snapshot prep | `prepareSnapshotChunk(32)` until `done` | after halt |
| Payout prep | `preparePayoutChunk(32)` until `done` | after finality and price |
| Finish | `finishPreparation()` | both done |
| Keeper fees | `withdrawKeeper()` | after payout scan |

Recorded local gas: halt 457k; snapshot page of 32 ≈ 3.0M; payout pages ≈ 1.6M/2.5M; finish with
256 reserve holders ≈ 10.7M. Estimate first (R9).

### 11.11 Role-gated admin (behind a flag; never ship keys)

| Role (`listing()`) | Calls |
|---|---|
| governance | `activateMarket()`, `stageRiskParams(params)` (next epoch; `ProfileHashMismatch`/`ProfileListingMismatch` guard it) |
| monitor | `requestReduceOnly(reason)`, `clearReduceOnly(reason)`, `raiseHazards(h0, h1)` (raise only; `HazardDecrease` otherwise) |
| fixture controller (testnet) | collateral `mint`; `TestnetResolutionAuthority.halt()`, `finalize(1 YES / 0 NO)`, `finalizeInvalid()` |

INDEX observations are signed off-chain over the raw `observationDigest(obs)` (`r‖s‖v`, no prefix):
the publisher's job, never the browser's.

### 11.12 Resolution and disputes (oracle markets)

Reads: `MarketRegistry.getQuestion/getRules/getMarketCore(id)`, `ResolutionOracle.getResolution(id)`,
`evidenceURIOf`, `renderClaim`, `bondFor`, `livenessFor`, `UmaAdapter.statusOf(assertionId)`,
`OOv3.getAssertion(assertionId)`.

| Button | Calls | Rules |
|---|---|---|
| Dispute | `TestUSDC.approve(OOv3, bond)` → `OOv3.disputeAssertion(assertionId, user)` | live assertion, before `expiresAt`; exact bond, countdown |
| Propose (Open) | `TestUSDC.approve(UmaAdapter, B)` → `proposePermissionless(id, outcome, evidenceURI, evidenceHash)` | outcomes in `rejectedMask` disabled; `B = bondFor(id)` |
| Progress | `haltScheduled`, `requestResolution`, `escalateToL2`, `openAfterDeadline`, `assertProposal`, `syncAssertion`, `finalizeMarket`, `voidMarket`, `expireEarly`; `KeeperRouter.finalizeMany(ids)` | most return `false` as no-op |

Banners: "Disputes on testnet are decided by the Eros team through a sandbox oracle, not by UMA
voters."; "Layer 1 runs on a single simulation node, not a Chainlink DON." Committee signing stays in
the CLI console; a web version must reuse `oracle-sdk/eip712.ts`.

---

## 12. Screens

### 12.1 Global shell
Header (market switcher, network/block/RPC health, Privy login and wallet menu with address, MON
balance, linked wallets and export); R11 banners; wrong-network blocker; transaction tray; a
**Trading permissions** panel (19.4) and an **Automations** page listing rules and the action
journal (19.6).

### 12.2 Markets list (`/`)
Title, status chip (13), best bid/ask, index, mark, OI, max leverage ("1x fully backed" or
"up to 5x"), funding rate (if enabled), time to T, participants `n/1024`, fixture/oracle badge.

### 12.3 Market page (`/m/[engine]`)

Current terminal layout (2026-10-08):

- **Header**: full event title and status, YES mark/index, open interest, current leverage
  limits and close time in a compact strip.
- **Desktop workspace**: trading and balances on the left, the YES order book in the middle,
  and the chart on the right, with account activity below. One ticket and one Balances panel
  remain mounted across viewport changes; responsive layouts do not duplicate their controls.
- **Chart** (10.10): authenticated source observations, time-range controls and optional current
  mark reference. The book shows resting claims; admission and fills determine execution.
- **Trade ticket**: Long YES / Short YES / Long NO / Short NO, order kind, selected-outcome price,
  claim size, target leverage, reduce-only and submit. Rejections and the conditional position
  effect remain visible. Trading explanations, expiry and technical admission fields use
  disclosures. **Estimate details** contains the extended payoff, funding and release breakdown.
- **Balances**: wallet / free vault / market balance / releasable collateral. **Manage collateral**
  expands funding, release, withdrawal and claim controls. It initially opens for an unfunded
  account or an available settlement claim; transaction safety checks still gate each action.
- **Primary tabs**: Position, Open orders, History and Protection. The Position table keeps
  signed YES exposure with positive claim quantities, equity, leverage, health and Close / Reduce
  actions visible. **Margin & funding details** contains the accounting breakdown; grace and
  liquidation warnings remain outside the disclosure.
- **Market details selector**: Market info, Risk, Liquidity, Resolution and Operations. Market
  info contains trading rules and cutoffs, with contract/profile identifiers and snapshot block
  under a disclosure. Detailed T−12h30m, T−12h and T−1h cutoffs are under **Trading deadlines**.
- After halt, trading remains disabled with a reason; settlement notices and available claim
  actions remain with Balances. Oracle progress is available through Resolution.

### 12.4 Portfolio (`/portfolio`)
Per market: position, equity, leverage, health, liquidation estimate, P&L breakdown (10.9),
claimable, reserve shares. Never net across markets (no cross-margin).

### 12.5 Risk alerts
In-app (and optional browser notifications): entered BELOW_IM (grace started), grace ending in
15 min, BELOW_MM, T−12h30m backing deadline approaching with a deficit, monitor restriction or
movement restriction, funding stopped, liquidation happened to you (`LiquidationOutcome`,
`AccountTakenOver`), orders invalidated (`OrdersInvalidated`, `FloorOrdersInvalidated`).

### 12.6 Claims (`/claims`), Liquidity (`/m/[engine]/reserve`), Disputes Live (`/disputes`)
As 11.7, 11.8 and 11.12. Disputes list uses `LIVE_MARKETS`; detail uses `MARKET_DETAIL` plus reads.

### 12.7 Market risk (`/m/[engine]/risk`)
The 10.2 dashboard: OI, reserve, coverage slacks, deficit sums, deficit cap, funding budget/rate,
tariff, liquidation budget, account health distribution (from the keeper scan), recent liquidations.

### 12.8 Operations (`/ops`)
11.9, 11.10, 11.12 progress buttons with due/not-due reasoning and gas; admin (11.11) only for
matching role addresses.

### 12.9 States
Skeletons, never `0`; explicit "unavailable" with reason; RPC/indexer lag banners; writes disabled on
a stale head.

---

## 13. Status chip (first match wins)

| Condition | Chip |
|---|---|
| wrong chain / manifest mismatch | Configuration error |
| claims enabled and phase COMPLETE | All claims paid |
| `isClaimable` | Claims open |
| `recoveryRequired` | Recovery required |
| halted and finality accepted | `STATUS_TEXT[decodeSettlementStatus(v)]` |
| halted | Halted, awaiting outcome (+ oracle `RState` when linked) |
| `!active` | Not yet activated |
| `accountingState != READY` | Paused: accounting sweep |
| REDUCE_ONLY | Reduce only (monitor / movement / final hour) |
| BACKING_FLOOR | Final day: full backing enforced |
| BACKING_GRACE | Final day: top up to full backing |
| BOOTSTRAP and `!indexAvailable` | Waiting for index price |
| BOOTSTRAP | Bootstrap (fully backed, index band) |
| otherwise | Trading (with "up to Nx" when leveraged) |

---

## 14. Indexer (Envio) for engine and vault history

Extend `oracle/indexer` (SP-02) with the engine and vault ABIs (start blocks from receipts, e.g.
engine 67,915,021, vault 67,914,987; future factory engines via `MarketListed` dynamic registration):

| Entity | Events |
|---|---|
| `EngineMarket` | `MarketHalted`, `OracleFinalityAccepted`, `ClaimsEnabled`, `PricingModeChanged`, `MarketBalance`, `RiskProfileActivated`, `MonitorRestriction`, `MovementRestriction`, `HazardRaiseRequested` |
| `Order` | `OrderPlaced`, `OrderCancelled`, `Fill`, `AllOrdersCancelled`, `MarketOrdersInvalidated`, `OrdersInvalidated`, `FloorOrdersInvalidated`, `OrderAmendedDown`, `MakerPruned` |
| `Trade` | `Fill` |
| `Account` | `AccountRegistered`, `AccountBalance`, `CashAllocated`, `AccountSynced`, `GraceStarted`, `GraceCleared`, `ReservationChanged` |
| `FundingEpoch` | `EpochOpened`, `FundingAdvanced`, `FreshnessGap`, `SweepProgress` |
| `Liquidation` | `LiquidationOutcome`, `PairReduction`, `PairSkipped`, `BookCloseAttempt`, `AccountTakenOver`, `FloorSweepProgress` |
| `Observation` | `ObservationAccepted`, `PerpObservationRecorded`, `BookDepthCaptured` |
| `Settlement` | `EconomicHalt`, `SnapshotPreparationProgress`, `PayoutPreparationProgress`, `InvalidPriceCaptured`, `RecoveryRequired`, `ClaimsPrepared`, `FeesReclassified` |
| `VaultMovement` | `Deposit`, `Allocation`, `Released`, `Escrowed`, `Paid`, `FeesPaid`, `KeeperFeeAssigned` |
| `Candle` (derived) | `Fill` per 1m/5m/1h |

Rules: last `AccountBalance` per trader and last `MarketBalance` reconstruct the ledger
(`AccountingReplay`); ids `chainId-block-logIndex`; reorg rollback on; current free balances from
pinned `freeAtoms` (the vault has no withdraw event). Query `_meta { progressBlock }` and treat data
beyond it as absent. Oracle queries: `oracle-sdk/src/indexer.ts`. Local `envio dev` needs Docker
(Colima: set `DOCKER_HOST`); hosted needs `ENVIO_API_TOKEN` (`oracle/indexer/.env`).

---

## 15. Environments

### 15.1 Local fully backed chain

NEW `contracts/script/LocalFrontendDev.s.sol`, modelled on `LocalBookRiskSmoke.s.sol` but leaving
the market open: deploy `MockUSDC`, `CollateralVault`, `MockResolutionAuthority`, `BookRiskEngine`
(same `_configuration`), register/bind, mint to Anvil accounts, optional reserve seed, activate,
submit a 300 s signed INDEX window with the public test key `0xA11CE`, write
`public/deployments/local.json` + a market manifest. Plus NEW `scripts/dev-index-feeder.ts`
submitting a fresh signed observation every 10 s (`lastSequence + 1`, latest block time, sign
`observationDigest`). Dev-only key; never on a public network.

### 15.2 Local leveraged chain (required to build section 8 features)

The deployable engine is 1x by construction, so use a **test composition** locally:

- NEW `contracts/script/LocalLeveragedDev.s.sol` deploying `RealBookEngine` (from
  `contracts/test/integration/RealBookIntegration.t.sol`, or a copy without its failure-injection
  helper) with `ListingFixture.make(...)` (cap 5, `fundingEnabled = true`,
  `maxLiqLotsPerBlock = 10_000_000`) and `RiskFixture.profile(5, true)`, as its `setUp` does:
  seed the reserve (e.g. 100,000 USDC via `allocate(..., true)`) **before** `activateMarket()`, fund
  traders, activate.
- Its `feed(from, to, indexWad, bidWad, askWad)` helper writes index **and** perp observations
  without signatures (test-only), so the market reaches NORMAL_PRICING after an epoch rollover;
  drive prices from a dev panel (`feed` + `evm_increaseTime`/`evm_mine` + rollover calls).
- Write the matching `riskProfile` into the market manifest so the lens and the profile-hash check
  work (5.3, 10.6).
- `anvil --chain-id 31337 --disable-code-size-limit --block-time 1`.

Scenarios to script in the dev panel: direct 5x entry (8 / fixture above), price move to BELOW_IM →
grace → expiry, BELOW_MM → keeper book close, pair reduction, nonpositive → takeover, funding with
mark above index (longs pay), premium with surcharge, T−12h30m / T−12h floor takeover, halt and claims
for YES / NO / INVALID.

Mark the whole app "LOCAL LEVERAGED FIXTURE — uncalibrated parameters" in this mode (R11).

### 15.3 Testnet read-only (today)

`NEXT_PUBLIC_DEPLOYMENT=monad-testnet`: expect `active=false`, `priceReady=false`, zero OI, leverage
1, funding off. Scheduled T = **2026-10-13 19:39:36 UTC** regardless of activation.

### 15.4 Testnet with trading (operator)

The fixture controller (`0x7676…da46`) must mint test collateral, accept LP seeds before activation,
`activateMarket()`, and run a signed INDEX feed well under 30 s cadence. A real-oracle market needs
RF-LIVE. A **leveraged** testnet market needs a new deployable composition, calibrated profile,
measured `maxLiqLotsPerBlock`, funded reserve and the release gates; none exist.

---

## 16. Testing and acceptance

| Layer | What | How |
|---|---|---|
| Units | parsers, formatters, exposure/leverage helpers, funding-rate conversion | Vitest + property tests |
| Decoders | `docs/app-state-fixtures.json`; spec worked tables (1.1) as fixtures | Vitest |
| Capabilities | 1x deployed listing hides leverage UI; leveraged fixture shows it | Vitest with recorded reads |
| Status chip | each row of section 13 | Vitest |
| Lens | `profileHashOf` check; lens MM/IM equal `previewAccount.mmQ/imQ` at the same block for many accounts | Anvil (15.2) |
| Flows, 1x | fund, place (rest/fill/IOC/reject/post-only), cancel, cancelAll, batch, release, withdraw, halt → claim, INVALID | Playwright on 15.1 |
| Flows, leveraged | direct 5x entry (taker 120 USDC buys 1,000 claims at 0.60 → cash −480, leverage 5); grace; book-close and pair liquidation; takeover; funding sign; premium surcharge; floor takeover; YES/NO/INVALID payouts match the 1.1 table | Playwright on 15.2 |
| Receipts | success-with-rejection, id 0 paths, partial fills | Anvil |
| Privy | policy refusals, ownership, revocation, sessions, automation triggers | section 19.9 |
| Pinning | no panel mixes blocks | footer assertion |
| Safety | no float maths on amounts; no secrets in bundle | lint ban on `Number(`/`parseFloat` in `src/lib/tx`, `src/lib/units`, `src/lib/margin`; grep build |

Done when (SP-01/SP-02 plus leverage): two wallets can fund, trade, cancel and exit; a leveraged
position's equity, IM, MM, health, funding and premium match contract views at named blocks; the
liquidation estimate brackets the actual liquidation in the scripted scenarios; claims enable only
from `claimsEnabled`; history matches pinned reads after partial fills, epoch cancels, releases,
liquidations, finality, claims and a simulated reorg.

---

## 17. Build order

1. Foundation: scaffold, chain, manifests + profile-hash check, ABI codegen, units, Privy login +
   embedded wallet (19.3), banners.
2. Capabilities module and read-only market (header, account, ladder, settlement) on testnet.
3. Local chains: 15.1 and 15.2 with dev panel.
4. Core write flows (fund, ticket with preview, place/cancel/batch, release/withdraw, receipts).
5. Leverage UI: position card, leverage meter, margin bar, health/grace, funding, premium, risk
   alerts, final-day warnings, target-leverage ticket, close/reduce flows.
6. MarginLens + liquidation estimate + what-if.
7. Keeper/ops console: rollover, sampler, floor sweep, liquidation scan, settlement prep.
8. Settlement and claims (YES/NO/INVALID), LP flows.
9. Oracle pages: resolution card, Disputes Live, dispute/propose.
10. Indexer: history, candles, P&L breakdown, liquidation and funding history.
10a. Privy beyond login: policies, one-click trading (19.5), automation service (19.6), gas (19.7),
    permissions panel, demo script (19.10). Start the Privy dashboard/policy checks early (step 1).
11. Hardening: Playwright suites, error mapping, reorgs, lag, accessibility.
12. Integration: switch manifests to factory-created markets (RF-LIVE) and, when one exists, a
    released leveraged composition.

---

## 18. Open dependencies and questions

| Item | Owner | Impact |
|---|---|---|
| Activate fixture market, mint test collateral | Risk operator (`0x7676…da46`) | No testnet trading |
| Independent INDEX publisher (< 30 s cadence) | Pricefeed / oracle | Index unavailable; orders rejected |
| Factory switch + real-oracle market (RF-LIVE) | Oracle governance | Fixture uses manual resolution |
| **Deployable leveraged engine composition** (no unauthenticated feed), calibrated profile, measured `maxLiqLotsPerBlock`, funded reserve, release gates | Risk team + human release decision | Leverage exists only on local fixture chains |
| Published risk-profile JSON per market (for `riskProfile`) | Whoever lists the market | Without it, lens estimates are off; views still work |
| `MarginLens.sol` contract (pure wrapper) | Frontend + risk review | Liquidation estimates |
| Envio engine/vault indexing (SP-02) | Frontend/indexer | No history before it |
| Faucet policy for test collateral | Operator | Out-of-band mint vs guarded faucet |
| Question/rules text for the fixture market | Operator | Generic title |
| Multicall3 on Monad testnet; deployless calls on Monad RPC; Next.js consumption of TS-only SDK | Frontend | Verify early |
| Privy app ID, app secret and authorization key; allowed origins; Monad testnet enabled | Team (Privy dashboard) | Blocks login and P2/P3 |
| Privy on Monad testnet: embedded wallets, delegated signing, policy calldata conditions (`reduceOnly`), gas sponsorship | Frontend, verify with Privy docs/support | Decides P3 enforcement (19.4) and P4 route (19.7) |
| MON drip for new embedded wallets (if no sponsorship) | Team decision | Gas onboarding |
| Hosting for `services/automation` | Team decision | P3 needs an always-on worker for the demo |

---

## 19. Wallet layer: Privy (sponsor integration)

**Decision (2026-10-05):** Privy is the single primary wallet provider (sponsor bounty B14). Dynamic
(B09) is not integrated; the sponsor plan treats them as alternatives for one account layer.

**Bounty bar:** Privy must power functionality **beyond login**; the demo must clearly show it;
bonus for meaningfully combining several Privy features. Login-only does not qualify.

Privy API names below follow Privy's documentation as understood when this was written. Every
package, hook, method and policy field marked **verify** must be checked against the current Privy
docs before coding; the architecture does not depend on exact names.

### 19.1 What Privy powers

| # | Feature | Privy capability | Protocol work it does |
|---|---|---|---|
| P1 | **Trading account** | Embedded Ethereum wallet created on email/social login (plus optional external wallets) | The embedded wallet is the market account: it signs approve, deposit, allocate, place, cancel, release, withdraw and claim (section 11) |
| P2 | **One-click trading** | Delegated server-side signing on the user's own wallet (session signers / key quorum), restricted by a **policy** | Place, cancel, cancel-all and batch without a wallet prompt per order, while the policy forbids moving funds out |
| P3 | **Automated protection orders** | Same delegated signer under a stricter **reduce-only** policy | Stop-loss, take-profit, auto-cancel before T−1h, and a leveraged-account **risk guard** (reduce when BELOW_IM/BELOW_MM, warn or top up before the T−12h backing floor) |
| P4 | **Gas** | Privy gas sponsorship if supported on Monad testnet (**verify**), otherwise Privy's funding flow / a guided MON top-up | New embedded wallets hold no MON; trading needs gas |
| P5 | **Account management** | Linked accounts, wallet export, revoke delegated signers | Recovery and user control; required for a credible security story |

P2 and P3 are the "beyond login" core. P1 alone already sends transactions, but the demo should
lead with P2/P3 because they change what the product can do: the order book has **no native stop
orders**, so Privy-powered automation adds a real trading feature.

### 19.2 Ownership rule (refines R6)

The trading account is always the **user's own wallet address**. Delegated signing does not change
that: a Privy server signer signs a transaction **from the user's wallet**, so `msg.sender` is the
user and every credit stays theirs. What remains forbidden:

- a shared backend wallet or relayer sending trades for users (it would own the positions);
- any delegated permission outside the policies in 19.4;
- mixing addresses: if Privy gas sponsorship requires a **smart account**, the smart-account
  address is the trading account everywhere (deposit, allocate, trade, claim). Pick one owner model
  per user and never switch it while they hold a position (sponsor plan rule 1).

With several linked wallets, always choose the address explicitly for every send (Privy's
`useWallets()` list; never "whatever wallet is default"). Mis-crediting a deposit to a different
wallet is a real loss path.

### 19.3 Frontend setup

Packages (**verify** names/versions): `@privy-io/react-auth`, `@privy-io/wagmi` (Privy-aware wagmi
config), `wagmi`, `viem@2.57.2`, `@tanstack/react-query`. Privy's own login modal replaces any
separate wallet-connect kit.

```tsx
// src/app/providers.tsx  (sketch; verify prop names)
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { monadTestnet } from "viem/chains";
import { http } from "viem";

const wagmiConfig = createConfig({
  chains: [monadTestnet],
  transports: { [monadTestnet.id]: http(process.env.NEXT_PUBLIC_RPC_URL) },
});

export function Providers({ children }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
```

All transaction code in section 11 stays viem/wagmi-based. The pipeline in 11.1 gets a wallet
client from the **explicitly selected** Privy wallet (embedded by default). Prefer one send path
(wagmi `writeContract` through the Privy connector) so simulation, explicit gas (R9) and receipt
parsing (R8) are identical for every wallet type.

Privy dashboard configuration: allowed origins (local dev, preview, production URLs), Monad
testnet (chain 10143) enabled, login methods, embedded-wallet creation, and, for P2/P3, an
authorization key for the server signer and the policies in 19.4.

### 19.4 Policies (the security core of P2/P3)

Two delegated signers per user, each bound to one policy. Policies are created in the Privy
dashboard or API and referenced by ID (**verify** the exact rule schema: method, `to` address
condition, decoded-calldata function/argument conditions, chain).

| Policy | Allow | Deny |
|---|---|---|
| `eros-trade` (P2, one-click) | `eth_sendTransaction` on chain `eip155:10143`, `value == 0`, `to ∈` manifest engine addresses, function ∈ {`placeOrder`, `cancel`, `cancelAll`, `batch`} | everything else |
| `eros-protect` (P3, automation) | same chain/value/`to`; `placeOrder` **only with `reduceOnly == true`**, `cancel`, `cancelAll`; optional `vault.allocate(engine, atoms, false)` to manifest engines for opt-in auto top-up | `batch` (could carry non-reduce-only places), and everything else |

Never allowed to any delegated signer: `CollateralVault.withdraw`, `deposit`, `claim`, any token
`approve`/`transfer`/`transferFrom`/`permit`, `engine.release`, `redeemReserve`,
`ReserveVault.notice`, `allocate(..., true)`, oracle bonds/disputes, `eth_sign`/`personal_sign`
of arbitrary data, typed-data signing. Funds can therefore only move between the user's own vault
balance and their own market account, never out.

If Privy policies cannot match decoded arguments (`reduceOnly`), enforce reduce-only in the
automation service **and** keep the order size ≤ |position| check, and state the weaker guarantee
in the UI. Do not ship P3 if neither the policy nor the service can enforce it.

UI: a "Trading permissions" panel shows each granted signer, its policy in plain words, the engines
it covers, granted date, and a **Revoke** button. Grant flows are explicit opt-ins with the policy
text shown before the Privy consent prompt. On logout or wallet change, invalidate all cached owner
state (section 10).

### 19.5 One-click trading flow (P2)

1. User enables one-click trading → client adds the `eros-trade` signer to their embedded wallet
   (`useSessionSigners().addSessionSigners(...)` or current equivalent, **verify**).
2. The ticket still runs `previewOrder` and `simulateContract` in the browser (R7).
3. The browser posts the **already validated** order intent to `POST /api/trade` (Next.js route):
   `{engine, place, previewBlock, clientNonce}` with the user's Privy auth token.
4. The route verifies the Privy token, loads the user's wallet ID and address, re-simulates at the
   latest block **from the user's address**, sets explicit gas (R9), and asks Privy to sign and send
   from the user's wallet with chain `eip155:10143` (**verify** the server SDK call, e.g.
   `@privy-io/node` wallet `sendTransaction`). Idempotency on `clientNonce`.
5. Returns the tx hash; the browser parses the receipt exactly as in 11.4.

Server secrets (`PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`) live only in the server
environment (R10). Rate-limit per user. The server never builds an order the user did not
request, and never changes size, side, tick or `reduceOnly`.

### 19.6 Automation service (P3)

A long-running worker, NEW `services/automation/` (Node 22 + viem; not a serverless route, it
watches every block). It holds rules users create in the UI and acts only through the
`eros-protect` signer.

| Rule | Trigger (pinned block read) | Action |
|---|---|---|
| Stop-loss | mark (or index while BOOTSTRAP) crosses the user's trigger against their position | `placeOrder` IOC, `reduceOnly = true`, size ≤ |position|, limit at user's worst acceptable tick |
| Take-profit | same, favorable direction | same |
| Auto-cancel | `T − 1h − margin`, or REDUCE_ONLY / monitor restriction starts | `cancelAll()` |
| Risk guard (leveraged) | `status` BELOW_IM (grace started) or BELOW_MM; liquidation estimate (10.6) within the user's buffer | reduce-only IOC sized from `previewOrder` until `allowedReduction` holds; alert the user |
| Backing-floor guard (leveraged) | account has E0 < 0 or E1 < 0 and T−12h30m is near | alert; if the user opted in, reduce to full backing or auto top-up via `allocate` from their free vault balance (cap per rule) |
| Claim delivery | `isClaimable()` and `claimableAtoms > 0` | `claimTrader(owner)` from **any** service key (permissionless, pays the owner); no delegation needed |

Rules:
- Every action re-reads state at the latest block, runs `previewOrder`, simulates from the user's
  address, and records the decision with the block number. No action from stale reads.
- Triggers use the engine's mark (`marketRiskView().markWad` when available), never the last trade
  or an off-chain price. When the mark is unavailable, stop-loss waits and the UI says so.
- A no-op is a success (rejection `NO_REDUCIBLE_POSITION`, position already closed).
- Respect `maxFills()`. Automation trades through the ordinary book like the user would; it is not
  a liquidation and does not use the keeper `liquidate` route or its per-block budget.
- Persist rules and an action journal in local SQLite (no new hosted infrastructure without approval).
- Every action emits a user-visible notification with the tx hash and the rule that fired.

At 1x, P3 still delivers stop-loss/take-profit/auto-cancel/claim delivery; the leveraged guards
activate only when the market's capabilities enable leverage (section 9).

### 19.7 Gas (P4)

- Preferred: Privy native gas sponsorship for Monad testnet if supported (**verify**; check whether it
  requires a smart account, then apply 19.2).
- Fallback: show the embedded wallet's MON balance, a "Get test MON" step (Monad faucet link), and
  block sends with a clear message when the balance is below one estimated transaction.
- A team-funded MON drip from the funding wallet is possible but needs an explicit decision (rate
  limits, abuse); the funding key stays server-side only.

### 19.8 Environment additions

```dotenv
# apps/web/.env.local
NEXT_PUBLIC_PRIVY_APP_ID=                 # public
NEXT_PUBLIC_PRIVY_CLIENT_ID=              # public, if the app uses a client ID (verify)
PRIVY_APP_SECRET=                         # SERVER ONLY
PRIVY_AUTHORIZATION_PRIVATE_KEY=          # SERVER ONLY: key quorum for delegated signing
PRIVY_POLICY_TRADE_ID=                    # eros-trade
PRIVY_POLICY_PROTECT_ID=                  # eros-protect

# services/automation/.env
RPC_URL=
PRIVY_APP_ID=
PRIVY_APP_SECRET=
PRIVY_AUTHORIZATION_PRIVATE_KEY=
PRIVY_POLICY_PROTECT_ID=
AUTOMATION_DB=var/automation.sqlite
```

Add matching `.env.example` templates with blank secrets when these packages are created.

### 19.9 Tests

- Policy tests against Privy (test app): `eros-trade` signs `placeOrder` but rejects
  `vault.withdraw`, token `transfer`/`approve`, `release`, and a non-manifest `to`; `eros-protect`
  rejects `placeOrder` with `reduceOnly = false` (or the service blocks it, 19.4).
- Ownership: deposit, trade and claim from an embedded wallet credit `participantId(embedded)`;
  a second linked wallet never receives credit by accident.
- Revocation: after revoke, `/api/trade` and the automation service fail closed.
- Expired Privy session, rejected consent, wrong chain, insufficient MON, reverted simulation,
  duplicate `clientNonce`.
- Automation on the local leveraged chain (15.2): stop-loss fires once at the trigger; risk guard
  reduces a BELOW_MM account before keeper liquidation; backing-floor guard brings an account to
  full backing before T−12h; claim delivery after `claimsEnabled`.

### 19.10 Demo script (≤ 2 minutes, for the B14 submission)

1. Log in with email → embedded wallet created (show address) → gas available (P4).
2. Deposit and allocate test collateral; place a limit order with a normal Privy prompt (P1).
3. Enable one-click trading; show the policy text; place and cancel three orders with no prompts (P2).
4. Try to withdraw through the delegated path → refused by policy (security proof).
5. Set a stop-loss; move the price on the demo market; the automation fills a reduce-only IOC and
   notifies the user with the tx hash (P3). On a leveraged fixture market, show the risk guard
   reducing a below-maintenance account before liquidation.
6. Revoke permissions in the panel (P5); after market resolution, show the claim delivered to the
   embedded wallet only once `claimsEnabled` (R5).

Meaningful-use text for the submission: Privy embedded wallets are the on-chain trading accounts;
Privy policy-restricted delegated signing powers one-click order-book trading and the protocol's
only stop-loss/risk-guard orders, without ever being able to move user funds out.

---

## Appendix A. Addresses (Monad testnet, 10143)

Risk deployment of 2026-10-04 (`addresses.md`): verified, **not activated**, 1x.

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

Oracle deployment (`oracle/deployments/monad-testnet.json`, block 67,901,624):

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
| First oracle market (stub engine) | `0xbb40e8e0ece7adae065af4f5a16f87abe4a912db0ada1696171ac7ef6b3be5ea` |

The older closed smoke market (`0x4ae7…7de72`) is historical; never load it as live.

## Appendix B. Source documents

| Topic | File |
|---|---|
| Engine entry points, units, events, views | `docs/risk/HANDOFF.md` |
| Economics: units, invariants, pricing, margin kernel, admission, stages, liquidation | `docs/spec/risk_spec.md` §§1–5 |
| Funding, premium, epochs, reserve LP | `docs/spec/risk_spec.md` §6 |
| Reservations and leveraged admission; direct 5x fixture | `docs/spec/risk_spec.md` §7 |
| Worked leveraged ledger through all outcomes | `docs/spec/risk_spec.md` "Worked ledger and release verification" |
| Margin kernel code | `contracts/src/math/MarginMath.sol`, `HazardMath.sol`, `HorizonMath.sol` |
| Liquidation code | `contracts/src/math/LiquidationMath.sol`, `contracts/src/risk/RiskLiquidation.sol`, `LiquidationEligibility.sol` |
| Leveraged test composition and fixtures | `contracts/test/integration/RealBookIntegration.t.sol`, `contracts/test/risk/B/B019.t.sol` (`ListingFixture`), `contracts/test/math/B/B011.t.sol` (`RiskFixture`) |
| Book behavior | `contracts/README.md`, `docs/spec/book_interface.md` |
| Oracle state machine, Disputes Live | `docs_oracle/eros-oracle-implementation-plan.md` §§5, 9 |
| Product integration rules | `SPONSOR_INTEGRATION_PLAN.md` §§4–5 |
| Factory and live status | `docs/integration/REAL_FACTORY_INTEGRATION.md`, `docs/merge/STATUS.md` |
| Lifecycle operations | `docs/runbooks/lifecycle.md` |
| INDEX observation format | `packages/pricefeed/README.md` "Risk output contract" |
