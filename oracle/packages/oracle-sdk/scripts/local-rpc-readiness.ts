import type { Hex } from 'viem'

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function requiredDataUnavailable(error: unknown) {
  const seen = new Set<unknown>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const value = error as { details?: unknown; message?: unknown; cause?: unknown }
    if (value.details === 'Required data unavailable' || value.message === 'Required data unavailable') return true
    error = value.cause
  }
  return false
}

/** Retry only Anvil's known transient read-data error, never a revert or a broadcast. */
export async function retryLocalRead<T>(read: () => Promise<T>, sleep = pause, attempts = 20): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read() } catch (error) {
      if (!requiredDataUnavailable(error) || attempt + 1 >= attempts) throw error
      await sleep(200)
    }
  }
}

type FinalityClient = {
  getBlock(args: { blockTag: 'finalized'; blockNumber?: never } | { blockNumber: bigint; blockTag?: never }): Promise<{ number: bigint | null; hash: Hex | null }>
}

export async function waitForLocalFinality(client: FinalityClient, receipt: { blockNumber: bigint; blockHash: Hex }, sleep = pause, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const final = await retryLocalRead(() => client.getBlock({ blockTag: 'finalized' }), sleep)
    if (final.number !== null && final.number >= receipt.blockNumber) {
      const canonical = await retryLocalRead(() => client.getBlock({ blockNumber: receipt.blockNumber }), sleep)
      if (canonical.hash !== receipt.blockHash) throw new Error('SDK_RECEIPT_REORGED')
      return
    }
    if (attempt + 1 < attempts) await sleep(200)
  }
  throw new Error('SDK_FINALITY_TIMEOUT')
}
