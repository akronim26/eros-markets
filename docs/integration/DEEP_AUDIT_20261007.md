# Whole-application audit — 7 October 2026

## Current status

Repairs, independent cross-reviews, the fresh complete browser lifecycle and the
separate backend settlement proof passed. The final result is
`local-passed-public-pending`. This is a new audit after the earlier services shutdown. Public
publishers, keepers and transaction workers remain stopped. Tests use disposable
local chains and wallets; they do not spend test MON or use the deployment key.

## Work streams

| Area | Scope | Status |
| --- | --- | --- |
| Frontend | Current and historical prices, leverage, account reads, wallet guards, forms and routes | Repairs, tests and independent cross-review passed |
| Services | Price publication, sampling, oracle workflows, SDK, history and automation | Repairs, tests and independent cross-review passed |
| Contracts | Trading, risk, collateral, reserve coverage, settlement and oracle invariants | Independent Astra review and regressions passed |
| Integration | Test isolation, CI coverage, browser behavior and complete local lifecycle | All six fresh browser scenarios and the separate backend settlement proof passed |

## Confirmed repairs

| ID | Defect and repair | Verification |
| --- | --- | --- |
| DA-01 | Separate market/owner polling could keep their blocks different indefinitely and disable funding/trading. The terminal now reads both at one canonical block in one bounded query. Owner read failure clears owner data and disables writes. | Slow-read, overlapping-request, owner-failure and owner-switch integration tests |
| DA-02 | Source observations were presented as the execution index. Header and chart now distinguish the Polymarket source, 300-second execution TWAP and MARK, including delayed data, warmup and epoch restrictions. | Price-readiness regressions and fresh browser validation passed |
| DA-03 | Changing the open-orders query key each block could abandon slow requests. Stable scoped polling retains work and refreshes every four seconds. | Frontend tests and fresh browser lifecycle passed |
| DA-04 | Concurrent protection requests could bypass the 20-rule limit. Counting and insertion now share a SQLite write transaction, including unresolved submissions. | Store regressions; independent Astra cross-review |
| DA-05 | Authenticated API uploads could hold a reader forever. The body reader now enforces a five-second deadline and 12 KB bound, retaining origin validation. | Stalled-stream cancellation and size tests |
| DA-06 | Future-dated RPC heads passed delegated trading/protection freshness checks. Both directions are bounded; protection verifies its evaluation block before claiming a rule for submission. | Future-head regression and independent review |
| DA-07 | Cadence skips acknowledged unexecuted sampler requests. Requests now remain outstanding until successful finality, and early cadence checks avoid unnecessary RPC work. | Actual Operations/request restart and finality tests |
| DA-08 | Reverted samples advanced the cadence checkpoint and delayed a valid retry. Only successful samples update the last-sample block. | Market-ops regression |
| DA-09 | The local read API rejected the frontend's default port 3100. Its default allowed origins now include the localhost and loopback frontend. | Read-model checks and local API probe |
| DA-10 | Read API history exceeded the RPC's 100-block log limit. Requests now use inclusive 100-block chunks while retaining bounded API pagination. | Event-range regression |
| DA-11 | Repeated or unbounded indexer pages could stall keepers/watchdogs. Bounded scans fail over without reporting a partial list or advancing the cursor. | SDK, keeper and watchdog regressions |
| DA-12 | Indexer errors could log credential-bearing endpoint URLs and provider messages. Failures now contain controlled diagnostic text. | Credential redaction regressions |
| DA-13 | Expired EARLY oracle panels could restart review or route into early review after scheduled resolution. The panel path now enforces both deadlines, matching the reviewed-proposal path. | Two original failures reproduced, three deadline regressions and full oracle suite |
| DA-14 | Browser evidence did not fingerprint runtime JavaScript, shared SDKs or public assets. The runner now binds these inputs and rejects changed-source evidence. | Two harness regressions |
| DA-15 | API handlers treated every plain Error message as public-safe, allowing SDK failures to disclose private URLs. Only explicitly branded application errors now cross the API boundary. | Reproduced through the permissions route; delegated rejected/pending recovery and redaction regressions |
| DA-16 | Oracle CI's clean build omitted the Timelock artifact required by deployment-planner tests. The workflow now explicitly builds it with the pinned integration compiler. | Original clean-artifact failure reproduced; patched complete packages job passed |
| DA-17 | Contract CI size checks inherited the one-million-byte test-harness allowance. The build step now enforces the 131,072-byte production limit independently. | Passing 121,581-byte engine build; 120,000-byte negative control fails |
| DA-18 | The landing-page practice calculator still said testnet trading was limited to 1×. Its copy now describes live, dynamic limits up to 5× and keeps invented example prices clearly labelled. | Production build and public browser inspection |
| DA-19 | Per-block cache keys could continually abandon slow order, collateral, reserve and operator previews. Stable scoped polling now retains canonical block/timestamp provenance, bounds freshness and preserves fresh validation before signing. | Twelve slow-read, identity, freshness, reorg and component regressions; independent cross-review |
| DA-20 | After a successful cancel-all transaction, Open orders retained invalidated book nodes as stale rows. It now lists only effectively live orders; contract epoch invalidation remains authoritative. | Canonical local receipt/account epochs reproduced the defect; cancellation, expiry and ownership regressions |

Leverage controls also explain missing collateral, open orders, reduce-only mode
and missing entry prices. Collateral release explicitly explains its fresh-INDEX
requirement, including flat accounts; withdrawing free vault funds remains separate.

The E2E runner now uses a leveraged browser fixture by default, with real owner
transactions and fill/account assertions. Playwright project dependencies enforce
application checks → leveraged trading → settlement, avoiding order-dependent
accidental execution after the shared market has already settled.

## Completed automated checks

- Frontend: 69 unit tests, 44 integration tests and typecheck.
- Fresh browser suite: six scenarios passed, zero failures/skips/retries, in 5.6
  minutes. Includes a complete target-5× fill (90.909 claims; actual leverage
  4.9999945×), complete close, owner isolation, custody, cancellation, settlement
  and exact wallet payout. The run sent 33 browser wallet transactions and 11
  controlled local oracle/preparation transactions. Source fingerprints remained
  unchanged through the browser run.
- Separate backend lifecycle: leveraged NO settlement, reserve loss absorption,
  full owner claims and direct-owner payouts passed. Funded reserves contributed
  40.000007 test tokens. Receipt checks verified 113 script, five keeper, nine
  upkeep, eleven SDK and five leveraged-keeper receipts, plus three rollover
  batches. Source integrity and cleanup passed; no public transactions were sent.
- Oracle contracts: 345 tests passed under both default and exact CI profiles;
  the exact MonadTen integration gate passed 82 tests. CI build/size checks passed.
  Risk contracts: 849 tests under the risk profile; that local run is not the
  higher-count CI profile.
- Risk SDK: typecheck, accounting assertions and six read-model tests.
- The exact clean Oracle CI packages job: 740 workspace tests, nine keeper/sampler
  policy tests, 15 CRE resolution tests and 10 CRE dry-run tests passed (774 total).
  The 740 includes the 701 tests across eleven SDK/service workspaces and
  39 deployment-planner/E2E tests. Twelve indexer-query checks passed separately.
- Pricefeed: 474 tests on pinned Node 24.21.0/Linux, with network disabled and
  repository mounted read-only. The macOS attempts are retained as failures;
  the production supervisor intentionally requires Linux.
- CRE: 15 resolution and 10 dry-run tests; both typechecks and WASM builds passed.
- Integration harness: 93 Python tests, including five platform-specific skips;
  two browser-evidence regressions passed separately.
- GitHub workflow syntax and diff whitespace checks passed.
- Production frontend build passed. Anonymous public-config browser checks opened
  Privy's real login dialog in light and dark themes, then the public terminal,
  with no page errors or horizontal overflow. This did not authenticate a wallet
  or send transactions.

The first expanded browser run passed responsive layouts, theme switching, all
terminal tabs, RPC failure/recovery and restricted-storage checks. Its invalid-
transaction assertion also matched Next.js's hidden route announcer. The selector
was scoped to the confirmation panel, and the run was restarted from a fresh
fixture; the failed evidence remains in `tmp/e2e-20261007-073817/`.
The next attempt passed all four application checks, then exposed an E2E actor
collision: actor 18 already belonged to the SDK smoke test and had a token balance,
so its empty-wallet faucet button was correctly absent. That browser attempt was
interrupted without sending a transaction. Its evidence remains in
`tmp/e2e-20261007-080447/`. Leveraged browser trading now uses unused actors 20/21
and asserts empty starting balances; lifecycle actors remain 16/17. That unchanged
contract fixture was reused for the next attempt because the interrupted browser
had never funded, traded or settled it. The fixture has since been stopped.

The following run (`tmp/e2e-20261007-083657/`) passed all four application checks
and the full browser 5× entry/close test. Its lifecycle scenario then reproduced
DA-20 after successful on-chain cancel-all. That failed run is retained. A diagnostic
continuation after the fix passed wrong-network guards, owner-to-owner trading,
closing, release/withdrawal, oracle finality and exact owner claim payout in 144.8
seconds (11 browser transactions and 11 controlled fixture transactions). Its
evidence is in `tmp/browser-lifecycle-continuation-20261007/`; it does not replace
the fresh complete run. The fresh complete run subsequently passed all six browser
scenarios and the separate backend settlement proof in
`tmp/e2e-20261007-084601/`, finishing at 09:37:45 UTC. Its cleanup passed, and
all eight audited local test ports were independently confirmed closed.

The inspected remote contracts run passed 849 tests. Its test step took 34 minutes,
primarily the 10,000-case preview-parity fuzz test. The audit preserves that coverage;
it does not mark the long-running step as a failure or remove it to hide the cost.

At the inspected base commit, GitHub's
[oracle run failed](https://github.com/akronim26/eros-markets/actions/runs/37585740534),
while [frontend](https://github.com/akronim26/eros-markets/actions/runs/37585740563),
[pricefeed](https://github.com/akronim26/eros-markets/actions/runs/37585740606), and
[contracts](https://github.com/akronim26/eros-markets/actions/runs/37585740671) passed.
The repaired workflows have been validated locally; they have not been pushed or
run on GitHub in this audit.

Totals describe separate suites and are not a statement of exhaustive coverage.

## Deployment and dependency follow-up

DA-13 changes `ResolutionOracle` runtime code. Its ABI is unchanged. Existing public
contracts do not receive this repair automatically: applying it on chain requires
redeployment and updated verified deployment configuration. No public deployment
or address-register change was performed by this audit.

The frontend production dependency scan reports zero high/critical and 23 moderate
entries, rooted in transitive `uuid` and `decode-uri-component` versions used by
the wallet stack. An automatic fix proposes a Privy downgrade; the decoder's patched
release changes its module format. Those replacements have not been represented as
compatible or applied blindly. See the
[UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq) and
[decoder advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).

## Validation boundary

Passing local tests cannot restore expired public price windows while publishers
and samplers are stopped. Live INDEX/MARK, currently executable public leverage,
hosted service uptime and real Privy delegation require their own live evidence.
The oracle repair requiring redeployment is identified above. Real Privy signing,
hosted delegation, matching public history and authentic event settlement remain
outside this local proof.

Reviewable evidence summaries and source hashes are saved in
[`artifacts/integration/deep-audit-20261007`](../../artifacts/integration/deep-audit-20261007/),
including the [complete E2E result](../../artifacts/integration/deep-audit-20261007/e2e.json).
Failed attempts remain available alongside the successful evidence. Changes are
uncommitted; no push is included in this audit request.
