## Frontend

1. **Missing exit-value preview:** closing a position does not clearly show estimated realized P\&L and USDC available afterward, including applicable charges and fill assumptions. **Status: done.** Conditional exit cash, fee cap, included funding/premium, potential release and fill-derived price P&L are shown. On-chain position versions validate entry history across block refreshes; incomplete evidence remains explicitly unavailable. Focused math and browser P&L regressions passed.
2. **Incorrect short-position labeling:** short YES can display as a negative quantity labeled “NO,” suggesting the opposite exposure. **Status: done.** Positive claim quantities now carry explicit Long YES / Short YES labels; focused label tests passed.
3. **Misleading closing-order summaries:** reducing or closing positions still displays an opening trade’s gross payoff and full-backing amount. **Status: done.** Opening-only payoff/backing rows are replaced with close/reduction estimates; targeted browser scenarios passed.
4. **Incorrect “Max” behavior:** uses the accepted quantity of the current request instead of finding maximum available capacity. **Status: done.** Bounded block-pinned search probes structural capacity independently of the entered size, confirms candidates and identifies incomplete searches; capacity and stale-result regressions passed.
5. **Missing position-effect preview:** does not clearly show whether an order opens, increases, reduces, or closes exposure. **Status: done.** Before/after exposure and open/increase/reduce/close/reverse effects are shown conditionally on fills; math and browser checks passed.
6. **Ambiguous portfolio/history labels:** positions and fills lack clear exposure or buy/sell direction. **Status: done.** Portfolio, orders and history now identify exposure or Buy YES / Sell YES, using bounded maker-order lookups for fill direction; focused history tests passed.
7. **Missing four-choice trading interface:** Long YES, Short YES, Long NO, and Short NO are not explicitly selectable. **This is a feature gap**, rather than missing backend exposure directions. **Status: done.** All four choices map to the shared YES book with complementary NO prices and the correct leverage side; all four browser submit mappings passed.

## Backend

**No confirmed bug was found in the trading direction, net-position accounting, or closing execution discussed above.**

Separately, our earlier oracle/deployment review identified:

1. **Panel watcher can skip event blocks:** its cursor advances past unprocessed blocks after a partial batch. **Status: done.** Advances to the actual range end + 1 and replays failed polls; focused cursor regressions passed.
2. **Panel submission is treated as completion prematurely:** work can be marked done after obtaining a transaction hash without confirming successful execution. **Status: done.** Durable submission records, canonical finalized receipt checks and matching acceptance events now gate completion; receipt/restart/revert regressions passed.
3. **Watchdog timing conflicts with listing presets:** its required 600-second dispute margin exceeds the configured 120/120/300-second assertion windows, preventing automated disputes under those settings. **Status: done.** User-approved testnet-only 30-second override, chain guards, liveness validation and bounded model timeout; timing regressions passed. Set `WATCHDOG_TESTNET_DISPUTE_MARGIN_SECS=30` for the existing testnet markets; default remains 600 seconds.
4. **Stale deployment configurations:** some indexer and oracle service configurations still reference older contracts. **Status: done.** Current services/indexer/CRE use the frontend manifest, with drift checks and explicit historical overrides; config tests and affected service typechecks passed.

Backend runtime setup and recovery instructions: [oracle/services/README.md](oracle/services/README.md). No contracts were deployed or changed by these fixes.

Verification completed: 36 focused frontend unit/integration tests, 8 isolated browser scenarios, 61 focused backend Bun tests and 8 indexer configuration tests passed. Frontend and all six affected service/indexer typechecks passed. Browser wallet/RPC/history inputs were mocked; no live testnet trading or deployment was performed.
