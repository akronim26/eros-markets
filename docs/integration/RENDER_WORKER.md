# Always-on market supervisor on Render

The supervisor (publisher, keeper and maker for each market) moves from the local Mac to a
Render **Background Worker on a paid instance with a persistent disk**. Never use the free
tier: it sleeps and loses its filesystem, which breaks nonce and journal safety.

Files: `Dockerfile`, `.dockerignore`, `render.yaml`, `scripts/ops/render-entrypoint.mjs`,
`scripts/ops/runner-handoff.mjs`.

## Rule: never two runners

Two supervisors would sign with the same nonces from the same journals. The hand-off enforces
one runner at a time:

- `pack` (on the Mac) refuses unless the local supervisor is stopped (no `supervisor.lock`,
  status `stopped`/`blocked`, no worker process, no journal lock). It then writes
  `handed-off.json` into the local state directory; from then on the local supervisor refuses
  to start (`RUNNER_HANDED_OFF`).
- On Render the entrypoint waits until `accept` has verified every bundled file's SHA-256 on
  the disk. Before that the supervisor refuses (`HANDOFF_NOT_ACCEPTED`).

## Steps

1. **Create the service** from `render.yaml` (Blueprint) or by hand: Docker runtime, plan
   Starter or above, 1 instance, disk `eros-private` mounted at `/app/tmp` (1 GB), env
   `EROS_SUPERVISOR_CONFIG=tmp/redeploy-20261011/supervisor.json`. No ports.
2. **Add secret files** (Render → Environment → Secret Files). They are copied onto the disk
   as `0600` files at each start and are never in the image or bundle:
   - `rpc-pool.env`: contents of `tmp/redeploy-20261009/rpc-pool.env`;
   - `nov7-dem-white-women.roles.env`: contents of
     `tmp/redeploy-20261011/nov7-dem-white-women/roles.env`;
   - `nov7-dem-white-women.keys.tgz.b64`: output of
     `tar -czf - -C tmp/redeploy-20261011/nov7-dem-white-women/services/keys . | base64`.
3. **Point wake-on-visit at Vercel.** Before packing, set `wake.url` in
   `tmp/redeploy-20261011/supervisor.json` to `https://<vercel-domain>/api/market-activity`.
   The local URL does not exist on Render.
4. **Stop the local supervisor** with SIGTERM (`kill $(cat tmp/redeploy-20261011/supervisor.pid)`)
   and wait for `status.json` to read `stopped`. Never force-kill it.
5. **Pack:**
   `packages/pricefeed/node_modules/node/bin/node scripts/ops/runner-handoff.mjs pack tmp/redeploy-20261011/supervisor.json ~/eros-handoff.tgz`
6. **Upload and accept** in the Render shell (the service is waiting):
   `tar -xzf eros-handoff.tgz -C /app` and then
   `node scripts/ops/runner-handoff.mjs accept tmp/redeploy-20261011/handoff-manifest.json`.
   Upload the bundle with any private transfer you trust; it contains journals but no keys.
7. **Check:** the entrypoint starts within a minute. Then
   `node scripts/ops/market-supervisor.mjs check tmp/redeploy-20261011/supervisor.json` should
   pass, and `tmp/redeploy-20261011/supervisor/status.json` should show three running workers.

Rollback (back to the Mac): stop the Render worker and wait for `stopped`, then pack on Render
(this fences the Render disk). Only then remove the local `handed-off.json`, extract the bundle
locally and run `accept` before starting the local supervisor.
