# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js (App Router) + TypeScript strict, viem 2.57.2 + wagmi, Privy (embedded wallets, policy-restricted
delegated signing), Tailwind CSS. All frontend files live in `frontend/`. Confirmed by the user 2026-10-05;
matches `docs_frontend/frontend.md`.

## Users

Primary, served terminal-first: crypto derivatives traders used to perps and on-chain order books, who
read depth, leverage, margin and funding at a glance and trade repeatedly in a session. Secondary:
prediction-market users (Polymarket-style) who arrive with a question in mind and think in
probabilities; they need question-first discovery and a ticket that explains cost and payout plainly,
with pro depth one step away. Also: liquidity providers (reserve), keepers/operators, and dispute
participants on the resolution pages.

## Product Purpose

Eros Markets lists binary event perpetuals on Monad: each market is a YES/NO question resolving at a
scheduled time T. Traders buy and sell claims (1 claim pays 1 USDC on YES) on a fully on-chain limit
order book, fully backed or leveraged, with an isolated reserve covering leveraged deficits. Success:
a trader can fund, trade, manage risk and claim their payout with every number matching the contracts
at a named block.

## Positioning

Leveraged perpetual exposure to event outcomes, with exact on-chain risk: an isolated per-market
reserve covers losses beyond collateral in exchange for a jump premium, so no trader ever owes a debt,
and a three-layer oracle (CRE, model panel, human committee, UMA disputes) resolves the outcome.
Prices are probabilities on a 0.001 tick grid; the whole book, margin kernel and settlement are on chain.

## Operating Context

Trading sessions on desktop terminals (dense, multi-panel) and quick checks on mobile. Monad testnet
(chain 10143), test collateral, sub-second blocks, gas charged on the limit. Market lifecycle runs on
a clock: trading → final-day backing (T−12h30m, T−12h) → reduce-only (T−1h) → halt → oracle
resolution → settlement preparation → claims. Many values can be legitimately unavailable (no index,
mark warming up, sweep running) and must say so.

## Capabilities and Constraints

- Authoritative spec for every screen, number and flow: `docs_frontend/frontend.md`.
- Live chain reads from the start (user decision 2026-10-05). The deployed testnet market
  (`0x58c6…1b69`) is verified but not activated, has no price feed and is 1x; screens must render
  those states truthfully, not fake activity.
- Units are exact integers (atoms, Q, lots, ticks, WAD); no floating point for amounts.
- Leverage, funding, premium and liquidation exist in the engine but are enabled per market; the UI
  is capability-driven and hides them on 1x markets.
- Payouts are claimable only when the contract reports `claimsEnabled`; oracle Final is not "paid".
- Terminology: claim, lot (0.001 claim), tick, mark, index, reserve, deficit, premium, funding,
  grace, takeover, halt, claims ready.

## Brand Commitments

- Name: Eros Markets. Logo assets in `~/Downloads/Eros_Markets/` (svg, png, favicon). The mark is a
  stack of ivory bars (a depth ladder) with one Signal bar at centre: "the mark price".
- Colours (binding, from the brand README): Ink `#0A0A0B`, Ivory `#F2F1EC`, Signal `#FF5A36`.
- Wordmark: outlined Inter Tight Medium, −0.04em tracking.
- **No rounded corners anywhere: all borders and shapes are sharp** (user requirement 2026-10-05).
- **Theme pinned by the user (2026-10-05):** the v0 "Brutalist AI SaaS Landing Page" template
  (https://v0.app/templates/brutalist-ai-saas-landing-page-6QYngsI1qTp, demo
  https://v0-design-brutalist-ai-saa-s.vercel.app/) is the site's theme for every surface: light Ivory
  dot-grid ground, hard 1px Ink frames, pixel display type, mono uppercase labels, `// SECTION` rules,
  bento panels, black terminal panels, arrow-square buttons, scramble text, marquees. Its rounded pills
  are translated to sharp frames. Its invented demo metrics are not copied: Eros shows only live chain
  values or real protocol constants.

## Evidence on Hand

Deployed contract addresses and ABIs (`addresses.md`, `artifacts/risk/*.json`, `oracle/abi/`), the
oracle deployment manifest, the risk SDK decoders and fixtures (`packages/risk-sdk`,
`docs/app-state-fixtures.json`), and the spec's worked examples. No users, volumes, testimonials,
partners or audits exist: never fabricate them.

## Product Principles

1. The contract is the source of truth; the UI shows its numbers with their block, never its own.
2. Unknown is shown as unknown; risk is shown before it bites (grace, liquidation, final-day takeover).
3. Dense for traders, legible for newcomers: every number has a plain-language reading one step away.
4. Testnet stand-ins are disclosed, never dressed up as production.
