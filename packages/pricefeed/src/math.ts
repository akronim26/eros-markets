export const WAD = 10n ** 18n;
export const UINT64_MAX = (1n << 64n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;
// A common scale retains fractional quantities until the approved depth boundary.
export const QUANTITY_SCALE = WAD;

export function parseDecimal(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 100 || !/^\d+(?:\.\d{1,18})?$/.test(value))
    throw new Error('BAD_DECIMAL: unsigned plain decimal with at most 18 fractional digits required');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole!) * WAD + BigInt(fraction.padEnd(18, '0'));
  if (result > UINT256_MAX) throw new Error('DECIMAL_OVERFLOW');
  return result;
}

export function priceWad(value: unknown): bigint {
  const result = parseDecimal(value);
  if (result > WAD) throw new Error('PRICE_OUT_OF_DOMAIN');
  return result;
}

export function floorLots(quantityScaled: bigint): bigint {
  if (quantityScaled < 0n) throw new Error('NEGATIVE_QUANTITY');
  return quantityScaled * 1000n / QUANTITY_SCALE;
}

export function uint(value: unknown, bits: 64 | 256): bigint {
  if (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error('BAD_INTEGER_STRING');
  const result = BigInt(value);
  if (result >= (1n << BigInt(bits))) throw new Error(`UINT${bits}_OVERFLOW`);
  return result;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new Error('BAD_UNSIGNED_DIVISION');
  return a / b + (a % b === 0n ? 0n : 1n);
}

export function decimalWad(value: bigint): string {
  const fraction = (value % WAD).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / WAD}${fraction ? `.${fraction}` : ''}`;
}

export function json(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2);
}
