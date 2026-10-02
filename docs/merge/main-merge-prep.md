# Merge prep: `origin/main` into `integration/risk` (dry run; nothing merged into main)

- Prepared 2026-10-02 by 0xr10t (with Claude agent).
- Branch: local `scratch/main-merge-prep`, never pushed.
- No merge into `main` was made and none is authorized. A human decides when to merge.

## Inputs

- `integration/risk` at `e61c8a7`.
- `origin/main` at `c5db208`. It is unchanged since 2026-10-01.
- Merge base: `ffc9f52`.
- Main-only commits:
  - `ff05f0c` (book: configurable fill bound, with BookGas snapshot and book tests)
  - `5cbd0cb` (book README)
  - `494dc72` (earlier merge of feat/risk)
  - `2db4e08` and `c5db208` (Monad size limit)
  - `253ebd5` (book developer's reformat of Risk files)
- Scratch merge commit: `8b71ed7` (local only). To reproduce:
  `git switch -c scratch/main-merge-prep e61c8a7 && git merge --no-ff origin/main`.

## Conflicts and resolutions

| File | Cause | Resolution |
|---|---|---|
| `contracts/foundry.toml` | main sets `code_size_limit = 131072` (Monad) in the default profile; we set 1,000,000 for the `ci` and `risk` test profiles | Keep main's default 131072. Keep the `ci`/`risk` 1,000,000 limits for test harnesses only (CombinedBase embeds three engines; forge 1.8.3 checks test contracts too), with a comment |
| `contracts/src/risk/TradePreview.sol` | `253ebd5` reformat versus our later content changes | `git diff ffc9f52 origin/main` shows formatting only. Keep ours, then `forge fmt` |
| `contracts/test/mocks/B/MockBookAdapter.sol` | `253ebd5` reformat (one import line) | Formatting only. Keep ours, then `forge fmt` |

- The other files that `253ebd5` reformatted merge automatically.
- After the merge, `forge fmt` (forge 1.8.3) reformatted 26 Risk & Clearing files:
  - 3 under `contracts/src`
  - 23 tests and mocks
- No book-team file was touched by the formatter.

## Results on the scratch merge (`8b71ed7`, forge 1.8.3)

| Command | Exit | Result |
|---|---|---|
| `forge fmt --check` | 0 | clean |
| `FOUNDRY_PROFILE=ci forge build --sizes` | 0 | `CombinedEngine` runtime 112,924 B, initcode 121,706 B |
| `FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test` | 0 | 653 passed, 0 failed |
| `FOUNDRY_PROFILE=ci FORGE_SNAPSHOT_CHECK=true forge test --mc BookGasTest` | 0 | 8 passed (book snapshot unchanged) |
| `bash scripts/check-gate.sh G0`…`G6` | 0 each | checks_passed (68/152/117/78/74/62/55) |
| `bash scripts/check-gate.sh G7` | 2 | stops at A043: review fingerprints are out of date after B-D02/A-I01. They need the teammate's review refresh, not a merge fix |
| Python A / B / audit / integration | 0 | OK |
| `FOUNDRY_PROFILE=ci forge test -vvv` (the CI test step, 10k fuzz runs, 256×128 invariants) | 0 | 653 passed, 0 failed |

Gate artifacts written on the scratch branch were discarded. They are not evidence for any
accepted SHA.

## What the real merge needs (human-requested only)

1. The teammate reviews B-D02 and A-I01 and refreshes the A043 fingerprints on `integration/risk`.
   G7 checks then pass again.
2. A human asks for the merge. Then:
   - repeat the steps above on the then-current heads;
   - rerun the formatter, all gates and the CI steps;
   - refresh fingerprints again, because the formatter changes `contracts/src` files;
   - record G7 acceptance (human only).
3. **UNVERIFIED:** main's `foundry.toml` comment says Monad's code-size limit is 128 KiB "(spec
   §11.1)". `docs/spec/risk_spec.md` has no such section and does not mention a Monad size limit.
   A human should confirm the target chain's limit before it is treated as the production limit.
   If 131,072 B is right, `CombinedEngine` (112,924 B, with the mock book) fits with 18,148 B to
   spare. The production composition with the real book is not built yet.
