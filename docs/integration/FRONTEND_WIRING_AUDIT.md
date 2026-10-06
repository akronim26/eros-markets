# Frontend wiring audit — 2026-10-06

Scope: the frontend at `984cc8e` and the working-tree fixes described below,
using the verified 2026-10-06 Monad testnet manifest. This audit preceded the
requested live E2E workflow. No public transactions were sent during the audit.

## Findings fixed

| Area | Finding and correction |
| --- | --- |
| Browser startup | Blocking browser storage could throw during the wallet SDK's module initialization and prevent the entire page from loading. Load the SDK after a storage check; keep public pages, themes and cookie controls available and explain why login is disabled. The public wagmi provider uses inert storage that supports hydration. |
| Wallet transaction sequences | Watch wallet/network changes before the first asynchronous deployment check. A switch away and back invalidates the sequence. One shared lock now prevents separate panels from starting concurrent owner sequences in the same tab. |
| Simulation and confirmation | Bind validation, simulation and gas estimation to the same canonical block, reject stale RPC heads, round the gas margin upward and enforce the transaction gas ceiling. Re-read the exact receipt after finality and verify transaction identity before advancing dependent steps. Preserve explorer links on failures. |
| Trading ticket | Scope previews to the owner, require matching account/market blocks, reject unknown preview codes and oversized orders, and recheck exact admission/expiry before signing. Flat accounts can size from cash before a mark exists. Closing an existing position clears stale expiry/leverage choices. Failed network switches show an error. |
| Funding and claims | Disable funding/claims when live reads fail or snapshots disagree. Reset funding inputs when the owner changes. Positive later reserve credits remain claimable after an earlier trader claim. Reserve claim actions require claims to be enabled and recovery to be complete. |
| Canonical reads | Check block identity around book, order, reserve, oracle, upkeep and margin-lens reads. Verify the engine's shared vault binding. Optional server trading/protection also verify deployment identity before signing. |
| Price history | Reject invalid-depth INDEX observations, clear recovered read errors, reset on reorgs and prevent late responses from a previous engine from entering the current chart. Missing prices stay unavailable; they do not imply a zero price or healthy position. |
| Market discovery | Expose terminals only for engines in the verified manifest, matching the SDK owner builders. Newly discovered listings need verified manifest updates before trading can be enabled. |
| Indexed activity | Paginate vault activity and collateral transfers, deduplicate events, reject malformed/conflicting payloads, and mark bounded results incomplete. Do not read an account before its engine's deployment block while an indexer catches up. |
| Privy services | Accept both supported embedded-wallet identifiers; scope permissions/protection caches to the login session. Bound HTTP waits and explain uncertain mutation results. Protection changes watch wallet switches and refresh status even after ambiguous responses. |
| Risk and maintenance | Preserve an explicitly requested margin-boundary estimate across new blocks, labeled with its original block. Keep the initial book-sampling action available when its successful return value is `false`, because that call can record a pending sample. |
| Transaction summary | The thank-you page, service reconciliation and protection receipts wait for canonical finality. A successful transaction remains distinct from an actual order fill. |

## Verification

Validation results and browser evidence are recorded in
`artifacts/integration/frontend-audit-20261006/report.json`.

- 39 frontend unit tests and 18 integration tests pass.
- TypeScript and the production webpack build pass with Node 22.23.3.
- Browser matrix: landing page, markets, portfolio, resolution and the current
  terminal, in light/dark themes at 320, 390, 768, 1024 and 1440 pixels.
- All 50 layout combinations pass without horizontal overflow. Ten desktop
  accessibility scans report zero WCAG A/AA/2.1AA violations. Final browser runs
  report no runtime exceptions or unexpected HTTP failures.
- All nine terminal tabs, keyboard navigation, return-to-markets, system theme,
  reduced motion and the Privy login/wallet-selection dialogs were exercised.
- RPC interruption preserves the last snapshot with an error/retry state;
  restoring RPC access recovers the terminal.
- Unknown routes/engines, privacy, terms, cookie dismissal/reopening, invalid
  transaction references and an existing finalized transaction were checked.
- A separate browser regression blocks storage, checks usable public content,
  notice dismissal and theme selection, then verifies login recovery after reload.

The automated chain and Privy integration tests use doubles. Browser current-state
reads and the existing receipt check use the public Monad testnet RPC. Neither is
proof of new authenticated wallet transactions.

## Remaining E2E gates

1. Real Privy email/Google and external-wallet login, account selection, session
   restoration, rejected signatures and signing with funded wallets.
2. Approval → deposit → allocation → admitted order → fill/cancel → release →
   withdrawal, with actual finalized owner receipts and observed balances.
3. Continuous publisher, book sampling and epoch maintenance; readiness and
   directional leverage admission must be measured while those services run.
4. A matching Envio endpoint, with actual hosted history and indexer lag recovery.
5. Live delegated trading/protection after separate credentials, policies and a
   supervised worker are configured; future settlement after a valid outcome.

The build still reports optional dependency warnings for Farcaster Solana,
Base Account, Coinbase, MetaMask and Tempo connector modules, an upstream dynamic
import warning in Tempo, and Node's experimental SQLite notice.
They do not fail the build or the exercised browser flows. Actual external-wallet
connections remain part of the wallet E2E gate. No CI gates were removed or added.

This is a bounded audit, not a guarantee that every possible frontend state is
bug-free. No identified reproducible failure should be marked resolved without its
corresponding verification. The working tree is left uncommitted and unpushed.
