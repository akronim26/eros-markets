import { defineChain } from "viem";
import { monadTestnet as base } from "viem/chains";
import { deployment } from "./deployment";

if (deployment.chainId !== base.id || (process.env.NEXT_PUBLIC_CHAIN_ID && Number(process.env.NEXT_PUBLIC_CHAIN_ID) !== deployment.chainId)) {
  throw new Error("Frontend network must match the verified deployment.");
}

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz";
export const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL || "https://testnet.monadscan.com";
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";

export const chain = defineChain({
  ...base,
  rpcUrls: { default: { http: [RPC_URL] } },
});

/** Public RPC log reads are capped at 100 blocks. */
export const LOG_BLOCK_CAP = 100n;

export const explorerAddress = (a: string) => `${EXPLORER_URL}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER_URL}/tx/${h}`;
