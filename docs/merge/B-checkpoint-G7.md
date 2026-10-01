# B checkpoint at G7 — integrated hand-off (after B040–B044)

**Gate status:** G7 not passed (no merge SHA). B coordinates G7; nothing here marks it passed.

## What the B side satisfies alone

| Item | Task | Lane result |
|---|---|---|
| `test/integration/B/FullLifecycle.t.sol`, `artifacts/risk/counterpart-status.json` | B040 | full B engine campaign passes (4 tests); every live counterpart join BLOCKED, Person A not integrated |
| `test/gas/B/AdapterGas.t.sol`, `artifacts/risk/gas-adapters.json` | B041 | 64-examined bound incl. stale nodes; callback independent of participants (<1%); ring-bounded observation updates; local EVM only |
| `packages/risk-sdk/src/index.ts`, `test/read-model.test.ts`, `docs/app-state-fixtures.json` | B042 | read-only decoders; unavailable != 0; projections not withdrawable; 6 tests pass (cached tsx) |
| `artifacts/reviews/B-on-A.md` | B043 | **BLOCKED**: no A code; 19 reproducers listed, not run |
| `artifacts/risk/integration-release.json`, `docs/runbooks/lifecycle.md` | B044 | replay commands, keeper jobs, pending-state runbook, disabled features, blocked joins |

Exact acceptance commands `bash scripts/check-task.sh B040..B044` exit 127 (A002 runner absent);
the provisional runner exits 0 for B040/B041/B042/B044 and 1 for B043. Recorded in
`docs/merge/B-evidence/B04x.json` and `B04x-exact.json`.

Whole forge project at hand-off: 42 suites / 427 tests pass (book suites + 317 B tests); B Python
reference 156 tests OK.

## Combined check to run at merge (G7)

```bash
git switch -c integration/w7 <G6 merge SHA>
git merge <A W7 head> <B W7 head>
for t in B040 B041 B042 B043 B044; do bash scripts/check-task.sh $t; done
bash scripts/check-gate.sh G7
```

G7 passes only with real A+B modules end to end, B043 redone with no open critical finding, and
counterpart status reported as PASS only where the real counterpart ran.
