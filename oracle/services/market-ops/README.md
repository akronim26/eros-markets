# Real-market operations helpers

Local integration tooling for a real, registry-listed `BookRiskEngine`. This package does not deploy contracts, fetch prices, sign INDEX observations, detect early outcomes, or host services. The independent pricefeed implementation is not present in this checkout or its locally available remote branch trees. Live operation remains pending the real deployment, source owner, source rules, externally signed observations, funded accounts and measured gas limits.

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
  samplePerp, requestReduceOnly, requestEarlyCheck, submitObservation
```

Missing gas limits refuse execution, including simulation. Read-only startup checks chain ID, runtime hashes, immutable listing identity, registry engine/monitor and pinned INDEX signer/rules at one block. The ABI is loaded from the repository's existing `artifacts/risk/book-risk-engine-abi.json` using a file URL, which works on Windows and Unix.

```sh
bun src/main.ts sample manifest.json journal.json
bun src/main.ts sample manifest.json journal.json --broadcast --watch
bun src/main.ts early-check manifest.json journal.json incident.json --broadcast --watch
bun src/main.ts relay manifest.json journal.json envelope.json --broadcast --watch
```

Without `--watch`, each command performs one tick. With `--watch`, the default poll interval is five seconds (`POLL_MS`, minimum 1000); a monitor incident ends when completed, a relay ends once finalized/obsolete, and sampling ends at halt. Choose cadence with RPC capacity, measured transaction cost and feed inclusion slack in mind. `samplePerp()` returning `false` is deliberately not suppressed: its first call captures pending book state. Publication requires a later block and a strictly newer INDEX observation, while retaining the contract's mutation, age, eligibility and depth guards. INDEX must arrive comfortably faster than the 30-second staleness limit for sustained normal pricing; this tool cannot make unavailable prices fresh.

An incident file is `{ "incident": "operator-assigned-unique-incident", "reason": "0x...32-byte-reason..." }`. Submitting it with `--broadcast` is the explicit operator instruction. The command reads current state, calls `requestReduceOnly(reason)` if needed, waits for finality, then requests the oracle early check. It refuses the wrong monitor, a halted/expired market or a non-None oracle state. The same completed incident is not resubmitted. It never calls `clearReduceOnly` or `raiseHazards`: clearing also resets the engine's movement restriction and needs a separate policy decision. A rejected/expired oracle early check does not automatically clear engine restrictions.

An envelope file contains `chainId`, `engine`, `signature` and an `observation` with `marketId`, `sourceId`, `sequence`, `observedAt`, `publishedAt`, `priceWad`, `impactBidWad`, `impactAskWad`, `bidDepthLots`, `askDepthLots`, `sourceRulesHash`. All observation integers are decimal strings; times are Unix seconds, prices WAD, depths lots. The relay verifies source/rules, ordered sequence/time, chain/engine/market domain, the onchain digest and the signature from the immutable source signer. The digest is raw `keccak256(abi.encode(TYPEHASH, fields..., chainId, engine))`, not `personal_sign` or EIP-712. Contract simulation additionally checks depth/impact-mid rules. Delayed observations remain historical; the relay never substitutes current timestamps or a fabricated price.

## Restart and account ownership

Use one durable journal and one dedicated sender across all commands for a market. Only one transaction may be outstanding. Signed transaction bytes and their hash are fsynced to the journal before broadcast. Restart or RPC failure rebroadcasts the same signed bytes; it never prepares a replacement transaction for an unresolved journal entry. Canonical receipts must reach `finalized` before the next action. A reverted transaction stops the tick. A sender with unknown pending transactions is refused.

The journal is bound to chain, market, runtime hashes, listing and sender. Do not delete it, change sender, or run another process using that account while transactions are unresolved. A `.lock` file excludes concurrent processes sharing the journal. After an unclean shutdown, verify the old process has stopped before removing only the stale `.lock`; preserve the journal. Use a local durable filesystem. An unavailable finalized tag, ambiguous nonce, corrupted journal or failed RPC requires reconciliation; there is no timed replacement or automatic journal reset. Do not commit operational journals: they contain signed, broadcastable transactions and incident history.

These helpers are not a continuously deployed service. Integration still needs a real manifest, measured network gas, operational custody, a running price source and an explicit monitor operator. Tests use fake transports and public test keys, never live RPCs or accounts.

```sh
bun test
bun run typecheck
```
