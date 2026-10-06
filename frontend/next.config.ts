import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(__dirname, "..");

const config: NextConfig = {
  transpilePackages: ["@eros-oracle/oracle-sdk"],
  // The risk SDK lives outside this app (packages/risk-sdk); allow compiling it in place.
  turbopack: {
    root: repoRoot,
    resolveAlias: { "@eros/risk-sdk": "../packages/risk-sdk/src/index.ts" },
  },
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
};

export default config;
