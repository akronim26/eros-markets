import { encodeAbiParameters, getAddress, keccak256, stringToHex, type Hex } from 'viem';
import { record } from '../book.js';
import { uint, WAD } from '../math.js';
import { PRICING_POLICY } from '../rules.js';

/**
 * Native (Kuru) INDEX source rules, NM-F02. A distinct domain from EROS_POLYMARKET_INDEX_RULES_V1:
 * the hash commits to the venue binding (Kuru book, YES/NO tokens, collateral, native vault), the
 * YES orientation, the depth/spread rule, the shared impact pricing policy and the block-timestamp
 * and failure policies. The engine address is not included; the signed envelope binds it.
 */
export const NATIVE_RULES_DOMAIN = keccak256(stringToHex('EROS_KURU_NATIVE_INDEX_RULES_V1'));
export const NATIVE_TIMESTAMP_POLICY = 'kuru-pinned-block-timestamp-seconds-hash-rechecked-advance-only-v1';
export const NATIVE_FAILURE_POLICY = 'fresh-thin-crossed-wide-book-invalid-depth-transport-failure-withheld-v1';
export const NATIVE_DEPTH_POLICY = 'kuru-resting-orders-only-amm-vault-excluded-v1';

export const NATIVE_RULES_FIELDS = [['schemaVersion', 'uint64'], ['venue', 'bytes32'], ['chainId', 'uint256'],
  ['marketId', 'bytes32'], ['sourceId', 'bytes32'], ['kuruOrderBook', 'address'], ['yesToken', 'address'],
  ['noToken', 'address'], ['collateral', 'address'], ['outcomeVault', 'address'], ['outcomeLabel', 'bytes32'],
  ['erosRulesHash', 'bytes32'], ['scheduledT', 'uint64'], ['depthNLots', 'uint256'], ['maxSpreadWad', 'uint256'],
  ['pricingPolicy', 'bytes32'], ['depthPolicy', 'bytes32'], ['timestampPolicy', 'bytes32'],
  ['failurePolicy', 'bytes32']] as const;

type Field = typeof NATIVE_RULES_FIELDS[number][0];
export type NativeRulesManifest = Record<Field, string> & { schemaVersion: '1'; venue: 'kuru'; outcomeLabel: 'YES' };
const TEXT_FIELDS: Field[] = ['venue', 'outcomeLabel', 'pricingPolicy', 'depthPolicy', 'timestampPolicy', 'failurePolicy'];
const FIXED: Partial<Record<Field, string>> = { schemaVersion: '1', venue: 'kuru', outcomeLabel: 'YES', pricingPolicy: PRICING_POLICY,
  depthPolicy: NATIVE_DEPTH_POLICY, timestampPolicy: NATIVE_TIMESTAMP_POLICY, failurePolicy: NATIVE_FAILURE_POLICY };

export function parseNativeRules(value: unknown): NativeRulesManifest {
  const raw = record(value);
  if (Object.keys(raw).length !== NATIVE_RULES_FIELDS.length || Object.keys(raw).some(k => !NATIVE_RULES_FIELDS.some(([n]) => n === k)))
    throw new Error('BAD_RULES_FIELDS');
  for (const [name, fixed] of Object.entries(FIXED)) if (raw[name] !== fixed) throw new Error('UNSUPPORTED_RULES_POLICY');
  const out: Record<string, string> = {};
  for (const [name, type] of NATIVE_RULES_FIELDS) {
    const v = raw[name];
    if (typeof v !== 'string') throw new Error('BAD_RULES_FIELD');
    if (TEXT_FIELDS.includes(name)) out[name] = v;
    else if (type === 'address') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0{40}$/.test(v)) throw new Error('BAD_RULES_ADDRESS');
      out[name] = getAddress(v);
    } else if (type === 'bytes32') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(v) || /^0x0{64}$/.test(v)) throw new Error('BAD_RULES_HASH');
      out[name] = v.toLowerCase();
    } else { uint(v, type === 'uint64' ? 64 : 256); out[name] = v; }
  }
  if (BigInt(out.depthNLots!) === 0n || BigInt(out.maxSpreadWad!) > WAD) throw new Error('BAD_RULES_DEPTH');
  if (new Set([out.yesToken, out.noToken, out.collateral, out.kuruOrderBook, out.outcomeVault]).size !== 5)
    throw new Error('DUPLICATE_RULES_ADDRESS');
  return out as NativeRulesManifest;
}

export function encodeNativeRules(value: NativeRulesManifest): Hex {
  const m = parseNativeRules(value);
  const values = NATIVE_RULES_FIELDS.map(([name, type]) => TEXT_FIELDS.includes(name) ? keccak256(stringToHex(m[name]))
    : type === 'address' || type === 'bytes32' ? m[name] as Hex : BigInt(m[name]));
  return encodeAbiParameters([{ type: 'bytes32' }, ...NATIVE_RULES_FIELDS.map(([, type]) => ({ type }))], [NATIVE_RULES_DOMAIN, ...values]);
}

export function nativeRulesHash(value: NativeRulesManifest): Hex {
  return keccak256(encodeNativeRules(value));
}
