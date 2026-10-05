# Oracle integration scenarios

The local coverage command executes existing real-contract regressions for E1–E9,
including fifteen separately deployed markets at one T and a 35-account settlement
crossing the 32-account page boundary. It runs pinned Forge under MonadTen, records
every result and source hashes, and fails on missing, duplicate or failed scenarios.
It imports no public stack credentials and sends no public transactions.

```powershell
$env:LOCAL_FORGE = (Resolve-Path ../tmp/foundry-v1.8.3/forge.exe).Path
bun e2e/src/local-coverage.ts ../tmp/local-oracle-e2e.json
bun run --cwd e2e test
bun run --cwd e2e typecheck
```

Run these from `oracle`. This report is local contract evidence; real HTTP source,
publisher, sampler, epoch worker and keeper receipts come from the separate local
stack runner. External report truth and assertion verdicts remain controlled here.
It does not complete public O42/OG3b or CRE deployment-dependent E10/E11.

The historical `scenario` command still targets the configured public testnet and
can send transactions. Its default engine kind remains `stub`. Do not run it for
local validation. A future authorized real-engine run must set `E2E_ENGINE_CONFIG`
to an explicit config and `E2E_OUTPUT_DIR` to a separate evidence directory:

```text
kind: "book-risk"
chainId: 10143
claimsTimeoutMs: positive integer, default 7200000 (at most 86400000)
markets: array of { tag, marketId, engine, codehash, listingHash, deployBlock }
```

Each tag names a scenario market (`e1`, `e8-00` through `e8-14`, etc.); hashes and
addresses are exact identities, `deployBlock` is a decimal string. These markets
must already be correctly listed and provisioned for the scenario. Real mode
never builds the old short-horizon stub packs. It checks chain/runtime/listing and
registry binding, calls `requestReduceOnly(reason)` for monitor incidents, and
waits for the enrolled keeper to finish actual bounded preparation before treating
claims as ready. Recovery fails the check; oracle Final alone is insufficient.
Risk calibration, book liquidity, participant funding and keeper gas enrollment
are prerequisites, not supplied by this harness. ABI export alone grants none.
