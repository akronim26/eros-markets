# Fresh Monad testnet deployment

## Scope — 2026-10-06

The user authorized a fresh deployment of the required contracts using the
private key in the root `.env`, followed by frontend integration and service
setup. Target: Monad testnet, chain 10143. No mainnet deployment or Git push.
Existing historical deployments and their evidence remain archived.

The authorized key derives address
`0xFf49aD13c59592cCCa53552FE09dAcA43cbcF190`. Initial read-only preflight:
26.671441567999748 MON, latest/pending nonce 23, block 68541253. The old
`TESTNET_DEPLOYER` environment entry does not match; derive identity from the key.
No private keys or credential-bearing RPC URLs belong in public manifests.

## Work sequence

| Stage | Status | Acceptance |
| --- | --- | --- |
| Deployment preparation | Complete | Pinned artifacts, explicit roles, journaled plans |
| Fresh local rehearsal | Deployment passed | Full sequence, bindings, receipt and gas checks |
| Public deployment | Complete | 39 finalized deployment/activation transactions, verified public manifest |
| Frontend wiring | Implemented; browser/build checks pass | SDK owner calls, dynamic caps, canonical receipts, deployment/history guards |
| Operator setup | Configured; hosting deferred | Public pins, encrypted publisher custody, funded roles, preserved journals |
| End-to-end trading demo | Not ready | Custody passed; continuous prices, real fills and live Privy signing still required |

## Inputs and boundaries

- User selected a real Polymarket event. Source qualification passed 120 observations
  over 120.87 seconds, 21 advancing timestamps, maximum advance gap 11.633 seconds.
  First event: "US announces end of Iranian blockade by October 31, 2026?"
- User has no running services and asked to set up hosting after the wiring.
- Test collateral and synthetic calibration must be labeled separately from any
  authentic external prices. Existing local fixture proof does not establish
  complete authentic-source leveraged operation.
- The oracle testnet sandbox and simulation delivery must retain explicit labels;
  no CRE network deployment or production UMA/DVM is implied.
- Deployment authorization supersedes the older local-only scope notes for this
  work. Existing immutable deployments will not be modified merely to reuse them.

## Completed base deployment

All 32 public transactions finalized and passed canonical receipt, runtime and
reciprocal binding checks at block 68544977. Receipt gas cost: 6.897323538 MON.
The five-minute timelock delay was preserved. The deployer owns proposer,
executor, canceller, lister and guardian roles; operator keys are separate and
stored only in the ignored owner-only run directory. These are testnet EOA roles,
not a claim of multisig governance. No stub factory or test MockUSDC was deployed.

| Contract | Address |
| --- | --- |
| MarketRegistry | `0x9bE1d595Ac9B6c1109a4dcaa056CE5eFDAF06F45` |
| ResolutionOracle | `0x2085DaD31c8Ee03025DD07a4EdC103401d493D87` |
| MarketFactory | `0xE348249c130ed49E33b024495477F81d40244F4D` |
| CollateralVault | `0xB544Cc0f81E587924f819258b3061a28F4954D4B` |
| TestUSDC | `0x0e0279B152845972479c66f933835c92582E1dC4` |

Evidence: `tmp/fresh-testnet-20261006/base-plan.json`,
`broadcast-journal.json`, `base-verification.json`, and the distinct local
`rehearsal-journal.json` / `rehearsal-verification.json` in the same directory.
Public sanitized artifacts are exported in `artifacts/deployments/monad-testnet-20261006/`.

Five deployment-runner regression tests and its focused TypeScript check pass.
All 109 FeedSpec tests pass after adding explicit array-index traversal through
JSON-encoded arrays, needed for Gamma's outcomePrices field. The selected feed
requires `umaResolutionStatus=resolved` and an integer payout; fractional payouts
fail evaluation instead of resolving NO. The resolution CRE workflow's 12 tests,
typecheck and WASM build pass. This is build/unit evidence, not a new CRE CLI run.

## Fresh market and frontend

- Engine: `0xcDf0EA81497895155E2911443f46157c00F965Db`.
- Market: `0xb75d77f847ad7eb057bc9249d711cdf235fabb941fe4586776f79653cc50cea4`.
- Public market listing block: 68546673. The full canonical listing hash is in the
  public manifest; the local rehearsal's listing hash differs and is not selected.
- The reserve holds 100,000 test tokens. Deployment ceiling is 5×; live directional
  caps initially read 1× because pricing is not ready. The exact synthetic profile
  is published with its verified hash; no empirical risk calibration is claimed.
- All 39 deployment/activation receipts cost 10.10233296 test MON in total.
  Separate native transfers funded publisher (1.5 MON), keeper (0.75 MON), and
  two independent maker wallets (0.35 MON each). Transfers to owned operator
  wallets are not counted as gas cost.
- Both owners completed faucet → approval → deposit → allocation on testnet,
  each allocating 2,000 test tokens. The same browser SDK builders are used by
  the UI. These key-controlled SDK checks do not certify interactive Privy signing.
- A first market-listing preflight exceeded the 30M gas ceiling after padding.
  It sent no public market transaction. Compacting duplicated description text
  made the second, independently rehearsed plan fit without weakening the margin.
  Original plans and journals remain in the ignored run directory.
- A bounded public epoch rollover finalized using one page, with a measured 421,732
  gas estimate and 516,079 gas limit. It preserved price-readiness restrictions.
- A local release rehearsal returned rejection code 11 (pricing unavailable); no
  public release/withdrawal was sent. The funding balances remain allocated.
- A local maker-order rehearsal correctly emitted `OrderRejected(11)` because
  pricing was unavailable. No public fill is claimed. A later local funding step
  encountered an epoch boundary, completed after a journaled local rollover, and
  both public owner custody sequences then passed.

Frontend changes select the verified factory deployment, refresh ABIs, use the
browser SDK for owner transactions, read actual `leverageCaps()`, offer integer
1–5× sizing, and require exact canonical finalized receipts before dependent
steps. Runtime hashes, chain, listing identities and contract bindings are checked.
A matching indexer binding is required before history is enabled. Test-token minting
is available with explicit wallet confirmation. Old manual-fixture/1× disclosures
were replaced with the actual external-source/synthetic-risk/testnet-oracle labels.

## External source and CRE evidence

The five-minute bounded public publisher run initially recorded 9/12 finalized
observations, then stopped at its configured time limit. Its last submitted
transaction was reconciled from the same journal on restart: 10 finalized total,
no unresolved signed transaction. Source and packet journal integrity checks pass.
`services/publication-check.json` preserves the original result;
`publication-reconciliation.json` records recovery without creating a replacement
transaction. Several observation gaps exceeded 30 seconds (maximum 51 seconds).
This does **not** satisfy the contiguous INDEX300 window or establish PERP60,
BASIS900, normal pricing, 5× admission or a leveraged fill. Hosting alone is not
proof: cadence and actual contract readiness must be measured after activation.

CRE CLI 1.36.0 successfully simulated the new Polymarket FeedSpec, performing the
external HTTP request and returning `NOT_READY/NOT_FINAL`, as expected for this
ongoing event. Evidence is in `services/cre-feed-simulation.*`. This run wrote
nothing on chain. The fresh resolution workflow target and listener configuration
are prepared; no live CRE DON workflow or finalized new-market resolution is claimed.
Earlier completed CRE/settlement evidence remains historical, with its original scope.

## Validation

- Pinned deployment-runner tests: 5 pass / 61 assertions; focused TypeScript passes.
- Affected oracle, SDK, FeedSpec, CRE and market-ops tests: 248 pass. The first run
  used the unpinned system Forge and crashed during ABI inspection; the rerun with
  Foundry 1.8.3 passes, including all source/snapshot ABI checks.
- Envio fresh configuration code generation and typecheck pass; all 38 indexer
  tests pass. No new hosted GraphQL endpoint has been provisioned.
- Frontend unit tests: 35 pass. Integration tests: 12 pass, including account
  switching, exact receipt finality, RPC identity, code/binding mismatches and reorgs.
- Production build and browser checks pass: main pages, all terminal tabs, light/
  dark layout at 320/768/1024/1440px; no overflow, browser runtime errors or failed
  resources in the recorded run. Axe found no A/AA/2.1AA violations in the loaded
  dark desktop terminal. The Privy login dialog opened with email/wallet options. Real authenticated Privy signing is still a manual demo gate.
- Clean Node 22 `npm ci` is checked locally with the repository's existing peer
  dependency setting retained. GitHub has not run these unpushed changes.

## Remaining work, in order

1. Choose and activate a persistent host, as requested after wiring. Transfer
   private operator custody and existing journals securely; never reinitialize
   the publisher with the same signer. See `FRESH_TESTNET_SERVICES.md`.
2. Improve and measure source-to-chain delivery so contiguous price windows become
   available. Run book sampling and epoch maintenance with funded maker liquidity;
   verify actual previews and caps before demonstrating 1–5× trading.
3. Finish future-state keeper/liquidation gas enrollment and supervise the separate
   keeper, CRE listener and optional panel/committee roles. The current event has
   not resolved, so its actual outcome and settlement cannot be demonstrated yet.
4. Host the matching Envio indexer; connect its read-only GraphQL endpoint using
   the frontend's chain/registry binding. Current state works directly from RPC.
5. Run real embedded and external wallet login/signing, an admitted order and fill,
   cancellation, release/withdrawal, then record the bounty demo. Optional delegated
   trading/protection also requires server-side Privy credentials and separate policies.

The root `.env` public address aliases were updated to the verified contracts; its
private key was preserved. A scan of changed files and 202 browser JS bundles
found none of the deployment/operator private keys.

Nothing has been committed or pushed. Hosting remains deferred by the user.
