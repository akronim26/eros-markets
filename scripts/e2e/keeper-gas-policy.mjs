/** Explicit operator ceiling; the selected measured estimate remains the fee basis. */
export function keeperGasCeiling(input) {
  if (input === undefined) return 3_000_000n;
  if (typeof input !== 'string' || !/^[1-9][0-9]*$/.test(input)) throw Error('INVALID_KEEPER_MAX_GAS');
  const value = BigInt(input);
  if (value < 21_000n || value > 30_000_000n) throw Error('INVALID_KEEPER_MAX_GAS');
  return value;
}

/** Only adjusts the in-memory operational limit; identity binding excludes this field. */
export function boundedRolloverHelper(helper, ceiling) {
  return helper && { ...helper, gasCeiling: Math.min(helper.gasCeiling, Number(ceiling)) };
}

export class KeeperGasLimitExceeded extends Error {
  constructor(gas, ceiling) {
    super('KEEPER_GAS_LIMIT_EXCEEDED');
    this.name = 'KeeperGasLimitExceeded';
    this.gas = gas;
    this.ceiling = ceiling;
  }
}

export function requireKeeperGas(gas, ceiling) {
  if (gas > ceiling) throw new KeeperGasLimitExceeded(gas, ceiling);
}

/** A refused unsigned action must not stop unrelated keeper work or clear a journal. */
export async function runKeeperAction({ run, hasPending, onLimit, rolloverCeiling }) {
  try {
    return { limited: false, result: await run() };
  } catch (error) {
    if (hasPending()) throw error;
    const refusal = error instanceof KeeperGasLimitExceeded ? error
      : rolloverCeiling !== undefined && error instanceof Error
        && error.message === 'No measured rollover batch fits the gas ceiling'
        ? new KeeperGasLimitExceeded(undefined, rolloverCeiling) : undefined;
    if (!refusal) throw error;
    await onLimit(refusal);
    return { limited: true };
  }
}
