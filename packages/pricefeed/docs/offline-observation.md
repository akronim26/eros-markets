# Offline observation replay (PF017)

`build-observation` reconstructs an unsigned development observation from a
specific retained collector capture. It is useful for inspecting arithmetic,
invalid-depth policy and exact wire output before reviewing the joined pipeline.
It uses the existing pure builder, with disabled configurations on chain 31337.

Run from `packages/pricefeed/` after `npm run build`:

```bash
npm run cli -- build-observation --config var/replay/config.json --rules var/replay/rules.json --db var/capture.sqlite --capture-id 2 --sequence 1 --published-at-ms 1791059028222
```

The numbers above illustrate a historical replay; choose values from your own
archive. All six options are required. There are no wallet, RPC, sign or send
options. The source examples have no destination and cannot build a packet until
an explicit disabled local destination and matching candidate rules are supplied.

| Input | Meaning |
|---|---|
| `--config` | Parsed disabled local config, including destination pins and pricing/headroom settings |
| `--rules` | Candidate manifest matching mapping, N/spread, scheduled T and destination rules hash |
| `--db` | Existing collector SQLite archive; opened read-only, never created if missing |
| `--capture-id` | Positive `captures.id`, selected explicitly; no implicit latest/healthy selection |
| `--sequence` | Proposed nonzero uint64, printed without reservation or chain reconciliation |
| `--published-at-ms` | Explicit replay publication time at or after capture persistence time |

To inspect capture IDs with Python's standard library:

```bash
python3 - <<'PY'
import sqlite3
db = sqlite3.connect('file:var/capture.sqlite?mode=ro', uri=True)
for row in db.execute("SELECT id,worker,at_ms,json_extract(payload,'$.inspection.status') FROM captures ORDER BY id"):
    print(row)
db.close()
PY
```

A retained `demo:pipeline` report contains its exact disabled `config`, `rules`
and `archive` directory. These can be copied into separate JSON input files;
use the report's `source.sqlite` for collector captures. The report's packet or
relay databases are different journals and cannot substitute for source evidence.
Diagnostic collection archives without destinations can also be replayed with a
matching local destination; output records the original collection config digest.
This permits explicit local pricing comparisons without rewriting the archive or
claiming the collection config itself included the proposed destination.

The command verifies every stored capture checksum in a single read transaction,
checks worker/category and receipt times, and parses the retained raw event,
market and book bodies. Parsed-data copies must agree with those bodies. It
rechecks membership, mapping, tradeability, source rules, source age, metadata
age, configured headroom and depth arithmetic. Archived summaries cannot supply
the result. A degraded or quarantined selected capture cannot become eligible
through this command. SQLite may create its own WAL/SHM read coordination files;
no capture, writer lease, packet, signer or relay record is created or changed.

JSON output includes capture provenance, configured destination pins, raw-book
inspection, the eleven fields, domain, evidence hash and raw ABI/Keccak digest.
Fresh thin/wide/crossed books under the explicitly selected local invalid policy
emit zero price/impact fields with real depths/times; inspection retains calculated
impacts and failure reason. Valid-only policy instead reports unavailable.

| Exit | Meaning |
|---|---|
| `0` | An unsigned development candidate could be reconstructed at the declared replay time |
| `2` | Selected capture or source state is unavailable; packet and digest are null |
| `1` | Invalid arguments, config/rules/domain, archive corruption, raw/data inconsistency or storage failure |

The output explicitly reports zero signatures/transactions, no allocated sequence,
and unverified listing/lifecycle. `readyForSigning` and `operationalOutput` are
false. Historical replay does not establish present freshness, authoritative
sourceState ordering, canonical engine state, recording permission or provider
truth. Archive checksums detect accidental changes, not an authenticated venue
attestation. Configured code/ABI/signer hashes are displayed pins, not verified
network facts. Signing and sending remain separate journaled paths with current
headroom, ownership, reconciliation and lifecycle checks.

CLI errors emit fixed diagnostic codes, without raw input, file paths or stacks.
Unavailable output exposes the recomputed source reason; corruption and identity
errors fail as command errors. Operational policy adapters and PF gates remain
unapproved. This command adds no Monad endpoint or external transaction authority.
