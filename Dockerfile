# Always-on Monad testnet market supervisor (publisher, keeper, maker). Render Background Worker.
# The persistent disk is mounted at /app/tmp. Secrets come from Render secret files at runtime;
# see docs/integration/RENDER_WORKER.md. Never bake keys, RPC URLs or journals into the image.
FROM oven/bun:1.3.13-debian AS bun

FROM node:24.21.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tar && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# Dependencies first for layer caching: pricefeed (Node 24, node:sqlite), oracle workspace
# (market-ops for the keeper, run by Bun) and viem for the maker.
COPY packages/pricefeed/package.json packages/pricefeed/package-lock.json packages/pricefeed/
RUN cd packages/pricefeed && npm ci --no-audit --no-fund
COPY oracle/package.json oracle/bun.lock oracle/
COPY oracle/packages oracle/packages
COPY oracle/services oracle/services
COPY oracle/e2e/package.json oracle/e2e/
COPY oracle/workflows/listen/package.json oracle/workflows/listen/
RUN cd oracle && bun install --frozen-lockfile --ignore-scripts
# The maker resolves viem through frontend/; install only that package at the lockfile's version.
RUN mkdir -p /opt/viem frontend && cd /opt/viem && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --ignore-scripts --save-exact viem@2.57.2 \
 && mv node_modules /app/frontend/node_modules

COPY . .
RUN cd packages/pricefeed && npm run build
# The disk mounts here; the image must hold no private state, and /tmp/ must stay ignored.
RUN test ! -e tmp && mkdir -p tmp && grep -qx '/tmp/' .gitignore

ENV NODE_ENV=production EROS_CONTAINER_MODE=1
# No inbound ports: the supervisor polls the frontend's activity route.
CMD ["node", "scripts/ops/render-entrypoint.mjs"]
