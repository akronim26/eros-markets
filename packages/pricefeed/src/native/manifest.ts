import { getAddress, type Address, type Hex } from 'viem';
import { record } from '../book.js';
import { uint } from '../math.js';

/**
 * Native market deployment manifest (NM-D01), schema version 1: the public record written by
 * oracle/script/native/DeployNativeMarket.s.sol. Public identities only; no keys or private config.
 * `parseNativeDeployment` is strict: exact field set, checksummed addresses, nonzero 32-byte hashes,
 * distinct contract addresses and integer fields. Chain verification is `scripts/native-verify.ts`.
 */
export type NativeDeployment = {
  chainId: bigint; registry: Address; marketId: Hex; collateral: Address; erosRulesHash: Hex;
  scheduledT: bigint; issuanceCap: bigint; kuruRouter: Address; outcomeVault: Address;
  yesToken: Address; noToken: Address; yesBook: Address; noBook: Address; vaultCodehash: Hex;
};

const ADDRESS_FIELDS = ['registry', 'collateral', 'kuruRouter', 'outcomeVault', 'yesToken', 'noToken', 'yesBook', 'noBook'] as const;
const HASH_FIELDS = ['marketId', 'erosRulesHash', 'vaultCodehash'] as const;
const INT_FIELDS = ['chainId', 'scheduledT', 'issuanceCap'] as const;
export const NATIVE_DEPLOYMENT_FIELDS = [...ADDRESS_FIELDS, ...HASH_FIELDS, ...INT_FIELDS] as const;

export function parseNativeDeployment(value: unknown): NativeDeployment {
  const raw = record(value);
  const keys = Object.keys(raw);
  if (keys.length !== NATIVE_DEPLOYMENT_FIELDS.length || keys.some(k => !(NATIVE_DEPLOYMENT_FIELDS as readonly string[]).includes(k)))
    throw new Error('BAD_NATIVE_DEPLOYMENT_FIELDS');
  const out: Record<string, unknown> = {};
  for (const k of ADDRESS_FIELDS) {
    const v = raw[k];
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0{40}$/.test(v)) throw new Error(`BAD_NATIVE_ADDRESS_${k}`);
    out[k] = getAddress(v);
  }
  for (const k of HASH_FIELDS) {
    const v = raw[k];
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v) || /^0x0{64}$/i.test(v)) throw new Error(`BAD_NATIVE_HASH_${k}`);
    out[k] = v.toLowerCase();
  }
  for (const k of INT_FIELDS) {
    const v = raw[k];
    if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`BAD_NATIVE_INTEGER_${k}`);
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error(`BAD_NATIVE_INTEGER_${k}`);
    out[k] = uint(String(v), k === 'chainId' || k === 'issuanceCap' ? 256 : 64);
  }
  if (out.chainId === 0n || out.issuanceCap === 0n) throw new Error('BAD_NATIVE_DEPLOYMENT_VALUES');
  const addresses = ADDRESS_FIELDS.map(k => out[k] as string);
  if (new Set(addresses).size !== addresses.length) throw new Error('DUPLICATE_NATIVE_ADDRESS');
  return out as NativeDeployment;
}
