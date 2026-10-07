import { encodeFunctionData, type Hex } from "viem";
import { engineAbi } from "../abi/engine";
import { DelegatedDeliveryError, validateIntent, type DelegatedIntent } from "./delegated-intent";
export { DelegatedDeliveryError } from "./delegated-intent";
import { FinalizedOwnerRevert } from "./finality";

export type DelegatedAttempt = {
  version: 1; chainId: number; body: DelegatedIntent; calldata: Hex;
  connectorUid: string; sessionVersion: number; createdAt: number; hash?: Hex;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export function delegatedCall(body: DelegatedIntent) {
  return { address: body.engine as `0x${string}`, abi: engineAbi, functionName: body.action,
    args: body.action === "placeOrder" ? [{ ...body.place, size: BigInt(body.place.size) }]
      : body.action === "cancel" ? [body.orderId] : [] };
}
export function delegatedCalldata(body: DelegatedIntent): Hex {
  return encodeFunctionData(delegatedCall(body) as never);
}

/** Public intent only. A reload must retain uncertainty, never silently authorize another order. */
export class DelegatedAttemptStore {
  constructor(private readonly storage: Storage, private readonly engines: readonly string[], readonly chainId: number) {}
  private key(owner: string) { return `eros-delegated-attempt:${this.chainId}:${owner.toLowerCase()}`; }
  private check(a: DelegatedAttempt, owner: string): DelegatedAttempt {
    try {
      validateIntent(a.body, this.engines);
      if (a.version !== 1 || a.chainId !== this.chainId || a.body.wallet.toLowerCase() !== owner.toLowerCase()
        || typeof a.connectorUid !== "string" || !a.connectorUid || !Number.isSafeInteger(a.sessionVersion)
        || !Number.isSafeInteger(a.createdAt) || a.createdAt < 0 || delegatedCalldata(a.body) !== a.calldata
        || (a.hash !== undefined && !/^0x[\da-fA-F]{64}$/.test(a.hash))) throw Error();
      return a;
    } catch { throw new Error("The saved trading request is invalid. Do not resubmit; check wallet activity and contact support."); }
  }
  read(owner: string): DelegatedAttempt | undefined {
    const raw = this.storage.getItem(this.key(owner));
    if (!raw) return;
    let value: DelegatedAttempt;
    try { value = JSON.parse(raw); } catch { throw new Error("The saved trading request is invalid. Do not resubmit; check wallet activity and contact support."); }
    return this.check(value, owner);
  }
  save(attempt: DelegatedAttempt) {
    this.check(attempt, attempt.body.wallet);
    // Refuse to overwrite a still-unresolved order, even from another mounted ticket.
    const old = this.read(attempt.body.wallet);
    if (old && JSON.stringify(old.body) !== JSON.stringify(attempt.body)) throw new Error("Recover the pending trading request before starting another order.");
    this.storage.setItem(this.key(attempt.body.wallet), JSON.stringify(attempt));
  }
  clear(attempt: DelegatedAttempt) {
    const old = this.read(attempt.body.wallet);
    if (old?.body.clientNonce === attempt.body.clientNonce) this.storage.removeItem(this.key(attempt.body.wallet));
  }
}

export function assertAttemptBinding(attempt: DelegatedAttempt, call: { owner: string; chainId: number; engine: string;
  action: string; calldata: Hex; connectorUid?: string; sessionVersion: number }, recoverSession = false) {
  if (attempt.chainId !== call.chainId || attempt.body.wallet.toLowerCase() !== call.owner.toLowerCase()
    || attempt.body.engine.toLowerCase() !== call.engine.toLowerCase() || attempt.body.action !== call.action
    || attempt.calldata !== call.calldata || (!recoverSession && (attempt.connectorUid !== call.connectorUid || attempt.sessionVersion !== call.sessionVersion)))
    throw new Error("Recover the saved trading request before starting or changing an order.");
}

/** A known hash never calls the signing endpoint again. Rejections must be durable server outcomes. */
export async function recoverDelegatedAttempt(store: DelegatedAttemptStore, attempt: DelegatedAttempt,
  post: (body: DelegatedIntent) => Promise<{ hash: Hex }>): Promise<Hex> {
  if (attempt.hash) return attempt.hash;
  store.save(attempt); // persist exact previewBlock, payload and nonce before the first POST
  let response: { hash: Hex };
  try { response = await post(attempt.body); }
  catch (error) {
    if (error instanceof DelegatedDeliveryError && error.delivery === "rejected") store.clear(attempt);
    throw error;
  }
  if (!response || !/^0x[\da-fA-F]{64}$/.test(response.hash)) throw new Error("The service returned an invalid transaction hash. Recover the saved request before submitting another order.");
  store.save({ ...attempt, hash: response.hash });
  return response.hash;
}

/** Only exact canonical success or the receipt reader's authenticated revert resolves an attempt. */
export async function confirmDelegatedAttempt<T>(store: DelegatedAttemptStore, attempt: DelegatedAttempt, confirm: () => Promise<T>): Promise<T> {
  let result: T;
  try { result = await confirm(); }
  catch (error) {
    if (error instanceof FinalizedOwnerRevert) store.clear(attempt);
    throw error;
  }
  store.clear(attempt);
  return result;
}
