# Diagnostic monitoring, backups and recovery

Original milestone 8 implements local/Render log monitoring and offline backup/
restore drills. The user selected **local/Render logs** as the initial alert route.
No email, webhook or other notification is sent. The person who checks those logs,
response expectations, hosted backup schedule and production retention remain
operator decisions before activation. No PF human gate or production approval is
recorded here. Render activation and the deferred 268/300 coverage proof stay open.

## Read-only status and alerts

From this package, after building with pinned Node 24.21.0:

```bash
./node_modules/.bin/node dist/scripts/operations.js health /absolute/profile.json /absolute/operations.json
./node_modules/.bin/node dist/scripts/operations.js watch /absolute/profile.json /absolute/operations.json
```

`health` exits 0 only when every configured operations check passes; otherwise it
returns a status report and exits 1. `watch` emits one-line JSON health records
and `ALERT_OPEN` / `ALERT_CLEARED` transitions. An unchanged condition is not opened
again on every poll; restarting the monitor opens active conditions again. These
are log events, not acknowledged notifications. Watch shutdown wakes its timer.
The monitor never unlocks keys, allocates sequences/nonces, sends transactions,
contacts providers/RPC, clears quarantine or changes the service's pricing policy.

Each configured market reports its last capture, current source age, capture
silence, status and reason. Freshness is recomputed at query time, even when the
service has stopped. Missing, stale, invalid or quarantined source data remain
unavailable; the monitor does not substitute price zero. Source capture silence
and source timestamp freshness are separate checks. A live process can still have
stale books. `collectionHealthy` requires fresh collecting markets and valid
deployment/running supervision; it is not an engine readiness assertion.

Other checks show:

- Persistent supervisor stops, changed pins, corrupt/missing source archives.
- Available disk bytes on the state and testnet journal filesystems.
- Testnet delivery states, pending deliveries, persistent relay quarantine,
  last finalized archived receipt with block number/hash/time/depth validity,
  receipt progress and exact reservation counts/costs, including cancellation
  reservations. Reserved cost is a spending ceiling, not actual fees paid.
- Pinned backup integrity, age, matching service profile and required testnet
  custody inclusion. An unconfigured backup is an explicit alert.

Archived lifecycle checkpoints remain block-labeled and freshness checked. The
monitor does not refresh them through RPC. `chainQueried:false`, null wallet balance
and null `indexTwap300` preserve that limitation; archived receipt state alone does
not establish current canonicality, full 300-second coverage or economics. The
existing live preflight/lifecycle/reconciliation commands remain required before
publication. Reads across live journals are diagnostic views, not a coordinated
transaction snapshot or permission to resume signing.

[`config/operations-diagnostic.json`](../config/operations-diagnostic.json) provides
explicit candidate thresholds: 30-second monitoring/capture silence, 100 MiB free
space, one pending delivery, 120-second receipt silence, 0.05 test MON reservation
headroom and 24-hour backup age. These are development inputs, not approved cadence,
capacity, retention or spending parameters. Monetary values are integer wei.
Changing monitor thresholds does not change the bot's source-time or relay limits.

## Render setup

The prepared Blueprint names `PRICEFEED_OPERATIONS_CONFIG` as
`/var/data/pricefeed/operations.json`. The Render wrapper loads that explicit file
and runs the log monitor while collecting **and while parked**. Missing/invalid
settings emit `OPS_SETTINGS_UNAVAILABLE`. Settings changes require a manual restart.
There is no automatic threshold selection or backup initialization.

During the approved runtime Shell setup in [deployment.md](deployment.md), verify
`python3` and its `sqlite3` module are available as well as the pinned Node/flock
tools. Their presence in the remote native image is not yet certified. Then copy
and review the candidate settings:

```bash
cp config/operations-diagnostic.json /var/data/pricefeed/operations.json
chmod 600 /var/data/pricefeed/operations.json
```

Leave `backup:null` until a complete backup and its public manifest digest exist.
The monitor will show that missing protection rather than claim all checks pass.
Actual hosted alerts, restart, disk growth and backup scheduling still need a
Render deployment. A parked worker's dashboard status is not a healthy feed.

## Coordinated offline backup

Use Python 3.10+ with SQLite support. The tool requires existing, private,
current-user-owned source state and an existing private destination parent.
Both ancestor aliases and symlink/hardlink files are rejected. Backup filenames
are a fixed set; user-provided strings are not interpolated into shell commands.

1. Stop/drain the service. Preserve any uncertain broadcast or quarantine. Verify
   that the old process/orphan actually stopped; do not delete its lock file.
2. Wait for stored source/packet/relay writer leases to expire or be released.
   Backups acquire the existing service OS lock and hold SQLite `BEGIN IMMEDIATE`
   write reservations on every required journal. Active supervisors, CLI writers
   or unexpired leases block the operation; the tool never clears them.
3. Choose a **new** bundle directory outside service/journal/key directories,
   under an existing owner-only backup parent:

   ```bash
   mkdir -m 700 /absolute/private-backups
   python3 scripts/backup-journals.py backup /absolute/profile.json /absolute/private-backups/run-001
   ```

   For an explicitly selected testnet custody backup, append
   `--include-testnet-custody`. This copies both encrypted wallet files and both
   unlock files as owner-only bytes; it never decrypts or signs. **That bundle is
   sensitive and contains unlock material.** Do not put it in Git, logs or public
   storage. It is private diagnostic custody, not an approved production vault.
   Without the flag, a testnet bundle preserves all journals but is incomplete for
   recovery after loss of both key roles; monitoring reports that distinction.
4. Save the printed public `manifestSha256` separately from the backup. Verification
   requires this exact digest; a rewritten manifest cannot approve swapped files.
   Configure `backup:{"directory":"/absolute/bundle","manifestSha256":"..."}`
   in the operator settings only after verification.

SQLite's backup API copies committed data including WAL-resident rows. Holding all
journal write reservations prevents independent writes during the coordinated
copy; simply copying live main DB files would omit WAL data. Sources:
[SQLite backup API](https://www.sqlite.org/backup.html),
[SQLite transactions](https://www.sqlite.org/lang_transaction.html),
[Python backup API](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup).

The bundle retains source and, for testnet, packet/observation-signer/transaction-
signer/relay journals, including relay budget/cancellation tables; input files and
original profile/marker/supervision state are pinned too. It checks SQLite structure,
required tables and existing application record checksums. Files are exclusive,
owner-only and flushed. A complete manifest is written last and directory entries
are flushed. Interrupted or disk-full copies remain partial and cannot be adopted
or resumed as successful backups. Existing bundles are never overwritten.

The tool preserves expired deadlines, restart counters and quarantine. It does not
approve old data, cryptographic signer identity or current chain history. Existing
publication startup checks remain authoritative. Nonstandard extra journal files
outside this fixed service layout require their own reviewed inventory; they are
not silently included. No retention deletion, offsite upload, recurring host job
or automatic service stop/restart is installed. Schedule offline copies only after
agreeing a maintenance gap and off-host storage; a copy on the same Render disk
does not protect against losing that disk.

## Verify and restore for review

```bash
python3 scripts/backup-journals.py verify /absolute/bundle MANIFEST_SHA256
python3 scripts/backup-journals.py restore-review /absolute/bundle MANIFEST_SHA256 /absolute/private-restore/candidate-001
```

The candidate destination's private parent must already exist. Verification rejects
changed files, missing members, an unexpected file list, invalid SQLite/app checksums
and a mismatched external manifest pin. Restore exclusively copies to a **fresh,
isolated** directory and verifies it again, retaining originals. It writes
`RESTORE_REVIEW_REQUIRED.json`; it does not overwrite active paths, rewrite profile
paths, create a new wallet, remove operator stops, renew a campaign or launch a bot.
An existing candidate or active service path is refused.

Before any manual activation, reconcile original/restored signing history and
canonical engine sequence, transaction signer ID, sender nonce, known raw
transactions, receipts, budget audit and source/lifecycle ordering. A coordinated
backup can still be behind the chain or another surviving signer. Never solve
that by deleting journals or changing stored timestamps/nonces. Secure key identity
and permissions checks plus the existing startup checks must pass. Actual hosted
restore/continuation and reviewed production custody remain unverified.

## Response runbooks

| Condition | Operator action |
|---|---|
| Source silence/stale timestamps | Check collection and provider status; preserve repeated clocks/gaps. Faster polling cannot refresh an old vendor timestamp. |
| Source closure or changed rules | Preserve quarantine and mapping evidence; involve listing/oracle owners. Do not invent a final price or change Eros T. |
| Receipt silence, UNKNOWN/ORPHANED or reserved nonce | Preserve all five journals. Use the existing canonical receipt/history recovery path. A timeout is not proof of non-delivery. |
| Budget exhausted/low | Review counts, reservation ceilings and actual fees. Use the explicit audited budget plan; monitoring never renews authority. |
| Key missing/unlock/identity failure | Stop publication; inspect custody and known public identities. Restore the same reviewed role, never silently generate or rotate it. |
| Low disk/IO/permission/corruption | Stop/drain if needed, preserve failed files, verify permissions/storage and a complete backup. Do not prune signed history to regain space. |
| Missing/stale/corrupt backup | Make and verify a fresh offline copy after coordination. Keep failed/old bundles for review; do not update the digest to bless corruption. |
| Duplicate writer/restart limit/operator stop | Stop the duplicate or investigate the original/orphan; respect OS locks, leases and persistent state. No reset flag or lock-inode deletion. |

For expiry, exact-byte reconciliation and the narrowly authorized never-broadcast
nonce cancellation, follow [custody.md](custody.md),
[monad-testnet.md](monad-testnet.md#explicit-recovery-of-a-signed-never-broadcast-nonce)
and [recovery-runbook.md](recovery-runbook.md). Recovery sends still need their
existing explicit transaction authority. RECORD_ONLY/lifecycle stopping remains
the existing engine policy; this monitor does not resolve the event.

## Local verification scope

`npm run test:operations` runs monitoring tests and eleven Python backup drills.
Real components are SQLite/WAL, local file permissions/locks, process signals,
checksums and backup/restore copying. Source/publication/custody records are
temporary fixtures. Disk-full is an injected ENOSPC failure, not a filled host
disk. No actual wallet is opened, no RPC call is made and no MON is spent.
Hosted alert response, offsite retention/scheduling, production custody and named
operator acceptance remain activation/release work.

Verified locally: **416/416** full Node tests, **22/22** focused monitoring/deployment
tests and **11/11** Python backup drills, all exit 0. Wire, 144 impact vectors,
five coverage reference cases and the revised Blueprint schema pass separately.
[`operations-unit.json`](../artifacts/verification/operations-unit.json) records
commands, case declarations, source/raw-log hashes and unchanged active Monad journals.
Raw logs/bundles stay ignored; another checkout must rerun its own evidence.
