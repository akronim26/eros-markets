# Native observer against a real Kuru book (local fork)

- Date: 2026-10-13. Tasks: NM-F02–F06 evidence (fork). Not a public-chain observation.
- Setup: anvil fork of Monad testnet (chain 10143). `KEEP_BOOK=1 bash scripts/native-market/kuru-fork-spike.sh` created a stand-in YES/tUSDC Kuru market and rested a bid of 0.400 × 100 claims and an ask of 0.600 × 100 claims.
- Command: `node dist/scripts/native-observe.js http://127.0.0.1:18611 rules.json latest`, run from `packages/pricefeed`.

| Check | Result |
| --- | --- |
| Real `getL2Book` bytes decoded | 1 bid and 1 ask level |
| N = 100 claims (100,000 lots) | `COLLECTING`: impact bid 0.4, ask 0.6, midpoint 0.5, depth 100,000 lots each side ([observe-latest.json](observe-latest.json)) |
| N = 100,001 lots, one lot more than posted | `INVALID_DEPTH` / `INSUFFICIENT_DEPTH` |
| AMM vault liquidity | 0 / 0; excluded by policy `kuru-resting-orders-only-amm-vault-excluded-v1` |
| `finalized` tag on the anvil fork | Fails closed with `EMPTY_CALL_RESULT`. Anvil's `finalized` block is 64 blocks back, before the test market existed. The public Monad RPC's `finalized` trails `latest` by about 5 blocks |

Unit tests: `node --test dist/test/native-kuru.test.js`, 8/8 pass.
