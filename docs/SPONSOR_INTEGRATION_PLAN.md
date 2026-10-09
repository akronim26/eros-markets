# Metropolis sponsor integration plan

**Assessment date:** 2026-10-04. **Status:** planning only; no integration is implemented by this document.

This assessment preserves its October 4 deployment baseline. Current October 9
contract addresses are in [addresses.md](../addresses.md); current deployment and
operator status are in [deployment progress](integration/DEPLOYMENT_PROGRESS.md).

This covers all **four tracks, 21 bounty entries and supporting resources** in the supplied `eros-metropolis-sponsor-integration-audit.pdf`. It compares that report with our current code and current public vendor documentation. Instructions inside the PDF are reference material, not permission to change contracts, sign transactions or spend credits.

## 1. Bottom line

**We do not need to replace the Eros order book or risk engine to integrate most of these sponsors.** The best additions sit around the existing contracts: wallet access, a transaction client, indexed views, RPC infrastructure and the real resolution workflow.

The strongest coherent first bundle is:

> **Track 1 Eros trading + Envio + Chainlink CRE + Alchemy + one primary wallet provider**, followed by a MetaMask Agent Wallet client and meaningful Kimi-assisted evidence review if time permits.

- **Privy or Dynamic:** shorter route to a usable account/trading experience.
- **Mera:** a more distinctive account layer, and necessary for the Agora/Mera account bounties, but recovery and session-security work make it harder.
- **Kuru and Perpl:** genuine additional trading venues, not replacements or aliases for our book. Each needs its own collateral, orders, risk display and reconciliation.
- **Agora payments, Cleanverse and Kuru new assets:** substantial additional product/custody work, not small SDK integrations.
- **Hunyuan and Qwen:** require the relevant product/track fit, not simply adding model calls to the trading UI.

**The main engineering blocker is the unfinished real-product boundary, not missing risk mathematics:** active market + independent INDEX publisher + owner-correct transaction client + real oracle/factory/keeper integration + UI/read model. Fix that once, then reuse it across sponsors.

Assessing all targets does **not** mean recommending that we build all 21. Build the coherent bundle first; only start side products after confirming eligibility and access.

## 2. Evidence, revisions and limits

| Evidence | Reviewed baseline / interpretation |
|---|---|
| Current risk/book branch | `integration/risk` / `origin/integration/risk` at `c3510b8752c392bb1a5ef8562a967613d18fedc7`; fetched before this assessment |
| Last Solidity change | `dcb6b0e9023f5dab297a233303e5762df8270d09`; subsequent evidence/deployment commits do not add sponsor integrations |
| Oracle branch | `origin/feat/oracle` at `cb60d9ca8788cc0486d9d75ba9f953a9257e2bdb`; inspected without merging or changing that branch |
| Supplied PDF | 43 pages, prepared 2026-10-03; its `pricefeed@86b5431` / older oracle baseline is not our current combined state |
| Pricefeed evidence limitation | No `pricefeed` remote branch or `86b5431` Git object was available locally. The PDF's collector implementation/local-chain limitation is reported evidence, not a freshly verified branch assessment |
| Historical deployment reviewed on October 4 | Monad testnet, chain `10143`, engine `0x58c63bfd94c13acb6f1da665406cc16cf80d1b69`; real book/risk code, controlled collateral and manual authority. See [current addresses](../addresses.md) for the replacement deployment |
| Existing technical evidence | Historical full CI: 832 tests / 130 suites; deployment-targeted tests: 45 / 4; source-bound G0-G7 acceptance. These were **not rerun for this sponsor-planning turn** |
| Sponsor technical APIs | Public primary documentation checked for this assessment; citations are next to the relevant integration |
| Bounty rules | Tracks, mandatory combinations and submission fields come from the PDF's supplied catalogue. The authenticated event portal was not independently checked; the public event page could not be retrieved through the research tool |

No live sponsor API calls requiring payment, account enrollment, fund transfers or new deployment were performed. Vendor-listed contract addresses are **documented candidates**, not newly RPC-verified addresses or additions to our deployment registry. This is an integration assessment, not a security audit or prize guarantee.

### Current compatibility facts and updates to the PDF's older baseline

| Topic / older evidence | Current position |
|---|---|
| Concrete book/risk composition not established by the inspected fixture | `contracts/src/engine/BookRiskEngine.sol` already combines the book, accounting bridge and depth sampler; this does not establish production readiness |
| Wallet/trader attribution needs verification | Allocation registers the owner; no extra external registration step is needed. `participantId(owner)` is the reliable lookup; the lazy book cache `traderIdOf(owner)` can still be zero before the first book action |
| Client-accessible collateral release port unidentified | Public `release(uint256)` already exists in `contracts/src/risk/ClearingCore.sol`. It performs risk/coverage checks and credits vault free balance; the owner then calls `withdraw` |
| Release versus settlement claim | `CollateralVault.claim(engine, owner)` sends tokens **directly to the entitlement owner** after claims are enabled; it does not credit free balance or require another withdrawal |
| Partial reduce-only/version/price-prefix repairs still pending | Current deployed source includes the recorded non-oracle repairs. Do not reopen resolved findings merely because the PDF predates them |
| Oracle deployment/services not established by the older report | The report already recognizes oracle implementation. The newer branch adds substantial services and a verified testnet deployment; real-engine integration and operational setup remain unfinished |
| Existing Kimi adapter does not establish a qualifying runtime feature | The report already recognizes the NVIDIA adapter. Reuse the current shared model transport; direct Kimi-provider support and qualifying real-use evidence are separate decisions |
| Production CRE metadata might require a receiver rewrite | Current oracle accepts metadata of **at least** 62 bytes and therefore accepts documented 64-byte production metadata. Add a production-shaped regression test; do not report a strict-62 bug that is not present |
| Binding the real oracle to the existing fixture | Its authority/listing are constructor-bound. A new correctly configured engine/listing is necessary |

## 3. Difficulty and track fit

Difficulty is an engineering judgment for a working, demonstrable feature, not just installing an SDK. It is **incremental to the shared foundation in section 5**; it is not a delivery-time estimate.

- **Low:** configuration, documentation or a small adapter; little new trust surface.
- **Medium:** real client/service integration, persistence, error handling and test coverage.
- **High:** new operational workflow, account security or external trading venue.
- **Very high:** new custody/economic semantics or a separate product.
- **Access/eligibility blocked:** missing vendor access or organizer confirmation; more coding alone cannot resolve it.

| Primary track | Fit for current Eros | What would make the submission credible |
|---|---|---|
| 1. Onchain Finance & Trading | **Strongest** | Real owner-funded trading, risk/account views, cancellation, settlement/claims and a usable product |
| 2. Consumer Products & Payments | Separate scope | Actual recipient/payment experience; a trading deposit screen is not a payments product |
| 3. Social, Attention & Culture | Separate scope | Genuine community/creator interaction or ownership; cultural market names alone are insufficient |
| 4. Trust, Identity & AI Infrastructure | Possible oracle/evidence side product | A reusable service another Monad application can consume, with verifiable evidence/security behavior |

Confirm whether a single project may enter the relevant combinations. Assigned-track labels do not independently prove exclusivity, **except the PDF explicitly ties Qwen to Track 4 winners**. All live eligibility/stacking decisions belong to the organizers, not this plan.

### All 21 targets at a glance

`B01-B21` below are **PDF bounty identifiers**, not our historical engineering task IDs.

| ID | Target | Difficulty | Architecture impact | Recommendation |
|---|---|---|---|---|
| B01 | Community team | Low / administrative | None | Claim only if genuinely eligible |
| B02 | Agora cross-border payments | High | Separate Mera/payment application flow | Conditional side product |
| B03 | Agora mobile trading | High | Mera + AUSD display + **actual Perpl venue** | Build only if prioritizing this bundle |
| B04 | Envio | Medium | Extend existing oracle indexer into full product read model | **Core priority** |
| B05 | Aurora Intents | Medium-High | Cross-chain funding sidecar | After proving a supported route |
| B06 | Cleanverse | Very high + access gate | Credential-enforced asset/custody design | Defer until requirements/access are concrete |
| B07 | Kuru consumer trading | High | Additional spot venue and UX | Optional separate venue |
| B08 | Kuru new assets | Very high | Token issuance/redemption + Kuru market/liquidity | Separate economic workstream |
| B09 | Dynamic | Medium | Primary wallet adapter | Choose instead of Privy/Mera account layer |
| B10 | Alchemy | Low-Medium | RPC/read/simulation/reliability service | **Core priority** |
| B11 | Chainlink CRE | Medium-High | Complete existing oracle workflow integration | **Core priority**, dependent on real oracle path |
| B12 | Perpl API automation | High | Separate venue client + bounded bot | Reuse B03 adapter if selected |
| B13 | Perpl analytics/risk | High + data gate | External protocol/wallet data model | Prove history access first |
| B14 | Privy | Medium | Primary wallet adapter | Choose instead of Dynamic/Mera account layer |
| B15 | Nansen | Medium | Advisory external intelligence service | Optional, only with useful supported data |
| B16 | Hunyuan | Very high product scope | Multimodal creator/community feature | Low priority for Track 1 |
| B17 | Kimi | Medium for review assistance | Extend existing model/evidence pipeline | Best-fit optional AI target |
| B18 | Qwen 3.8 Max | High + Track 4 gate | Reusable multi-step evidence agent | Conditional separate infrastructure product |
| B19 | Mera account UX | High | Whole primary account/recovery layer | Choose deliberately; unlocks B02/B03 |
| B20 | Mera non-wallet use | Medium-High | Private, reconstructable application context | Optional genuine non-wallet feature |
| B21 | MetaMask Agent Wallet plugin | Medium | Separate policy-controlled CLI client | Good follow-on to shared transaction client |

## 4. Proposed architecture and boundaries

```text
Frontend/PWA or MetaMask agent client
  -> one selected account owner (EOA or deliberately supported smart account)
  -> shared Eros transaction builder, preview, policy and receipt handling
  -> existing CollateralVault + BookRiskEngine + ReserveVault

Alchemy / existing QuickNode -> chain-pinned reads, simulation, send and monitoring
Envio                      -> derived history, order activity, account/claim UI
Independent INDEX publisher -> authenticated PriceIngress observations
CRE + resolution services   -> ResolutionOracle -> real engine -> bounded clearing

Optional, explicitly separate routes:
Aurora -> user's destination wallet -> ordinary Eros deposit/allocation
Agora  -> payment/settlement flow, not Eros cash ledger
Kuru   -> spot balances, market, orders and receipts
Perpl  -> exchange account, collateral, orders, funding and liquidation model
AI / Nansen -> advisory evidence or context, never unilateral custody/finality
```

### Rules every integration must preserve

1. **The onchain sender owns the account.** An authentication user ID is not an Eros trader. A shared backend/router calling `deposit`, `allocate` or `placeOrder` becomes the sender; it must not pretend those credits belong to an unrelated user. Use the actual user wallet or a user-owned, explicitly supported smart account.
2. **No generic `depositFor`, trusted-forwarder or meta-transaction patch is needed for the first wallet integrations.** If later required, it is a separate contract/security design, not a login feature.
3. **Do not combine venue balances.** Eros, Perpl and Kuru have different custody, margin, units and withdrawal rules. Aggregated display is not cross-margining.
4. **Do not replace event INDEX with our own book price.** Book-derived PERP sampling and independent INDEX serve different purposes. A sponsor's generic token price or wallet labels are not automatically a valid binary-event feed.
5. **Do not turn on unsupported economics for a demo.** Current concrete engine enforces the fully backed 1x initial profile; funding/recovery/conversion and ordinary leveraged liquidations are not demonstrated by this deployment.
6. **Use exact integer units.** Collateral atoms have six decimals; Q is `10^18` per atom; one lot is `0.001` claim; ticks are `1..999`. Reuse `packages/risk-sdk` decoders and contract views, not vendor sample floating-point arithmetic for transaction amounts.
7. **Oracle Final is not payout readiness.** Show halt, accepted outcome, preparation, `claimsEnabled`, claimed and paid separately. Use the risk SDK's settlement decoder.
8. **Read one coherent block.** Pin chain, engine, ABI/code identity and block/hash across risk/market/account views; label pending data and reorgs. Do not turn unknown/stale data into zero or infer a fill from a transaction submission alone.
9. **Keep private keys/API secrets off the frontend and Git.** Public app IDs and contract addresses are different from server secrets. An LLM or plugin does not receive a deployment/private signing key.

## 5. Shared work packages: build once, reuse across sponsors

Paths under `contracts/` and `packages/risk-sdk/` exist on the risk branch. Paths under `oracle/` exist on **`feat/oracle`**, not in the current risk checkout. Paths marked **NEW** are proposed locations; reuse equivalent frontend/service directories if the integration team already has them elsewhere. These are not claims that the files exist or that vendor APIs have our wrapper names.

### SP-00: freeze the integrated deployment identity and scope

**Change/add:** NEW `packages/integration-config/` for a validated network/market manifest; consume `addresses.md`, exported ABI wrappers and the oracle deployment manifest. Record chain ID, source SHA, runtime identity, deployment/start block, collateral/vault/engine, authority/registry, source/rules hashes and listing horizon.

**Required behavior:** refuse wrong-chain/token/ABI combinations; keep test fixtures visibly labeled; separate active-demo and terminal-test markets. Current fixture was verified inactive, unminted and unpriced. Its scheduled halt is **2026-10-13 19:39:36 UTC**, whether or not it is activated.

**Done when:** client startup detects wrong manifests and can show the source-bound configuration of a usable test market. Do not copy sponsor mainnet addresses into a testnet manifest.

### SP-01: shared owner-correct transaction client

**Change/add:** extend `packages/risk-sdk/src/index.ts`; add NEW `transactions.ts`, `identity.ts`, `receipts.ts` and matching tests in that package. Add NEW `packages/wallet-adapters/` and product screens under proposed `apps/web/`.

**Exact flows:**

- From the selected owner: collateral `approve(vault, atoms)` -> `vault.deposit(atoms)` -> verify `freeAtoms(owner)` -> `vault.allocate(engine, atoms, false)`.
- Read `participantId(owner)`, `accountRiskView`, `marketRiskView` and `previewOrder` at one block. Allocation already performs participant registration.
- Build `placeOrder` using the concrete ABI's `Place` tuple: `kind`, `isBuy`, `reduceOnly`, `tick`, `size`, `maxFills`, `expiryBlock`. Simulate, sign, submit, reconcile `Fill` events and remaining order state.
- Support `cancel(orderId)` and `cancelAll()`, including epoch-based invalidation and partial fills. An order ID of zero is not a universal transaction-failure signal.
- Live excess-collateral exit: engine `release(atoms)` -> verify vault free balance -> vault `withdraw(atoms)`.
- Final payout: require `claimsEnabled`, then `vault.claim(engine, owner)` or the engine's `claimTrader(owner)` wrapper. Delivery may be permissionless, but the beneficiary is fixed to the entitlement owner.

**Done when:** two real owners can fund, trade, cancel and exit with correct balances; rejection, stale preview, wrong owner/chain and duplicate receipt callbacks are tested. Wallet adapters must not duplicate risk arithmetic or bypass contract decisions.

### SP-02: canonical indexed history and current-state reads

**Change/add:** extend oracle branch `oracle/indexer/config.yaml`, `schema.graphql`, `src/handlers/` and tests; add handlers for the concrete engine and vault. Add an application read API/query consumer rather than a second inconsistent accounting indexer.

**Implementation details:**

- Track market/owner/order identity, `Fill`, cancellations, epochs, `AccountBalance`, `MarketBalance`, pricing state, oracle lifecycle, preparation, escrow and `Paid` events.
- Do not count `Fill` plus `PairedPosting` as two trades. `BookFill` in the PDF is a proposed alias, not the emitted event name.
- Backfill from actual deployment blocks; register engines from the actual registry/factory discovery event after pinning its ABI. Maintain block hashes, deterministic log IDs and rollback/replay behavior.
- **Current vault has no dedicated withdrawal event.** For the minimal integration, use block-pinned `freeAtoms`/claim reads for current balances rather than claiming an event-only free-cash ledger is complete. A dedicated withdrawal event is an optional later contract change/new deployment, not a reason to rewrite custody now.
- Use Envio's supported effect/caching mechanism for external reads; preserve historic block identity. A latest-state RPC read must not rewrite historical balances.

**Done when:** replay and live views match block-pinned contract values after partial fills, epoch cancels, release/withdrawal, finality, claims and a simulated reorg; UI visibly consumes the service.

### SP-03: real oracle/factory integration and new market

**Change/add:** refresh stale oracle seam imports/tests; implement NEW `contracts/src/factory/MarketFactory.sol` or a jointly agreed deployment module implementing `oracle/src/interfaces/IMarketFactory.sol`. Update oracle deployment/listing tools and real-engine integration tests. Do not resurrect duplicate provisional types to make old tests compile.

**Exact outstanding work:**

1. Replace retired `@eros-provisional/MathTypes.sol` / accounting imports and standalone `FinalOutcome` imports with current types/interfaces. Pin a combined compiler/profile; current accepted risk build is Forge 1.8.3, solc 0.8.30, Prague, optimizer 200.
2. Implement registry-only deployment, unique market IDs, constructor-bound listing/authority, token/vault checks, vault registration and exact listing-hash handshake. The concrete engine uses constructor initialization, not the stub's public initializer. Define who authorizes registration on an existing vault; a factory does not automatically inherit its governor's authority.
3. **Measure factory feasibility before finalizing its implementation.** Engine runtime is 120,402 bytes and initcode 130,572 bytes; the recorded direct creation consumed 29,245,915 receipt gas. Embedding creation code in a factory or nesting it under registry execution can exceed limits even though direct deployment succeeded. If necessary, use a deliberately designed bytecode-loading/deployment arrangement. Changing the atomic protocol would instead be a **coordinated interface/specification redesign**, not a drop-in implementation of the current deploy/initialize/register contract. Do not silently substitute a predeployed arbitrary engine or remove handshake checks.
4. Create a **new** market bound to the actual oracle. Validate the real listing, minimum 24-hour horizon, INVALID/void policy, actual roles and independent INDEX parameters. Reusing the manual-authority fixture is not an alternative.
5. Configure globals, trust set, workflow/forwarder allowlists, treasury funds and keeper/watchdog roles. Existing oracle deployment is not proof that these are configured.
6. Measure and add keeper gas limits for `captureInvalidPrice`, `prepareSnapshotChunk32`, `preparePayoutChunk32`, `finishPreparation`. Replace the keeper's stub/real heuristic based only on whether `StubMarketFactory` remains in the deployment manifest with explicit validated engine identity.
7. Repair Windows URL/path handling or prove the services on the supported Linux deployment environment; rerun combined tests and real lifecycle exercises.

**Existing evidence:** previous read-only observation at testnet block **68,000,500** found oracle code matching its seven-contract manifest, but globals/trust set uninitialized, stub factory selected, simulation mode enabled with zero simulation forwarder and empty assertion/watchdog float ledgers. These are dated observations, not a fresh liveness assertion.

**Done when:** real listing -> actual collateral -> activation -> authenticated INDEX -> Eros fills -> halt -> oracle finality -> bounded preparation -> direct owner claims works on the same integrated market. Preserve separate markets for the continuing demo and terminal tests. Oracle implementation work must be coordinated with its owner; this document does not authorize that work.

### SP-04: independent INDEX publisher and runtime operations

**Change/add:** obtain the current collector branch/source and its owner first. If no deployable service exists, propose NEW `services/price-publisher/` implementing the existing `contracts/src/pricing/PriceIngress.sol` contract. Do not assume the PDF's inaccessible pricefeed branch is either integrated or nonexistent elsewhere.

Pin market/source/rules, signer, observation time, sequence, price and depth/spread rules. The current signature verifies a **raw `keccak256(abi.encode(...))` digest including chain and engine**, not `personal_sign` and not an EIP-712 `\x19\x01` envelope. Add exact cross-language vectors before signing anything.

Add durable sequence/nonce state, signed-payload persistence, simulation, broadcast/receipt reconciliation, reorg recovery, staleness alarms and signer-loss recovery procedures. **Current `PriceIngress` pins signer/rules once and has no rotation entry point.** Recovering custody of the same signer is different from replacing it; replacement needs a new market/deployment or separately specified contract work. An offchain configuration change cannot rotate the accepted key. Maintain an authenticated independent INDEX through trading and the scheduled INVALID window. The local book sampler's two-block/strict-newer-INDEX-prefix rules remain intact.

**Done when:** restart/retry cannot duplicate or reorder economic observations; stale/unavailable data fails closed with clear UX; no unrelated sponsor price feed is used as event truth.

### SP-05: RPC, gas and receipt reliability

**Change/add:** NEW `services/chain-gateway/` or an equivalent shared server module with network-specific Alchemy and existing QuickNode clients; simulation, receipt tracking, coherent reads, rate budgets, health checks and redacted logs.

Keep one durable nonce authority per sending account. A provider retry must reconcile the original transaction before replacing it; it must not create a second deposit/order. Do not mix blocks from different providers into one risk preview.

Current Monad documentation lists a **30M per-transaction gas limit**, **128 KiB runtime limit**, gas-limit-based charging and explicit transaction finality states. Test full factory creation and large operations on the target network, not only Ethereum-default local settings. EIP-7702 wallets have Monad-specific reserve/deployment restrictions; check the chosen account implementation rather than assuming every wallet uses delegation. [Monad differences](https://docs.monad.xyz/developer-essentials/differences), [network summary](https://docs.monad.xyz/developer-essentials/summary).

**Done when:** provider failure, timeout, stale read, reverted receipt and reorg paths work without double actions. RPC credits do not pay gas or make price data authoritative. Existing QuickNode remains useful; adding Alchemy does not require discarding it. [QuickNode Monad documentation](https://www.quicknode.com/docs/monad).

### SP-06: evidence and honest feature boundaries

**Change/add later:** proposed `docs/sponsors/` for per-integration setup/demo notes and `artifacts/sponsors/` for redacted source-bound evidence. Keep feature flags for disabled/unsupported integrations and distinguish testnet, simulation, mainnet data and actual live transactions.

**Done when:** each claimed sponsor has a working consumed feature, reproducible configuration, real usage evidence and the correct submission artifacts. Installation, a logo, mocked data or an unconsumed endpoint is not completion.

## 6. Sponsor-by-sponsor implementation

### B01 - Community team project

- **Add/change:** no code. Verify the actual community/campus affiliation and that the event has onboarded that group; set the correct team profile field.
- **Blocker:** real affiliation and portal eligibility are unknown. Do not invent a group membership.
- **Completion evidence:** profile selection survives reload and the working Eros submission identifies the represented community. This does not compensate for missing product functionality.
- **Source:** PDF p.12; administrative requirements need current portal confirmation.

### B02 - Agora cross-border payments

- **Add/change:** NEW `packages/venue-adapters/src/agora-settlement.ts` and mobile recipient/send/status screens. Use Mera onboarding, AUSD balances, pair discovery, quote/minimum-output/deadline checks, approved recipients, whitelist handling and an idempotent receipt journal. Keep this outside Eros market cash.
- **Actual API boundary:** Instant Settlement uses a **factory and swap pairs**, not a generic remittance function. Discover the supported pair, quote with `getAmountsOut`, approve the correct spender and use the documented `swapExactTokensForTokens` call. Confirm the event's intended mock-payment flow; a swap receipt alone is not evidence of real cross-border fiat payout.
- **Current technical update:** official deployments list Monad testnet AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` and Instant Settlement factory `0x8468587Af422ad440F58a57E955eCA6A970b5375`. The latter is **not the pair address**. Verify chain/code/ABI, pair liquidity and whitelist eligibility before implementation. [AUSD deployments](https://docs.agora.finance/developer/contract-deployments), [settlement deployments](https://docs.agora.finance/instant-settlement/protocol-deployments), [fixed-input swaps](https://docs.agora.finance/instant-settlement/guides/executing-swap/swapping-fixed-input).
- **Main blockers:** separate consumer product, Mera recovery/security, pair access/liquidity, Track 2 eligibility. This is not achieved by renaming an Eros withdrawal button.
- **Done/demo:** correct recipient receives the documented testnet asset, expired/failed/duplicate requests are handled, and onboarding/balance/send/receive are shown. PDF p.13 requires feature text and a <=2-minute video.

### B03 - Agora mobile trading

- **Add/change:** mobile/PWA Mera account flow, real AUSD wallet balance and a **Perpl** tab using the B12 adapter. Explicitly separate Eros and Perpl collateral/positions.
- **Token distinction:** official Perpl documentation uses AUSD on mainnet but a different testnet USD token, `0xdf5b718d8fcc173335185a2a1513ee8151e3c027`. Holding testnet AUSD does not automatically fund Perpl. [Perpl network/account documentation](https://raw.githubusercontent.com/PerplFoundation/api-docs/main/README.md).
- **Main blockers:** actual Perpl onboarding/collateral, API enrollment access, mobile/passkey reconstruction, and confirmation of the permitted testnet demonstration. No Eros contract rewrite is required for this extra venue.
- **Done/demo:** one app demonstrates **Mera authentication + AUSD balance + an actual Perpl trade**, with fill reconciliation and cancellation/error handling. AUSD display plus an Eros-only trade is insufficient. PDF p.14 requires explanation and <=2-minute video.

### B04 - Envio

- **Add/change:** execute SP-02 by extending the existing oracle HyperIndex project, then consume it in order activity, account history and settlement-progress screens. Both Monad networks have documented data endpoints; chain support itself is not the blocker. [Supported networks](https://docs.envio.dev/docs/HyperIndex/supported-networks).
- **Main blockers:** live addresses/start blocks, actual market activity, hosted service and consuming UI. Test precision, rollback, partial fills and epoch invalidation; use contract reads for state not fully represented by events.
- **Done/demo:** public config/schema/handlers, live GraphQL/API consumer and replay-versus-contract parity. Use real `Fill` events and canonical accounting checkpoints without double-counting. [HyperIndex overview](https://docs.envio.dev/docs/HyperIndex/overview).
- **Submission:** PDF p.15 requires meaningful-use text; extra <=2-minute video is optional, but the working pipeline is not.

### B05 - Aurora Intents

- **Add/change:** NEW `services/funding/src/aurora.ts`, a durable funding-intent table and source-chain/asset/recipient/refund/status UI. Query supported assets, request a quote, execute the user's approved route and reconcile final destination receipt before offering Eros allocation.
- **Boundary:** deliver to the **user's wallet**, then SP-01 approve/deposit/allocate. An ERC-20 transfer directly into our vault does not create `freeAtoms` credit. Current controller-minted fixture collateral is not automatically routable.
- **Main blockers:** exact source/destination asset route, testnet availability, liquidity and app credentials. Monad is documented as a source/destination chain, but that does not prove the desired testnet route. [Supported chains](https://docs.intents.aurora.dev/intents-deposits/supported-chains), [API integration](https://docs.intents.aurora.dev/intents-deposits/quickstart/api-integration).
- **Done/demo:** genuine completed cross-chain funding, expiry/refund/retry handling and subsequent owner-credited deposit. Pin the API reference rather than copying inconsistent sample snippets. PDF p.16 requires explanation; optional <=2-minute video. Do not claim a mock route as live.

### B06 - Cleanverse

- **Add/change:** first obtain CVI/CVA specifications, ABI, supported deployments and sandbox access. Then design an isolated credential-aware asset/custody path covering identity, authorization, revocation, transfer/issuance/redemption and exit handling.
- **Required boundary in the PDF:** **both CVI and CVA** are required, with onchain wallet-bound CVI verification before **every CVA transfer/settlement**. Wallet badges or frontend checks are insufficient: direct contract calls must respect the policy. Adding these rules to pooled Eros custody changes its invariants and needs specification, threat model, tests and a new deployment. Prefer a separately scoped product rather than patching the large engine for a prize.
- **Main blockers:** public documentation redirects to an invitation gate; exact interfaces are unverified. Define what happens to open positions and legitimate payouts when credentials expire/revoke before writing enforcement. Track 4/cross-track eligibility also needs confirmation. [Cleanverse documentation](https://docs.cleanverse.com/).
- **Done/demo:** unauthorized direct calls fail, valid users complete the intended CVI/CVA flow, and revocation/unwind behavior is proved without accidental permanent lockup. PDF p.17 requires explanation and <=5-minute video.

### B07 - Kuru consumer trading

- **Add/change:** NEW `packages/venue-adapters/src/kuru.ts`, a distinct spot trading screen and Kuru-specific order/balance index. Pin router/margin/market addresses and SDK; fetch market parameters; implement integer-precise quotes, slippage, supported deposits, IOC/GTC/cancel and reconciliation.
- **Core impact:** no replacement of Eros matching or risk accounting. Kuru has its own spot market and margin-account mechanics. Official docs list separate mainnet/testnet deployments and `MarketRegistered`/`Trade` discovery/activity events. [Contract addresses](https://docs.kuru.io/contracts/Contract-addresses), [integration events](https://docs.kuru.io/contracts/Integration), [orderbook SDK](https://docs.kuru.io/sdk/orderbook-sdk).
- **Main blockers:** real liquidity, supported token pair, user need and actual Kuru execution. SDK example floating-point arithmetic must not become our transaction amount policy.
- **Done/demo:** intended consumers can execute and cancel real Kuru trades with understandable costs; submit segment/demand evidence and onboarding/retention plan. PDF p.18 expects a consumer product, not merely an unused SDK or a hidden collateral swap.

### B08 - Kuru new assets

- **Add/change:** only after a separate economic design, NEW `contracts/src/assets/OutcomeToken.sol`, `OutcomeVault.sol`, issuance/redemption tests and a Kuru market deployment/liquidity module. Proposed filenames describe our contracts, not Kuru APIs.
- **Why difficult:** an Eros signed internal position is **not an ERC-20 spot asset**. A viable proposal is separately fully backed YES/NO issuance with supply/backing conservation, complete-set mint/burn and explicit valid/INVALID/VOID redemption. Existing disabled conversion is not authorization to tokenize leveraged positions.
- **Main blockers:** asset qualification, backing/rounding/redemption invariants, operational/legal constraints and genuine market liquidity. Any bridge to Eros must prove that the same backing cannot support both token and ledger claims.
- **Done/demo:** issuance -> actual Kuru trade -> final resolution -> correct redemption, including INVALID, VOID and failure paths; show real demand and an asset roadmap. PDF p.19 requirements are much broader than market deployment. [Kuru market deployment](https://docs.kuru.io/sdk/deploy-market).

### B09 - Dynamic

- **Add/change:** NEW `packages/wallet-adapters/src/dynamic.ts`, configured app/origin/network and account-switch/logout/recovery UI. Use the selected wallet's supported client to execute SP-01; invalidate cached owner/chain state on changes.
- **Core impact:** no risk/book modification. Do not infer batched execution, session delegation or sponsored gas merely from wallet authentication. [Wallet access](https://docs.dynamic.xyz/wallets/using-wallets/accessing-wallets), [network switching](https://docs.dynamic.xyz/chains/network-switching).
- **Main blockers:** app credentials, usable frontend, funded active market and tested recovery. Choose this **instead of** Privy/Mera for the same primary account layer, unless distinct account choices are intentionally supported and separately demonstrated.
- **Done/demo:** Dynamic-signed funding/order/cancel/exit actually works, including wrong-network, rejection and expired session cases. PDF p.20 requires meaningful-use text; extra <=2-minute video optional.

### B10 - Alchemy

- **Add/change:** implement SP-05 with an actual Alchemy-backed read/simulation/receipt feature; preserve QuickNode as an independent fallback. Cache/batch bounded reads and monitor quotas/errors.
- **Core impact:** no economic contract changes. Verify the specific Monad network and product; generic support does not imply every enhanced API or account-abstraction product is available there. [Monad API](https://www.alchemy.com/docs/monad/monad-api-overview), [feature matrix](https://www.alchemy.com/docs/reference/feature-support-by-chain).
- **Main blockers:** configured key/plan, exact method support and observable consumption. Switching an RPC URL does not make a local-only collector a safe live publisher.
- **Done/demo:** real application requests use Alchemy and the resulting reliability/simulation feature is visible and tested. PDF p.21 requires explanation; optional <=2-minute extra video. Its award is credits, not cash.

### B11 - Chainlink CRE

- **Add/change:** reuse `oracle/workflows/resolution/main.ts` and `oracle/src/ResolutionOracle.sol`; configure real source HTTP, frozen FeedSpec/hash, chain selector, workflow identity, secrets and forwarder/trust. Complete SP-03, rather than adding another settlement authority.
- **Payload/security:** preserve the eight-word business report, domain/market/source freshness checks and replay rejection. Production forwarder metadata is documented as 64 bytes; current receiver's `length >= 62` check is compatible. Add a 64-byte regression test and validate identity/authentication, not just byte length. [Consumer security and metadata](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts).
- **Availability:** current release notes document Monad mainnet simulation/production support and Monad testnet simulation. Live deployment remains approval-dependent; a successful CLI simulation is not a production DON deployment. [CLI 1.29](https://docs.chain.link/changelog/cre-cli-v1-29-0--monad-mainnet-support-and-confidential-workflows-62ca6), [CLI 1.30](https://docs.chain.link/changelog/cre-cli-v1-30-0--new-testnet-support-for-simulation-09dd0), [CRE overview](https://docs.chain.link/cre/overview).
- **Main blockers:** real data source, configured trust, successful chain interaction and current real-engine clearing path. Failed placeholder fetches must abstain, not produce an outcome. A valid L1 report starts the proposal/assertion lifecycle; it must not bypass disputes/liveness and directly pay users.
- **Done/demo:** successful real-API workflow simulation or approved live run -> authenticated proposal -> eventual finality -> prepared claims; retain failure/replay/conflict tests. PDF p.22 requires <=2-minute CRE demonstration.

### B12 - Perpl API automation

- **Add/change:** NEW `packages/venue-adapters/src/perpl.ts`, `services/perpl-bot/`, durable order journal and bounded strategy controls. Separate account creation, forwarding authorization and API enrollment. Use owner-authorized EIP-712 enrollment of a scoped Ed25519 API key, exact request signing and sequence-aware streaming/reconciliation.
- **Authorization:** programmatic enrollment needs the app/server Origin whitelisted by Perpl. Read/trade API scopes are distinct; API keys do not authorize withdrawals. Keep external-venue credentials segregated and encrypted. [Official integration guide](https://github.com/PerplFoundation/api-docs/blob/main/integrations.md).
- **Main blockers:** sponsor enrollment access, real supported collateral, working adapter and a bounded approved trading budget. The bot must use **Perpl's** margin/fees/funding/liquidation rules, not Eros binary-outcome mathematics.
- **Done/demo:** actual order/fill/cancel, partial batch failure, reconnect, duplicate-request handling, stale-data pause and kill switch. An API acknowledgment is not a fill; batches are not assumed atomic. Report performance after fees/funding/slippage, not guaranteed profit. [REST reference](https://raw.githubusercontent.com/PerplFoundation/api-docs/main/rest-endpoints.md).
- **Submission:** PDF p.23 requires working automation link and <=2-minute real-activity video. Reuse this adapter for B03; do not build two independent order pipelines.

### B13 - Perpl analytics/risk

- **Add/change:** NEW `services/perpl-analytics/` with venue-specific backfill, fills/positions/funding/fees/collateral/liquidation tables and dashboard. Define realized/unrealized PnL, flow-adjusted drawdown, aggregation windows and missing-data behavior before exposing metrics.
- **Hard blocker:** documented public market data does not imply access to every wallet's private history. Account/order/history endpoints are caller-key scoped. Obtain a permitted protocol-wide source or build the required onchain index. A deliberately narrower feature may still be useful, but **does not meet the full bounty requirements**; do not promise arbitrary-wallet analytics without data coverage. [Perpl REST reference](https://raw.githubusercontent.com/PerplFoundation/api-docs/main/rest-endpoints.md).
- **Full requested coverage:** PDF p.25 specifies volume over 24h/7d/30d/all-time; OI/TVL/fees/users; flows and market skew; liquidations/funding; positions and venue-native liquidation prices; realized/unrealized PnL; win rate, profit factor, flow-adjusted drawdown and behavior; global wallet search/watch/compare and timeframe controls in a fast dark UI. Define each metric's denominator, data window and completeness before claiming support.
- **Core impact:** Eros risk views remain Eros-only. Missing Perpl fees, position history or liquidation records must be marked unavailable rather than zero.
- **Done/demo:** source-reconciled protocol metrics and address profiles supported by the actual dataset, with timestamps, drilldown and repeatable calculations. PDF p.24-25 requires dashboard link and <=2-minute walkthrough.

### B14 - Privy

- **Add/change:** NEW `packages/wallet-adapters/src/privy.ts`, configured provider and selected-wallet/recovery UI. Explicitly choose the wallet address for transaction sends; use SP-01 for all amounts/calldata/receipts. Only the app ID belongs in public configuration; server credentials stay private.
- **Core impact:** no contract rewrite. Gas sponsorship requires actual configured network support, billing and transaction policy; an SDK flag is not free gas. [Send transaction](https://docs.privy.io/wallets/using-wallets/ethereum/send-a-transaction), [gas sponsorship](https://docs.privy.io/wallets/gas-and-asset-management/gas/ethereum).
- **Main blockers:** app domain setup, active funded market, recovery tests and a consistent owner. Multiple connected wallets must not cause default-wallet miscrediting.
- **Done/demo:** real Privy-signed deposit/order/cancel/exit with rejected, reverted and expired-session paths. Login alone is insufficient. PDF p.26 requires meaningful-use text; optional <=2-minute video. Alternative to Dynamic/Mera for the primary account layer.

### B15 - Nansen

- **Add/change:** NEW `services/intelligence/src/nansen.ts` with server-side credentials, pagination/deduplication, bounded cache, quotas and chain/time/provenance labels; add useful wallet/collateral-flow context and alerts to the UI.
- **Coverage:** current smart-money DEX endpoint schema includes Monad but covers a trailing 24-hour window; it is not an arbitrary historical query or proof of testnet coverage. If used beside our testnet app, label the external mainnet context explicitly. [Current endpoint schema](https://docs.nansen.ai/api/smart-money/dex-trades.md).
- **Main blockers:** API access/credits and a relevant supported dataset. Do not infer Eros positions, exact Perpl PnL or event outcomes from unrelated token activity/labels.
- **Done/demo:** a useful sourced feature beyond raw JSON/basic price, with stale/empty/rate-limited behavior. Keep it out of margin admission, custody, settlement and authoritative INDEX construction. PDF p.27 requires explanation; optional <=2-minute video.

### B16 - Tencent Hunyuan

- **Add/change only if deliberately scoped:** NEW `services/media-jobs/` for authenticated generation, polling, idempotency, moderation and storage; a creator/community UI where generated media actually changes participation. Add a separate ownership/participation contract only after defining that product; keep it outside risk custody.
- **Technical starting point:** official Tencent documentation exposes text/image-to-3D job submission, but the hackathon's exact permitted model/modality/account must be confirmed. [Hunyuan 3D API](https://www.tencentcloud.com/document/product/1284/75540).
- **Main blockers:** Track 3 fit, cloud/region access, licensing/consent, latency and a genuinely interactive use case. A text oracle call or decorative generated banner does not establish the PDF's multimodal product requirement.
- **Done/demo:** useful end-to-end interaction, real model job evidence, safe failure/moderation behavior and published article. PDF p.28 requires the article and working Monad product; prize is vouchers, not cash. Do not treat generated content as factual resolution evidence.

### B17 - Kimi

- **Reuse:** `oracle/packages/oracle-sdk/src/models.ts`, CLI model calls and `oracle/services/panel-runner/src/models/client.ts` already provide model identities, response parsing, retries, citation checks and abstention. A NVIDIA-hosted Kimi route exists; this is not a greenfield panel.
- **Add/change:** choose an eligible hosting route and prove real usage. If direct access is selected, add a Kimi provider and `MOONSHOT_API_KEY` handling to the shared SDK, response parsing/tests and env documentation; do not fork another panel client. Current direct docs describe `kimi-k3` and the Moonshot chat endpoint. [Quickstart](https://platform.kimi.ai/docs/overview), [models](https://platform.kimi.ai/docs/models).
- **Product feature:** evidence/ambiguity assistance in the committee/reviewer UI, with original citations, model/provider/version and abstentions. Changing a frozen model/prompt/calibration identity requires the appropriate new listing/configuration, not silent replacement.
- **Main blockers:** account quota, real reviewer UX, actual authorized model calls and article. Current oracle validation has **zero categories cleared for automatic proposals**; do not disable that gate to demonstrate AI.
- **Done/demo:** real assistance with timeout/invalid-output/prompt-injection/conflicting-answer tests and required published article (PDF p.29). Assistance can be useful while final authority remains deterministic/committee-controlled.

### B18 - Qwen 3.8 Max

- **Eligibility gate:** the supplied catalogue ties this to **Track 4 winners**. Do not count it as available to a Track 1-only entry without organizer confirmation.
- **Add/change if eligible:** shared oracle SDK provider plus NEW `oracle/services/evidence-agent/`: capped multi-step planner, allowlisted read-only HTTP/chain tools, provenance graph, schema validation, SSRF protections, request/step budgets and an API another Monad application can use. No arbitrary shell tools, private keys or unilateral settlement power.
- **Current update:** official API docs now name `qwen3.8-max` and `qwen3.8-max-0902`; the uncertainty is selected workspace/region/account access and allowed parameters, not whether those identifiers appear in documentation. [Model Studio API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions).
- **Main blockers:** eligibility, exact model access, substantial reusable infrastructure and evaluation. A renamed Kimi call or coding assistant is not this product.
- **Done/demo:** useful multi-step evidence work with bounded tools, injection/loop/budget tests, reproducible model provenance and published article (PDF p.30). Credits are not cash.

### B19 - Mera account UX

- **Add/change:** NEW `packages/wallet-adapters/src/mera.ts`, stable relying-party domain/derivation versions, PRF-capable passkey setup, transient signer, funded account and reconstruction/recovery screens. The PDF requires **one-passkey-ceremony onboarding and scoped prompt-free sessions**, with no required seed phrase, extension, email/OTP onboarding or custody backend. Use the derived EVM owner throughout SP-01; do not store the root/key in local storage or server custody.
- **Critical limitation:** current `createSecp256k1SigningSession` exposes `signDigest` and `end`; it does **not** enforce target/selector/budget/expiry rules onchain. App policy around an in-memory EOA signer is not cryptographically scoped delegation. A compromised client can exceed that wrapper's policy. [Mera README](https://github.com/category-labs/mera/blob/main/README.md), [signing session source](https://github.com/category-labs/mera/blob/main/library/src/secp256k1.ts).
- **Decision needed before implementation:** choose explicitly disclosed testnet application-level protections, if sponsor requirements permit, or a reviewed smart-account/delegation design with real onchain enforcement. Do not present the first as the second. Pin this preview/pre-1.0 dependency and test actual browser/authenticator PRF/sync support.
- **Main blockers:** RP-domain stability, lost-passkey/reconstruction policy, session security and account funding. This is the **whole account layer** for the submitted flow, not a button alongside another provider that secretly owns the same account.
- **Done/demo:** clear browser storage, reconstruct the same address from supported passkey + public/encrypted metadata, execute a real transaction, and prove expiry/revocation behavior. PDF p.31 requires meaningful account UX and live reconstruction; extra <=2-minute video optional.

### B20 - Mera: One Passkey, Many Keys

- **Add/change:** NEW `packages/private-context/` for a real **non-wallet** feature, such as encrypted user-owned risk preferences or private reviewer notes. Use distinct app/version/purpose namespaces, authenticated encryption, fresh nonces, ciphertext storage and reconstructable metadata. Require consent before decrypted context goes to an LLM.
- **Boundary:** this can coexist with another wallet provider because the feature is explicitly not wallet signing. Deriving additional transaction keys does not meet the stated requirement. Public onchain positions are not made private by encrypting preferences.
- **Main blockers:** useful feature, supported synchronized passkey/PRF, ciphertext discovery and correct namespace/key separation. Pin the actual secret-vault API/types before implementation. [Mera exported APIs](https://github.com/category-labs/mera/blob/main/library/src/index.ts).
- **Done/demo:** reconstruct the **same encrypted non-wallet payload on a second supported device/fresh browser**, as well as after local storage loss; reject tampering, wrong context/passkey and nonce reuse; show no plaintext/root material in logs/storage. PDF p.32 requires non-wallet meaningful-use explanation; extra <=2-minute video optional.

### B21 - MetaMask Agent Wallet plugin

- **Add/change:** NEW `packages/metamask-agent-plugin/` from the official plugin template with package/command manifest, README, tests and `skills/eros/SKILL.md`. Add account/market reads and preview/place/cancel/claim commands using the shared Eros builder; add release/withdraw only with explicit outflow policy.
- **Security boundary:** all transaction submission **and signing**, including message/typed-data signing if exposed, must pass the host executor under its applicable capability/policy. Use `walletExecutor` for the supported transaction path; declare narrow read/submit capabilities and chain IDs. Enforce target/selector/amount/market/expiry limits in code. A skill document alone is not enforcement; do not import private keys or request mnemonic/config privileges. [Plugin build](https://docs.metamask.io/agent-wallet/plugins/build-a-plugin/), [executor/capabilities](https://docs.metamask.io/agent-wallet/reference/plugins/).
- **Availability:** current docs list Monad mainnet and testnet. Confirm the installed CLI chain list, plugin support (6.2.0+) and Node 22+; relay/gas sponsorship is a separate capability. [Supported chains](https://docs.metamask.io/agent-wallet/reference/supported-chains/).
- **Main blockers:** active market, funded plugin account, shared transaction client and policy/MFA behavior. Its owner is a separately identified account if different from the web wallet.
- **Done/demo:** installable plugin, real policy-approved transaction plus denial/MFA/partial-fill/reorg cases, public skill URL and required <=5-minute real-flow video (PDF p.33). Not a browser Snap or instructions-only bot.

## 7. Major blockers and what resolves them

| Blocker | Affected targets | Exact resolution / exit condition |
|---|---|---|
| Current deployment inactive, fixture collateral/manual authority, fixed halt clock | All Eros transaction demos | Correctly fund/activate/price a suitable demo market; use a new listing for real oracle or changed collateral; re-read current state before use |
| Real factory and oracle/keeper boundary unfinished | CRE, full lifecycle, AI evidence product | SP-03; size/gas proof, actual roles/configuration and real-engine end-to-end receipts |
| Independent INDEX delivery not proven in our branch | Active trading/INVALID demo | Obtain collector source/owner; SP-04 with source-bound signed vectors and live continuity |
| No integrated product frontend on current risk checkout | Wallet, Envio and most user-facing bounties | Share or build the frontend; SP-01/SP-02; use current SDK/ABI rather than inventing balances |
| Account provider choice and security model | Dynamic/Privy/Mera, Agora | Pick primary ownership model before funding; separately test recovery and permission enforcement |
| Factory gas/code headroom | Real market listing | Measure full path; select a safe deployment design before writing the final factory |
| External venue credentials, liquidity and collateral | Kuru/Perpl/Agora | Confirm actual deployment/token/pair, get access, fund explicit test budgets and record real activity |
| Protocol-wide Perpl history not established | B13 | Obtain public/sponsor data coverage or build a provable onchain data pipeline; do not invent completeness |
| Route availability | Aurora | Obtain a real supported quote for the intended chain/token pair; fixture collateral is not assumed supported |
| Gated specifications | Cleanverse | Sponsor-provided CVI/CVA documentation/ABI/deployments and agreed credential/unwind policy |
| Session enforcement stronger than library primitives | Mera account UX | Decide app-only versus reviewed smart-account policy; test and describe the actual guarantee |
| Model access and calibration | AI targets | Verify exact account/model; authorize bounded usage; keep automatic resolution disabled until its own evidence passes |
| Cross-track/stacking and submission requirements | All, especially B02/B06/B16/B18 | Confirm in the live portal/with organizers; preserve dated answers alongside the submission |

### Collateral decision: AUSD is not an env-only substitution

There are three different uses: **display AUSD in a wallet**, **use AUSD at an external venue**, and **make AUSD Eros collateral**. Only the last changes Eros deployment dependencies.

For that last option: qualify the exact network token, decimals, issuer controls, transfer behavior and freeze/pause/upgrade risks; explicitly agree the denomination/collateral policy against the current spec's six-decimal USDC assumption; deploy a new appropriate vault/engine listing; test exact receipt/send invariants and failed payouts. Our vault requires six decimals and exact transfers. Six decimals alone do not establish compatibility or equivalent economic assumptions. Agora documents upgrade/freeze controls. [Token security](https://docs.agora.finance/developer/security-and-compliance).

The minimal demo can retain clearly labeled Eros fixture collateral and show separate AUSD/Perpl balances where required. Whether that combination qualifies is an organizer decision; do not imply the fixture token is official AUSD.

## 8. Configuration inventory to add later

This is a **design inventory, not a ready-to-run `.env`**. Names marked proposed are not existing script consumers. Do not change `.env.example`, `addresses.md` or deployment state merely by copying this table.

| Configuration group | Existing source / proposed names | Handling |
|---|---|---|
| Eros chain/contracts | Existing `RISK_BOOK_*` address inventory, `ETH_RPC_URL`; [runbook](docs/runbooks/RISK_BOOK_ENV_AND_ADDRESSES.md) | Public addresses in versioned manifest; credential-bearing RPC URL private |
| Alchemy / QuickNode | Proposed `ALCHEMY_MONAD_RPC_URL`, `QUICKNODE_MONAD_RPC_URL` | Server-side secrets, chain checks, per-provider quotas |
| Envio | Existing oracle indexer env/config plus selected hosting/query URL and optional HyperSync token | Public query endpoint only if access policy permits; indexing tokens private |
| Dynamic / Privy | Proposed `DYNAMIC_ENVIRONMENT_ID` **or** `PRIVY_APP_ID`; vendor-specific backend secrets if needed | Public ID allowed; server secrets not exposed; configure allowed domains |
| Mera | Proposed RP ID/origin, derivation version, public reconstruction metadata schema | Not a stored PRF root/private key; recovery policy must be stable before funding |
| Aurora / Agora | Proposed `AURORA_APP_KEY`, chain/token/factory/pair/whitelist manifest | Discover supported routes; verify contracts independently before enabling writes |
| Kuru | Proposed network-specific router, margin account, market and token manifest | Pin SDK/ABI/decimals and liquidity assumptions |
| Perpl | Proposed network/API/WS endpoints, enrolled key ID and encrypted scoped Ed25519 key store | Separate read/trade access; owner authorization; never place private API key in public config |
| Nansen | Proposed `NANSEN_API_KEY`, chain/dataset/window configuration | Server-only key and credit budget |
| Kimi / Qwen / Hunyuan | Existing oracle provider keys where used; proposed `MOONSHOT_API_KEY` and provider-specific region/workspace credentials | Pin real supported provider/model; no paid calls until authorized; redact evidence |
| CRE | Existing workflow configs/secrets and oracle deployment manifest | Validate chain selector, forwarder, workflow identity and simulation/production mode |
| Agent plugin | Host-managed wallet session, explicit plugin chain/contract manifest | No mnemonic/private key export; no generic all-chain/all-contract capability |

## 9. Minimum acceptance matrix

These are **future checks**, not tests reported passed in this turn.

| Area | Required positive path | Required adverse cases |
|---|---|---|
| Identity/custody | Two owners fund and act only on their own accounts | Generic-router miscredit, wallet switch, wrong chain/token, duplicate deposit callback |
| Orders/risk | Preview -> real fill/partial fill/resting order -> cancel | Stale version/price, expiry, maxFills, reduce-only limits, cancelAll epoch, denied/reverted transaction |
| Exit/payout | Safe release -> free balance -> withdraw; final claim -> owner token transfer | Unsafe release, claims not ready, wrong recipient, repeated claim, token transfer failure |
| INDEX/PERP | Valid independent updates and correctly sealed book samples | Bad signature/domain, stale/out-of-order/future observation, insufficient depth, sampler invalidation |
| Oracle/CRE | Successful real-data report with current 64-byte metadata through authentic receiver and normal lifecycle | Truncated metadata (<62 bytes), wrong forwarder/workflow/owner, replay, conflicting result, fetch failure/abstention, engine revert rollback |
| Settlement operations | Measured bounded snapshot/payout jobs -> claims enabled | Missing gas profile, keeper restart, INVALID waiting/fallback, disputed/rejected/void outcomes |
| Indexer/read model | Replay equals same-block source views | Reorg, duplicate log, incomplete history, no withdrawal event, fill/accounting double-count |
| RPC/deployment | Correct chain/code; full factory deployment within limits | Provider disagreement, dropped receipt, nonce race, gas-limit failure, stale deployment manifest |
| Wallet/passkey | Correct address reconstruction and explicit authorized send | Unsupported PRF, lost metadata, domain change, expired session, rejected policy/MFA, false session-scope claims |
| External venues | Actual venue-native order and reconciled fill/balance | Partial batch failure, WS gap, authorization loss, venue margin rejection, wrong collateral/network |
| AI/data services | Real sourced useful output with provenance | Injection, malformed output, missing citations, rate/quota limit, empty/stale data, unbounded tools |

Contract/economic changes require focused regressions plus the applicable unified risk gates/full validation. Offchain-only work still needs typed tests, real contract simulations and end-to-end evidence. A prior accepted G7 is not automatic acceptance of new factory, custody, oracle or account-security changes.

## 10. Implementation order and responsibility

These are proposed work packages for the merged product effort, not reinstated A/B review lanes. Oracle work still needs coordination with its current owner. Nothing below is started or authorized merely by appearing here.

| Phase | Work | Exit condition |
|---|---|---|
| 0 - scope/access | Confirm portal rules, primary track, wallet choice, exact credentials/network/model/data access | No essential feature depends on an imaginary API, route, model permission or eligibility |
| 1 - usable core | SP-00/SP-01/SP-04; coordinate SP-03; establish active demo and terminal test markets | One real owner-correct Eros trade and a separately verified lifecycle exit |
| 2 - strongest sponsors | SP-02 Envio, SP-05 Alchemy, selected wallet, B11 CRE | Live product uses each integration, failures handled, source-bound evidence saved |
| 3 - reusable additions | B21 MetaMask client; B17 Kimi assistance; optional B15/B20 if useful | Real feature, security tests and required plugin/article assets |
| 4 - external venue bundle | B03/B12/B13 Perpl or B07 Kuru, chosen deliberately | Separate custody/risk model, actual venue activity and justified data coverage |
| 5 - larger products | B02 payments, B05 routing, B06 compliance, B08 issuance, B16/B18 alternate-track products | Separate approved scope and all access/economic/eligibility gates resolved |
| 6 - submission | SP-06, demo rehearsal, links/articles/videos and portal audit | Judges can reproduce every claimed feature; no stale/closed market or private dependency |

**Suggested responsibility split:** shared contract/integration owners handle factory, ABI/units and regression validation; oracle owner handles resolution/CRE/keeper and coordinates INDEX ownership; frontend/service owners handle wallet/client/indexer/venue UX; submission owner confirms organizer rules and captures evidence. Assign actual people before execution rather than reviving historical A/B approvals.

## 11. Submission evidence checklist

These limits/requirements are **from the supplied PDF**, not a fresh authenticated portal reading. Reconfirm before recording/uploading.

- Standard entry: accessible repository, working Monad product link with judge instructions, logo, technical video <=3 minutes and pitch <=2 minutes; optional 30-second ad is listed separately.
- B01: accurate community affiliation/profile selection.
- B02/B03: required feature explanation and <=2-minute video of the mandatory payment/trading combination.
- B04/B05/B09/B10/B14/B15/B19/B20: meaningful-use explanation and real feature; extra <=2-minute video is listed as optional, not permission to omit working evidence.
- B06: CVI/CVA explanation and required <=5-minute demonstration.
- B07/B08: actual Kuru feature plus target-user/asset demand, roadmap and the required product-specific justification; token issuance needs backing/redemption evidence.
- B11: required <=2-minute successful CRE simulation/live demonstration.
- B12/B13: working bot/dashboard link and required <=2-minute real activity/walkthrough.
- B16/B17/B18: required published article URL and working product showing real model value.
- B21: installable plugin/README, capability explanation, public `SKILL.md` URL and required <=5-minute real flow.

Record source commit, chain, market, transaction/job IDs, timestamps, real-versus-simulated components, model/provider identity and relevant test results. Redact credentials/private user evidence. Do not combine overlapping cash/credit awards into a guaranteed prize total.

## 12. Other sponsor resources and perks

PDF p.38 lists these separately from the 21 bounties. Grants, expiration and exact feature limits must be confirmed; listing a perk does not mean it is already allocated. Keep useful infrastructure behind the same client boundary rather than adding one integration per logo.

| Resource | Proposed use | Difficulty / blocker |
|---|---|---|
| QuickNode participant Build plan | Keep existing chain transport; bounded logs/reads/receipts behind SP-05 | Low; confirm enabled endpoints/quotas. Not gas funding or event truth |
| Tenderly participant Pro | Simulations, failed-transaction replay, alerts/debugging | Low-Medium; confirm Monad and large-contract feature parity |
| Dwellir participant Developer | Optional independent RPC fallback | Low; confirm chain/archive/log capabilities and quotas |
| Zerion participant/winner Builder | External wallet/token context | Medium; no assumed testnet coverage or Eros internal PnL |
| BlockVision participant Lite / winner Pro | Optional supported RPC/data tooling | Low-Medium; exact API/network access and budget |
| Spectrum offering | Undetermined until exact product/API is identified | Unknown; do not design a dependency around an ambiguous name |
| ack3 winner security scan | Scan pinned integrated source, reproduce and triage actual findings | Medium review work; scan offer is not an audit certificate |
| Chainstack winner Pro | Optional alternate RPC | Low; confirm grant and method support |
| Crouton Digital winner RPC | Optional additional provider if reliability warrants it | Low; confirm resource/rate/fair-use limits |
| Mercuryo winner onboarding support/credits | Optional fiat-to-supported-wallet onboarding | High; regional/KYC/payment/chain support, not needed for testnet demonstration |
| Envio winner hosted indexing | Host the canonical SP-02 indexer | Medium; hosting does not replace schema/handler/replay work |

## 13. Decisions needed before implementation

1. **Primary scope:** recommended Track 1 core bundle, or deliberately prioritize the larger Mera + Agora + Perpl mobile bundle?
2. **Primary wallet:** Privy, Dynamic or Mera; if Mera, what session threat model and recovery guarantee are required?
3. **Oracle/factory/INDEX ownership:** who supplies the live feed source, signer, factory implementation and operational roles for the new market?
4. **Network and funds:** which sponsor features accept testnet, which require mainnet data/activity, and what explicit transaction/API-credit budgets are authorized? No mainnet execution is authorized by this plan.
5. **Collateral:** keep the controlled Eros demo token, or separately qualify/deploy an AUSD-backed market? Do not conflate this with merely displaying AUSD.
6. **Access:** obtain real API/app/model credentials, Perpl enrollment/data access, routing quotes and any gated Cleanverse requirements before committing to those features.
7. **Organizer confirmation:** verify track/stacking eligibility, exact model/provider rules, current video/article fields and deadline using the live portal.

**Recommended next step:** approve one bundle and turn phases 0-2 into implementation tasks. Preserve the core risk/book invariants; add sponsor adapters around them. The largest optional targets should not delay a credible working Eros demo.

---

### Source navigation and review record

- Supplied local report: `C:/Users/gujja/Downloads/eros-metropolis-sponsor-integration-audit.pdf`. Coverage: tracks pp.5-7; shared workflows pp.8-11; B01-B21 pp.12-33; bundles/backlog/submission pp.34-37; perks p.38; source/caveat appendix pp.39-43.
- Current deployment: [deployment addresses](../addresses.md), [deployment progress](integration/DEPLOYMENT_PROGRESS.md). Historical assessment references: [risk/book tracker](integration/RISK_BOOK_TRACKER.md), [non-oracle fixes](integration/NON_ORACLE_FIXES.md), [unified status](merge/STATUS.md), [risk SDK](../packages/risk-sdk/README.md), [environment runbook](runbooks/RISK_BOOK_ENV_AND_ADDRESSES.md).
- Oracle paths cited above refer to `origin/feat/oracle@cb60d9c`. Prior read-only compatibility notes and chain observations are retained in ignored `tmp/oracle-integration-readiness-2026-10-04.md` and `tmp/oracle-review-chain-state.json`; they are local supporting evidence, not committed release artifacts.
- Public technical references are linked alongside claims. The [official event page](https://www.monad.xyz/developers/hackathons/metropolis) was not accessible to this research tool; no independent authentication of current bounty eligibility is claimed.
- This planning turn adds this root document only as its deliverable. Existing code, branches, manifests, `.env` files, contracts and deployments are unchanged; pre-existing untracked files are preserved. No new integration tests, broadcast or sponsor usage are claimed.
