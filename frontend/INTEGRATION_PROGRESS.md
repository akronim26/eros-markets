# Frontend integration progress

Started 2026-10-06. Scope: complete the gaps identified in the frontend audit, in sequence, preserving the compact terminal, larger text, themes and Privy wallet ownership.

## Work queue

| Step | Deliverable | Status | Verification |
|---|---|---|---|
| 1 | Real open orders, cancel, cancel all, accurate empty/error states | Implemented; locally verified | 5 order regressions; Chrome empty/account states |
| 2 | Release collateral, withdraw vault funds, claim settlements, reuse free vault balance | Implemented; local contract checks pass | 4 funds regressions + real local claims/payouts |
| 3 | Engine/vault history, fills, chart history and P&L | Implemented; local Envio connected | 38 indexer tests; live local GraphQL queries pass |
| 4 | Registry market discovery and correct per-market contracts | Implemented | Typecheck; actual registry records discovered |
| 5 | Oracle market linkage, resolution and dispute actions | Implemented; public browser reads pass | State/bond checks; bonded wallet transaction still needs live user |
| 6 | Capability-driven advanced trading, close/reduce, margin and risk tools | Implemented; local checks pass | 2 Solidity lens tests + deployless RPC call + intent/profile tests |
| 7 | Reserve liquidity and permissionless operations | Implemented; browser and contract checks pass | Activation/redemption guards; no public LP transaction |
| 8 | Privy wallet export, gas onboarding, delegated trading and protection automation | Implemented; server features await credentials/policy verification | 7 server/profile tests; no real delegated signature yet |
| 9 | Integrated local/browser verification and live-wallet demo | Local checks complete; live demo pending | Build, Chrome and Anvil pass; funded live demo needs operator/user |

## External dependencies

- The configured Monad fixture was inactive with no ready price and zero test-collateral supply at block 68,478,941. Live trading requires the authorized operator, test funds and authenticated INDEX observations.
- A real oracle-backed market requires governance/factory deployment by the existing operators. The current fixture's manual authority is immutable; changing frontend configuration cannot replace it.
- Live leveraged trading requires an approved deployed composition and calibrated profile. Local fixture validation does not enable testnet leverage.
- Delegated Privy signing requires server-only credentials and real policy/session setup. No secrets belong in the frontend or this report.
- Hosted history and automation need configured services. Local tests do not establish hosted uptime or real Privy signing.

## Evidence and reporting rules

Each step records implementation, commands/results, and remaining dependencies before advancing. A build or mocked test is not an end-to-end funded-wallet test. No public-chain writes, operator impersonation, deployment, commit or push are part of this implementation run.

## Baseline

- Working tree clean at start.
- Existing wallet safety suite: 12 passing tests from the audit.
- Existing frontend typecheck/build and desktop/mobile light/dark layout checks passed in the preceding UI work.
- Current source supports approve/deposit/allocate/place; order management and exits were absent.

## Steps 1–2 implementation

- Orders are discovered from confirmed receipts/recent events and revalidated against chain ownership, generation, epochs, expiry and position version. The UI states limited coverage explicitly until step 3. Cancel-all operates on the full contract account, independent of discovered IDs.
- Release is checked with `previewRelease`; withdrawals use only vault free balance. Claims require halted + claims enabled, a nonzero amount, no recovery and no prior claim.
- Funding uses free vault funds before depositing; retry after a completed deposit does not deposit the same amount again.
- `npm run typecheck`: exit 0. `npm test`: exit 0, 21/21 (12 wallet + 5 orders + 4 funds). Public-chain transactions have not been sent. Browser/local-chain integration verification remains step 9.

## Steps 3–5 implementation

- Envio now indexes order lifecycle, fills, accounting events, vault events and collateral transfers. Factory changes register new engines/vaults/tokens. Market discovery verifies the registry/engine/authority/collateral relationship before opening a terminal.
- Started a separate local `eros-trading` database and Hasura at `http://localhost:8081/v1/graphql`. The existing oracle database and service on port 8080 were preserved. The provided Envio token was used without exposing it. Frontend `.env.local` points to the public read endpoint.
- Real GraphQL account/history queries passed at block 68,482,713 with `isReady=true`. The configured inactive fixture has no trading events; no sample trades are presented as real history.
- Historical charts merge with live observations. P&L uses an account read pinned to the indexed block and is withheld when coverage is incomplete or settlement has already been claimed. Vault token transfers are labelled transfers, because the vault has no withdrawal event.
- Oracle details read at one block. Proposal/dispute bonds come from the pinned venue and OOv3 assertion; disputes approve OOv3, proposals approve the venue. Permissionless progression uses simulation to identify executable actions.
- `npm run typecheck` and all 22 frontend tests pass. `pnpm typecheck` and all 37 indexer tests pass. No wallet bond or public-chain transaction has been submitted.

## Steps 6–8 implementation

- Close / 50% reduce prefill an opposite-side, reduce-only IOC; the trader reviews the worst price. Expiry uses exact uint32 block bounds. Ticket submission waits for a current preview.
- Added a stateless Solidity MarginLens using MarginMath directly, with the same calibration-expiry rule as the engine. Hash-verified profile loading, what-if health and nearest price-boundary scans are wired. No released leveraged profile has been supplied for this deployment, so live leveraged controls remain gated.
- Reserve actions: seed shares before activation, seven-day notice, prepare redemption and claim payout. A repeated claim attempt does not repeat redemption. Activation is rechecked before allocation; the unavoidable activation-before-inclusion donation risk is shown before consent.
- Operations simulate due rollover, floor, sampling, halt and settlement pages. Leveraged markets can scan eligible accounts and process bounded liquidations. User wallets pay gas.
- Privy tools: explicit selected-wallet export, MON balance/faucet guidance, server-verified signer permissions, explicit grant consent and revoke-all. Every normal transaction estimates gas and checks MON balance.
- Optional one-click route authenticates Privy access tokens, verifies wallet ownership and exact allowlisted policies, checks current permission again before signing, re-previews and simulates the exact intent, supplies gas, and persists request IDs in SQLite. Unknown signing responses are held for reconciliation rather than blindly retried.
- Persistent protection worker and UI support stop loss, take profit, auto-cancel, margin guard, backing-floor reduction and optional permissionless claim delivery. Orders are capped by current position and the user's size, reduce-only IOC, mark-triggered and submitted at most once per rule. A SQLite journal reports results. Background signing requires a distinct protection key.
- The supplied App ID enables client login/wallet signing. `PRIVY_APP_SECRET`, authorization keys, quorum/policy IDs and optional claim-delivery payer are not configured. These optional paths therefore fail closed; this is not a completed live Privy delegation demo.


## Step 9 verification and fixes

- Frontend typecheck and production build pass. Build tracing warning fixed. Stop/build/start was used to avoid stale Next.js chunk references.
- Frontend unit tests: **28/28**. Server/profile integration tests: **7/7**, including owner isolation, revocation, exact policy restrictions, stale previews, duplicate requests, one-time IOC execution and recovery using an exact Privy reference plus a chain receipt. SDK/RPC doubles are labelled in the tests.
- Envio tests: **38/38 passing**, with typecheck passing. Paired liquidation events now retain both account identities and separate fee totals. Mainnet/testnet event definitions match. Local public GraphQL reads at block **68,488,475** returned `isReady=true`; actual oracle records are discoverable. No fixture trades exist in that dataset.
- Solidity: **2/2 MarginLens tests** and **23/23 RealBookIntegration tests** pass. Frontend creation bytecode successfully performs deployless `health` and `healthRange` calls on Anvil.
- The first broadcast smoke run revealed a stale index window at inclusion despite successful transaction receipts; orders were rejected. The rerun fixed Anvil's timestamp interval and sent transactions sequentially. The final independent frontend-ABI check verifies a **100-claim Fill**, enabled/completed settlement, buyer balance **150 test collateral**, no remaining buyer claim, and a recorded trader claim. The script also asserts the seller's **50** payout and zero remaining vault custody. This is local mock collateral on chain 31337, not a public demo.
- Chrome: landing, Markets, Portfolio, Resolution and all nine terminal tabs load without runtime errors. After batching contract calls and polling head every four seconds, the repeat check had **zero failed network responses** (the initial run exposed public-RPC 429s).
- Chrome layout: light and dark at **320, 390, 768, 1024 and 1440 px**, plus a tall desktop viewport. No horizontal overflow; 16px ticket inputs; chart remains **280/300px**; desktop ticket remains **300px**; no terminal Markets sidebar; All markets returns to the list.
- Privy login dialogs match light/dark themes; System follows OS preference changes. An expanded oracle record loads its question, state and action checks without errors. These checks did not authenticate a user or sign a transaction.
- Optional server routes were checked: permissions/protection report unconfigured; trade returns 503. No action is presented as enabled based only on the public App ID.
- `git diff --check` passes. No public-chain writes, deployments, live policy changes, authenticated wallet approvals, commits or pushes occurred.

## Handoff

- Frontend preview: `http://localhost:3100`.
- Trading history: `http://localhost:8081/v1/graphql`; original oracle service/database preserved.
- Restart and local-chain instructions: [INTEGRATION_SETUP.md](INTEGRATION_SETUP.md).
- Optional server signing, worker and recovery instructions: [automation README](../services/automation/README.md).

**Implementation and local verification are complete. The project is not yet a fully live trading demo.** Remaining external work is operator activation/funding/INDEX publication, an actual oracle-backed market deployment, approved leverage calibration, and user-involved Privy wallet/signing checks. Optional delegation additionally requires server credentials, separate real policies/signers and a supervised worker. The provided App ID and Envio token are already in use and do not need to be supplied again.
