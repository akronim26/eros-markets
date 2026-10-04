# Supervised deployment preparation — Render first

Original milestone 7 prepares the running service and tests local OS process
restart behavior. **No Render resource/account deployment or hosted availability
is verified yet.** User preference is Render; billing, account/repository access
and activation are still pending. Milestone 8 now provides [monitoring and offline
backup/restore commands](operations.md); hosted scheduling/operator acceptance
remain pending. Reviewed release remains milestone 9. The paid Monad coverage proof stays
deferred at its actual 268/300 result.

## Prepared host configuration

[`deploy/render.yaml`](../deploy/render.yaml) defines one Node background worker,
one 1 GB persistent disk mounted at `/var/data`, manual deploys, pinned Node
24.21.0, and a 120-second graceful shutdown allowance. It builds only this package
using the lockfile and its pinned TypeScript compiler. No incoming HTTP port,
cron, replicas, automatic schema initialization or public RPC/key value is added.
No root/counterpart files or Git workflow records are changed.

Render background workers run continuously and support attached disks on paid
compute. Without a disk, Render filesystem changes are lost on restart/redeploy;
the mounted disk is available at runtime, not during build/pre-deploy. Disk-backed
services use one instance and redeployment has downtime. These platform limits
need to remain visible in feed-gap evidence. Sources: [workers](https://render.com/docs/background-workers),
[persistent disks](https://render.com/docs/disks), [Blueprint fields](https://render.com/docs/blueprint-spec).

At the checked rates, the proposed `0.5c-512mb` worker is $7/month and a 1 GB
disk is $0.25/month: **about $7.25/month before bandwidth, build/other extras or
taxes**. This is a small diagnostic capacity candidate, not a measured production
capacity guarantee or a spending approval. Confirm current dashboard billing
before creation. [Render pricing](https://render.com/pricing).

The Blueprint intentionally omits a branch: during setup select the user's
published pricefeed branch explicitly. It never authorizes pushing or deploying
`main`. Render supports a custom Blueprint path; select
`packages/pricefeed/deploy/render.yaml` rather than moving it to the repo root.
The committed source must contain the new implementation before Render can build
it. User commit/push remain manual. [Blueprint setup/reference](https://render.com/docs/blueprint-spec).

## Start and one-time initialization

`render-start.js` requires `PRICEFEED_SERVICE_PROFILE` (Blueprint value:
`/var/data/pricefeed/profile.json`). It starts the reviewed supervisor profile.
If state is missing, invalid or operator-stopped, it **parks without a collector
or signer**, emits `SERVICE_PARKED` with `healthy:false`, and waits for shutdown.
A completed finite campaign also parks. Render's process-status UI is not feed
health: seeing a running worker does not certify fresh source or engine readiness.
There is no HTTP health-check path for this background-worker profile.

After account/billing/branch selection and explicit cloud activation approval:

1. Create the single worker from the reviewed Blueprint. Initially it parks;
   there are no source requests or transactions before preparation.
2. Open that worker's **runtime Shell**, not a one-off/pre-deploy job. Verify
   `pwd` is this package and `/usr/bin/flock --version` is available. The supervisor
   requires Linux, POSIX file locks and exactly Node 24.21.0. Remote native-image
   tools/permissions are not certified by the local test; missing tools stop output.
3. Initialize a fresh **read-only** state once:

   ```bash
   ./node_modules/.bin/node dist/scripts/render-profile.js prepare-readonly /var/data/pricefeed artifacts/calibration/inputs.json
   ./node_modules/.bin/node dist/scripts/supervise.js check /var/data/pricefeed/profile.json
   ```

4. Configure the log monitor as described in [operations.md](operations.md),
   including checking the runtime Python/SQLite tools. Restart the worker manually.
   Look for `SUPERVISOR_READY`, `WORKER_READY`, and
   actual `SOURCE_CAPTURE` records. Inspect each market's source status, including
   stale sports/crypto samples; do not call a running process a successful feed.
5. Exercise a graceful manual restart on Render and independently check preserved
   captures/leases. This hosted drill and CPU/memory/disk growth measurement remain
   required after deployment. The one-hour/day retention and backups are not
   implied by a 1 GB disk.

The runtime never invokes `prepare-readonly`. Preparation refuses existing
marker/lock/archives and partial setups remain visible; it cannot adopt a restored
old archive or silently recreate a lost one. A missing disk/DB on restart blocks
output. Profile inputs have raw-file SHA-256 pins; marker/config mismatch or changed
archived config requires review. State, main DB, WAL/SHM, lock and supervision
files must have real owner-only parents, current-user ownership and no symlink/
hardlink aliases. Operator-owned files remain a trusted OS-user boundary.

## Supervision and restart rules

`npm run service -- prepare PROFILE`, `check PROFILE` and `run PROFILE` provide
the portable Linux entry points. Profiles require absolute paths, explicit mode,
input hashes, restart delay/limit/shutdown bounds and stream-hint selection.
The Render preparation uses read-only mode, stream hints off, 60-second restart
delay, three unexpected restarts, and a 90-second internal stop allowance.

The launcher acquires an OS `flock` through inherited fd 3. The supervisor and
worker both retain the same open file description. A duplicate launcher cannot
start a writer; a worker orphaned by a killed supervisor keeps the lock until it
exits. The shell lock command is fixed; profile values are passed as argv, not
interpolated as shell code. Do not delete/replace a lock inode to force takeover.
SQLite writer leases and signer fencing remain separate safeguards.

Graceful SIGINT/SIGTERM drains bounded work, releases worker leases and closes
journals. Supervised signal handlers remain installed through draining because
the process group and supervisor can both deliver TERM; repeated TERM cannot
bypass cleanup. The existing `serve` CLI now releases its worker leases after draining;
an immediate new process no longer waits for a cleanly stopped owner's lease.
After a crash, the supervisor waits for retained source leases without clearing
them, rechecks input/archive integrity, and then lets existing pipeline checks
reconcile any packet/signer/relay/chain history. Only declared transient errors
or abnormal crashes restart. Unknown errors, corruption, config/pin changes,
quarantine, missing keys and exhausted budgets stop for review.

`supervision.json` persists state and restart count with a checksum, file fsync,
atomic rename and parent fsync. A RUNNING state left by a lost supervisor consumes
a restart on the next launch. The maximum cannot be renewed by host relaunch.
An OPERATOR_STOP persists; there is no automatic latch/quarantine reset or journal
deletion switch. Same-user tampering is outside these diagnostic custody controls.

## Explicit finite Monad profile

The default Render preparation never loads/unlocks actual keys or sends a
transaction. `MONAD_TESTNET` is a separate explicit profile requiring pinned
config/rules/ABI/policy files, named RPC environment variable, private key and
complete existing five-journal directories, cumulative finalized target,
duration, and absolute `notAfterMs`. Initialization is always **false** for this
worker. The existing Monad preflight, signer-history and exact-byte reconciliation
run before publication; none are bypassed by supervision.

Preparation fixes a persistent campaign deadline at the earlier of notAfterMs
and preparation time + duration. Restart uses only remaining time and never
renews that deadline, transaction budget, nonce, source sequence or existing
finalized target. Budget exhaustion/quarantine abort the finite service; normal
completion is not automatically repeated. An expired campaign requires explicit
review/authority, not a new empty state directory. Supervision does not approve
continuous spending or the prepared deferred retry budget.

Moving the existing funded bot to Render requires a coordinated stop and secure
transfer of **all five journals, any recovery evidence and both key roles**, then
remote owner/permissions, RPC, signer and receipt reconciliation. The current
adjacent-password testnet setup is not approved production custody. Nothing was
copied/uploaded, no actual key was unlocked, and no new testnet spend occurred in
this milestone. [Milestone 8 procedures](operations.md) supply diagnostic backup/
restore tools; production custody approval and actual hosted restore remain open.

## Verification and remaining activation

`npm run test:deployment` runs local real-process/SQLite/flock tests using scripted
source responses. They cover graceful new-process handoff, worker SIGKILL with
real lease expiry, duplicate supervisor rejection, orphan-held locks, persistent
restart/operator stops, corrupt/missing archives, finite deadline immutability,
the parked Render wrapper and the original CLI lease fix. No Render account or
paid Monad endpoint is exercised. Full-suite crash/crypto tests remain separate.
The milestone 7 full Node suite passed **406/406**, including twelve deployment tests.
[`deployment-unit.json`](../artifacts/verification/deployment-unit.json) records
the final counts, initial shutdown failure/fix, process cases and evidence hashes.

`python3 scripts/verify-deployment.py OFFICIAL_SCHEMA_JSON` independently validates
the Blueprint with PyYAML/jsonschema against Render's retained
[official schema](https://render.com/schema/render.yaml.json). It is local schema
validation, not Render account/API launch acceptance. Raw schema/TAP stay ignored
in `var/verification/deployment/`; compact verification records hashes and outcomes.

To activate, the remaining user inputs are: Render account/repository access,
approval of the proposed recurring worker/disk charge, the published branch and
commit to deploy, and later explicit testnet campaign authority if publication
is desired. Prepared deployment code does not claim a running hosted bot.
