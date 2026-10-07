import path from "node:path";
import type { NextConfig } from "next";
import { readFileSync, realpathSync } from "node:fs";

const repoRoot = path.resolve(__dirname, "..");
// Test-only replacements are selected server-side and use a separate build directory.
// Public builds keep their verified testnet manifest and Privy provider unchanged.
const e2eManifest = process.env.EROS_E2E_MANIFEST;
const e2eAliases: Record<string, string> = {};
let e2eRpc: string | undefined;
if (e2eManifest) {
  const filename = realpathSync(e2eManifest);
  if (!filename.startsWith(realpathSync(path.join(repoRoot, "tmp")) + path.sep)) throw new Error("E2E manifests must be in this repository's ignored tmp directory");
  const manifest = JSON.parse(readFileSync(filename, "utf8"));
  const publicFields = new Set(["manifestVersion", "scope", "chainId", "sourceCommit", "riskScenario", "sourceMode", "calibrationEvidence", "provenance", "verifiedAt", "contracts", "markets", "accounts"]);
  if (Object.keys(manifest).some(key => !publicFields.has(key))) throw new Error("Use the sanitized public-manifest.json; private/runtime manifests must not enter a browser build");
  const rpc = new URL(process.env.EROS_E2E_RPC_URL || "");
  if (manifest.scope !== "local-only" || manifest.chainId !== 31337 || !manifest.verifiedAt
    || rpc.protocol !== "http:" || rpc.hostname !== "127.0.0.1" || rpc.username || rpc.password || rpc.search || rpc.hash || rpc.pathname !== "/") throw new Error("E2E requires a verified local manifest and loopback RPC");
  e2eRpc = rpc.toString();
  for (const [name, file] of Object.entries({ "@/config/deployment": "local-deployment.ts", "@/config/chain": "local-chain.ts", "@/components/providers": "local-providers.tsx" })) e2eAliases[name] = path.join(__dirname, "e2e/support", file);
  e2eAliases["@eros-e2e/manifest"] = filename;
}

const config: NextConfig = {
  ...(e2eManifest ? { distDir: ".next-e2e", env: { NEXT_PUBLIC_RPC_URL: e2eRpc!, NEXT_PUBLIC_READ_RPC_URL: "", NEXT_PUBLIC_INDEXER_URL: "", NEXT_PUBLIC_INDEXER_DEPLOYMENT: "", NEXT_PUBLIC_PRIVY_APP_ID: "" } } : {}),
  transpilePackages: ["@eros-oracle/oracle-sdk"],
  // The risk SDK lives outside this app (packages/risk-sdk); allow compiling it in place.
  turbopack: {
    root: repoRoot,
    resolveAlias: { "@eros/risk-sdk": "../packages/risk-sdk/src/index.ts", ...e2eAliases },
  },
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
  webpack(config, { webpack }) {
    // A new disposable deployment can reuse the same contract addresses. Avoid
    // carrying a previous fixture's manifest through webpack's filesystem cache.
    if (e2eManifest) config.cache = false;
    config.resolve.alias = { ...config.resolve.alias, ...e2eAliases };
    // Next's tsconfig path plugin resolves @/* before ordinary webpack aliases.
    // Replace these exact requests before resolution so the test build cannot
    // silently connect the production provider or deployment to a local RPC.
    if (e2eManifest) config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /^@\/(?:config\/(?:deployment|chain)|components\/providers)$/,
      (resource: { request: string }) => { resource.request = e2eAliases[resource.request]; },
    ));
    return config;
  },
};

export default config;
