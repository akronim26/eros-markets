import { PublicError, publicErrorMessage } from "@/lib/public-error";
import { PrivyClient } from "@privy-io/node";
import { isAddress } from "viem";
import { policyMatches, type SignerMode } from "./policy";
import { rateLimit } from "./store";
import { isSameOriginRequest } from "@/lib/request-origin";
import { readRpcBody, RpcBodyError } from "@/lib/rpc-proxy";

export function signerConfig(mode: SignerMode) {
  return { signer: process.env[mode === "trade" ? "PRIVY_TRADE_SIGNER_ID" : "PRIVY_PROTECT_SIGNER_ID"], policy: process.env[mode === "trade" ? "PRIVY_POLICY_TRADE_ID" : "PRIVY_POLICY_PROTECT_ID"], key: process.env[mode === "trade" ? "PRIVY_AUTHORIZATION_PRIVATE_KEY" : "PRIVY_PROTECT_AUTHORIZATION_PRIVATE_KEY"] };
}
export function configured(mode: SignerMode) {
  const c = signerConfig(mode);
  return !!(process.env.NEXT_PUBLIC_PRIVY_APP_ID && process.env.PRIVY_APP_SECRET && c.key && c.signer && c.policy) && (mode !== "protect" || (c.key !== process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY && c.signer !== process.env.PRIVY_TRADE_SIGNER_ID && c.policy !== process.env.PRIVY_POLICY_TRADE_ID));
}
let instance: PrivyClient | undefined;
export function privy() {
  if (!process.env.PRIVY_APP_SECRET || !process.env.NEXT_PUBLIC_PRIVY_APP_ID) throw new PublicError("Server signing is not configured.");
  return instance ??= new PrivyClient({ appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET, requestExpiry: { defaultMs: 60000 } });
}
export async function authenticate(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new PublicError("Log in again to continue.");
  const claims = await privy().utils().auth().verifyAccessToken(token);
  rateLimit(claims.user_id);
  return claims.user_id;
}
export async function ownedWallet(userId: string, address: string) {
  if (!isAddress(address)) throw new PublicError("Invalid wallet address.");
  const user = await privy().users()._get(userId);
  const account = user.linked_accounts.find((a) => a.type === "wallet" && a.chain_type === "ethereum" && a.address.toLowerCase() === address.toLowerCase() && ["privy", "privy-v2"].includes(a.wallet_client_type ?? "") && "id" in a && a.id);
  if (!account || !("id" in account) || !account.id) throw new PublicError("The selected embedded wallet does not belong to this user.");
  const wallet = await privy().wallets().get(account.id);
  if (wallet.address.toLowerCase() !== address.toLowerCase() || wallet.chain_type !== "ethereum" || wallet.archived_at) throw new PublicError("Wallet unavailable.");
  return wallet;
}
export async function checkedPolicy(mode: SignerMode) {
  if (!configured(mode)) throw new PublicError("This signer is not configured.");
  const c = signerConfig(mode);
  const policy = await privy().policies().get(c.policy!);
  if (!policyMatches(policy, mode)) throw new PublicError("Signer policy does not match the required trading restrictions.");
  return c;
}
export async function signingWallet(user: string, address: string, mode: SignerMode) {
  const [wallet, config] = await Promise.all([ownedWallet(user, address), checkedPolicy(mode)]);
  if (!wallet.additional_signers.some((s) => s.signer_id === config.signer && s.override_policy_ids?.length === 1 && s.override_policy_ids[0] === config.policy)) throw new PublicError("Permission was revoked or has not been granted.");
  return { wallet, config };
}
export async function jsonBody(request: Request, timeoutMs = 5000) {
  if (!isSameOriginRequest(request)) throw new PublicError("Invalid request origin.");
  try {
    const body = await readRpcBody(request, { maxBytes: 12000, timeoutMs });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new PublicError("Invalid request body.");
    return body as Record<string, unknown>;
  }
  catch (error) {
    if (error instanceof RpcBodyError) throw new PublicError(error.message);
    throw new PublicError("Invalid request body.");
  }
}
export function apiError(error: unknown) {
  // Never send SDK errors, request headers, or server credentials to the browser.
  const safe = publicErrorMessage(error);
  return Response.json({ error: safe }, { status: 400 });
}
