import type { Address, Hex } from "viem";

/** Monad testnet inventory from addresses.md and oracle/deployments/monad-testnet.json. */
export const deployment = {
  chainId: 10143,
  risk: {
    collateralVault: "0xa8341d0343bc71b0f28e82dba2302c528608898d" as Address,
    collateralToken: "0x99f93e9bfe3b2dd75fe27327789bd0a9236ff7b0" as Address,
    collateralDecimals: 6,
    collateralSymbol: "RISK-TEST",
  },
  oracle: {
    resolutionOracle: "0xa87D6E10a7199666ec9F2e04866201E35AAf36A6" as Address,
    marketRegistry: "0xEC11cC8fAfd47a1a92A7c9B43EEdee86a94B3DFa" as Address,
    umaAdapter: "0x1387bC4d10acd2aFB0C85b6f62a51Ad91600C3A1" as Address,
    bondToken: "0xFE854aEB0e1B5B568291f52696E5726c89a8d39e" as Address,
    deployBlock: 67901624n,
  },
} as const;

export type MarketManifest = {
  engine: Address;
  marketId: Hex;
  listingHash: Hex;
  deployBlock: bigint;
  title: string;
  short: string;
  oracleMarketId: Hex | null;
  resolution: "MANUAL_TEST_AUTHORITY" | "ORACLE";
  fixture: boolean;
  role: "demo" | "terminal-test";
};

export const markets: MarketManifest[] = [
  {
    engine: "0x58c63bfd94c13acb6f1da665406cc16cf80d1b69",
    marketId: "0x75be8f1f39e85b942a81e019e98ae380c65da9a1fc2e90b531fddbe9ad96870a",
    listingHash: "0x46a5cee0c75458e355018cde6e76ec94bb529c91489ed152c56ee2a4d597c95f",
    deployBlock: 67915021n,
    title: "Testnet fixture market (no real-world question)",
    short: "FIXTURE-1",
    oracleMarketId: null,
    resolution: "MANUAL_TEST_AUTHORITY",
    fixture: true,
    role: "demo",
  },
];

/** Oracle-listed markets (resolution pages). The first runs on a stub engine, not a tradeable one. */
export const oracleMarkets: { id: Hex; note: string }[] = [
  {
    id: "0xbb40e8e0ece7adae065af4f5a16f87abe4a912db0ada1696171ac7ef6b3be5ea",
    note: "Listed on the oracle's testnet stub engine; not connected to a tradeable book.",
  },
];

export const marketByEngine = (engine: string) =>
  markets.find((m) => m.engine.toLowerCase() === engine.toLowerCase());
