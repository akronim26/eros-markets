# Real-market operations helpers

Operations tooling for a real, registry-listed `BookRiskEngine`. The independent INDEX publisher lives in `packages/pricefeed`; this package handles sampling, observation relay, liquidation, epoch rollover and authenticated early-check requests. The local fixture orchestration is documented in [LEVERAGE_INTEGRATION.md](../../../docs/integration/LEVERAGE_INTEGRATION.md). Public operation still requires a real deployment, source owner and rules, funded accounts and measured gas limits.

The CLI defaults to simulation. `--broadcast` explicitly enables signing transactions with `MARKET_OPS_PRIVATE_KEY`; its address must equal the manifest sender. Sampler/relay senders are permissionless. Early-check requests require the actual `listing.monitor` key. A relay sender does not need the INDEX source signing key. No keys belong in manifest, incident, envelope or journal files.

## Setup and commands

Install the existing oracle workspace dependencies, then run from `oracle/services/market-ops`. Set `RPC_URL` for the manifest chain. No environment files are opened by the package itself. Supply a JSON manifest with these fields:

```text
chainId: numeric chain ID
engine: real registry-listed engine address
engineCodeHash: keccak256 of its deployed runtime
listingHash: engine.listingHash()
marketId: immutable market ID
oracle: listing.resolutionAuthority
oracleCodeHash: keccak256 of its deployed runtime
sender: dedicated transaction account address
sampleEveryBlocks: positive decimal string (default "1")
gas: object containing only measured integer limits, as needed:
  samplePerp, requestReduceOnly, requestEarlyCheck, submitObservation, liquidate,
  beginRollover, rollPage, finishRollover
rolloverHelper: optional object for bounded batching:
  address: reviewed RolloverBatcher deployment
  codeHash: keccak256 of its deployed runtime
  maxPages: integer 1..32 (default 32)
  gasCeiling: integer gas ceiling no higher than 30,000,000 (default 30,000,000)
```

Missing gas limits refuse execution, including simulation, except helper rollover which measures its own current batch. Read-only startup checks chain ID, runtime hashes, immutable listing identity, registry engine/monitor and pinned INDEX signer/rules at one block. The ABI is loaded from the repository's existing `artifacts/risk/book-risk-engine-abi.json` using a file URL, which works on Windows and Unix.

```sh
bun src/main.ts sample manifest.json journal.json
bun src/main.ts sample manifest.json journal.json --broadcast --watch
bun src/main.ts liquidate manifest.json journal.json --broadcast --watch
bun src/main.ts rollover manifest.json journal.json --broadcast --watch
bun src/main.ts early-check manifest.json journal.json incident.json --broadcast --watch
bun src/main.ts relay manifest.json journal.json envelope.json --broadcast --watch
```

Without `--watch`, each command performs one tick. With `--watch`, the default poll interval is five seconds (`POLL_MS`, minimum 1000); a monitor incident ends when completed, a relay ends once finalized/obsolete, and sampling ends at halt. Choose cadence with RPC capacity, measured transaction cost and feed inclusion slack in mind. `samplePerp()` returning `false` is deliberately not suppressed: its first call captures pending book state. Publication requires a later block and a strictly newer INDEX observation, while retaining the contract's mutation, age, eligibility and depth guards. INDEX must arrive comfortably faster than the 30-second staleness limit for sustained normal pricing; this tool cannot make unavailable prices fresh.

An incident file is `{ "incident": "operator-assigned-unique-incident", "reason": "0x...32-byte-reason..." }`. Submitting it with `--broadcast` is the explicit operator instruction. The command reads current state, calls `requestReduceOnly(reason)` if needed, waits for finality, then requests the oracle early check. It refuses the wrong monitor, a halted/expired market or a non-None oracle state. The same completed incident is not resubmitted. It never calls `clearReduceOnly` or `raiseHazards`: clearing also resets the engine's movement restriction and needs a separate policy decision. A rejected/expired oracle early check does not automatically clear engine restrictions.

An envelope file contains `chainId`, `engine`, `signature` and an `observation` with `marketId`, `sourceId`, `sequence`, `observedAt`, `publishedAt`, `priceWad`, `impactBidWad`, `impactAskWad`, `bidDepthLots`, `askDepthLots`, `sourceRulesHash`. All observation integers are decimal strings; times are Unix seconds, prices WAD, depths lots. The relay verifies source/rules, ordered sequence/time, chain/engine/market domain, the onchain digest and the signature from the immutable source signer. The digest is raw `keccak256(abi.encode(TYPEHASH, fields..., chainId, engine))`, not `personal_sign` or EIP-712. Contract simulation additionally checks depth/impact-mid rules. Delayed observations remain historical; the relay never substitutes current timestamps or a fabricated price.

## Restart and account ownership

Liquidation checks at most 32 participants per tick with a persistent circular
cursor. The actual contract simulation includes accrued premium, eligibility, book
liquidity, reserve cover and pacing. Only productive reductions or authorized
takeovers are sent. Missing price, healthy accounts and positive equity without
liquidity produce no work. There is no automatic pair-partner selection. Supply measured `gas.liquidate`
and a dedicated sender; no public gas calibration is inferred from local fixtures.

Without `rolloverHelper`, `rollover` starts an ended epoch, advances at most 32 accounts per transaction,
then finishes only when the sweep cursor reaches its frozen count. It re-reads
identity, epoch and cursor after simulation; another worker's advancement causes
a fresh plan on the next tick. Inactive markets, other sweeps and halted/expired
markets send nothing. Each action requires its own measured gas field. It uses
the same journal and finalized-receipt handling as other commands. The local
fixture shares this planner but keeps owner-authorized re-quoting separate;
public rollover never cancels or places a trader's orders.

With the optional helper, the same planner composes begin, bounded 32-account
pages and eligible finish inside one atomic transaction. It pins expected epoch,
work and cursor in calldata and verifies the helper runtime at the snapshot block.
At most six current-state gas estimates select the largest fitting batch up to
`maxPages`; the signed limit is the measured estimate plus 20% rounded up and
10,000 gas, within `gasCeiling`. Recognized gas-cap failures narrow the search.
An exact nested RPC code3/data0x revert after a smaller measured fit ends the
search and retains only that fit. Its larger unestimated page count and opaque
reason are recorded in `searchStop`; it is not classified as out-of-gas or a
proved upper gas bound. Without a prior fitting estimate, or for nonempty custom
reverts and transport failures, the plan stops. The retained fit must still pass
exact simulation. A fresh snapshot
after simulation discards a raced plan before signing. Pending/finalized results
retain selected pages, raw estimate, gas limit, estimate block and estimation
elapsed milliseconds. A helper batch has no custody or privileged caller and
changes no engine pricing or accounting checks.

The helper address and runtime hash extend journal identity; manifests without it
retain their original binding and legacy behavior. Switching a live journal to a
different helper requires explicit reconciliation. A passing gas estimate does
not guarantee warm pricing at completion: source capture, finality, estimation
and all batch receipts must still fit the contract's actual freshness bounds.
The four-owner warm opening and 1,024-owner accounting lifecycle are separate
proof scopes; neither implies the other or production gas calibration.

Use one durable journal and one dedicated sender across all commands for a market. Only one transaction may be outstanding. Signed transaction bytes and their hash are fsynced to the journal before broadcast. Restart or RPC failure rebroadcasts the same signed bytes; it never prepares a replacement transaction for an unresolved journal entry. Canonical receipts must reach `finalized` before the next action. A reverted transaction stops the tick. A sender with unknown pending transactions is refused.

The journal is bound to chain, market, runtime hashes, listing and sender. Do not delete it, change sender, or run another process using that account while transactions are unresolved. A `.lock` file excludes concurrent processes sharing the journal. After an unclean shutdown, verify the old process has stopped before removing only the stale `.lock`; preserve the journal. Use a local durable filesystem. An unavailable finalized tag, ambiguous nonce, corrupted journal or failed RPC requires reconciliation; there is no timed replacement or automatic journal reset. Do not commit operational journals: they contain signed, broadcastable transactions and incident history.

These helpers are not a continuously deployed service. Integration still needs a real manifest, measured network gas, operational custody, a running price source and an explicit monitor operator. Tests use fake transports and public test keys, never live RPCs or accounts.

```sh
bun test
bun run typecheck
```
