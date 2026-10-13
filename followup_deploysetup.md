# Follow-up: deployment setup

State as of 2026-10-14. Nothing below is committed. Work stopped mid-way at the user's request.

## 1. Do this first: migrate the supervisor config (restart is broken until then)

The live supervisor (pid 20361, restarted 20:12 UTC by someone else; `tmp/redeploy-20261011/supervisor.pid`
is stale) runs fine on code loaded before the change below. The current code requires every native market
to have a `privateDirectory`. `check` on the current config fails with `IGNORED_PRIVATE_PATH_REQUIRED`, so
**the next restart will fail** until these steps are done:

1. Stop the supervisor with SIGTERM (`kill -TERM 20361`). Wait until `tmp/redeploy-20261011/supervisor/status.json`
   reads `stopped` and `supervisor.lock` is gone.
2. Move the maker/trader state into the spot market's private folder:
   - `oracle/deployments/native/nba-gsw-mia-20261105-spot.maker-state.json` → `tmp/native-spot/nba-gsw-mia-20261105-spot/maker-state.json`
   - `oracle/deployments/native/nba-gsw-mia-20261105-spot.trader-state.json` → `tmp/native-spot/nba-gsw-mia-20261105-spot/trader-state.json`
3. In `tmp/redeploy-20261011/supervisor.json`, replace each native market's `envFile` with a `privateDirectory`:
   - `native-nba-gsw-mia-spot`: `"privateDirectory": "tmp/native-spot/nba-gsw-mia-20261105-spot"`
   - `native-nba-gsw-mia-perp`: `"privateDirectory": "tmp/native-spot-perp"`
   (`envFile` now defaults to `<privateDirectory>/ops.env`, which is where both files already are.)
4. `node scripts/ops/market-supervisor.mjs check tmp/redeploy-20261011/supervisor.json` must pass, then start
   `run` again (command in `docs/integration/TESTNET_OPERATIONS.md`).

## 2. Done (uncommitted)

- **Pricefeed build fixed.** `npm run build` exited 2 on the bun-only `scripts/native-spot/*` import errors,
  which broke the Docker build. `packages/pricefeed/tsconfig.json` now excludes `scripts/native-spot/**`
  (bun runs them directly). Build exits 0.
- **Docker image builds.** `Dockerfile` copies `cast` from `ghcr.io/foundry-rs/foundry:v1.8.3` (the native perp
  keeper needs it). `docker build` succeeded locally (arm64, Colima). Not yet built for amd64 or run.
- **No Python in the keeper.** `scripts/native-market/keeper-daemon.sh` rounds the INDEX with shell arithmetic
  instead of `python3` (differs only at an exact half tick: rounds up, Python rounded to even).
- **Native markets in the Render hand-off.**
  - `scripts/ops/market-kinds.mjs`: native markets have a `privateDirectory`; maker/trader `STATE` live there.
  - `scripts/ops/runner-handoff.mjs`: bundles only native `maker-state.json` / `trader-state.json` (never
    `ops.env` or logs); any live native worker blocks `pack`.
  - `scripts/ops/render-entrypoint.mjs`: installs a native market's `ops.env` from the secret file `<market>.env`.
  - Tests: `node --test scripts/ops/*.test.mjs` → 49/49 pass (2 new hand-off tests).
- **Frontend builds for production.** `next build` exits 0 with no warnings. The oracle SDK ABIs it imports
  are committed, so a git-based Vercel build can resolve `file:../oracle/packages/oracle-sdk`.
- **Retracted:** the "RPC hang" blocker. Every read has a timeout; the operations worker was idle, not stuck,
  and shut down in ~2–3 minutes, not 17.

## 3. Remaining work

### Render (services)
1. Smoke-test the image: `docker run --rm eros-supervisor:local cast --version`, and run the entrypoint with an
   empty disk to see it wait for the hand-off.
2. Build for Render's architecture: `docker build --platform linux/amd64 .` (or let Render build it).
3. Commit what Render builds from git: the native perp rules
   `oracle/deployments/native/nba-gsw-mia-20261105-spot-perp.rules.json`, `oracle/listings/native/nba-gsw-mia-20261105-spot-perp/`,
   `oracle/script/native/ListNativeSpotPerp.s.sol`, and all code changes from this session.
4. Update `docs/integration/RENDER_WORKER.md`: native secret files `native-nba-gsw-mia-spot.env` and
   `native-nba-gsw-mia-perp.env` (contents of each `ops.env`), and `wake.url` → the Vercel domain.
5. Hand-off: stop the local supervisor, `runner-handoff.mjs pack`, upload, `accept` on Render (steps in
   `RENDER_WORKER.md`). The white-women perp will stay blocked on Render too; that is harmless.

### Vercel (frontend)
1. Create the project: root directory `frontend`, framework Next.js, keep "include files outside root".
2. Set env vars (same names as `frontend/.env.local`): `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_RPC_URL`,
   `NEXT_PUBLIC_EXPLORER_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_READ_RPC_URL`, `MONAD_RPC_URL`,
   `MONAD_READ_FALLBACK_URLS`, `NEXT_PUBLIC_INDEXER_URL`, `NEXT_PUBLIC_INDEXER_DEPLOYMENT`.
3. The indexer is local only (`http://127.0.0.1:8083`). Without a public indexer URL, history panels show
   "Historical data is not connected yet." Host the Envio indexer (hosted service or a server) and point
   `NEXT_PUBLIC_INDEXER_URL` at it. An Envio API token also removes the HyperSync rate limiting.

### Resolution listener
- The CRE listener (`tmp/cre-listener-20261014`) runs locally only and is not in the Render image. It must run
  somewhere before the first tip-off (6 Nov). It now signs with the authorized relayer `0x709E…61fB` (5 MON).

### Known, accepted
- The Polymarket perp (white women) has no index: Polymarket's book fails the 1,000-share / 0.05 depth rule
  (verified independently). It stays listed and blocked by decision.
- `packages/pricefeed/test/deployment.test.js` has 8 failing process tests; they fail identically on clean
  `HEAD`. Run the pricefeed suite with a symlink-free `TMPDIR` (macOS `/var` is a symlink), or 82 more fail.
- `tmp/redeploy-20261014/` holds the abandoned BoE replacement inputs (no keys, nothing sent); delete if unwanted.
