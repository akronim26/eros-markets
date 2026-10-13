import type { Hex } from 'viem'

export type StateChange = { id: Hex; to: number }

/** Commit the cursor only after every requested range succeeds. A failed poll may replay, never lose, logs. */
export function stateChangeReader(start: bigint, head: () => Promise<bigint>, read: (from: bigint, to: bigint) => Promise<StateChange[]>) {
  let next = start
  return async (): Promise<StateChange[]> => {
    const end = await head()
    const out: StateChange[] = []
    let cursor = next
    while (cursor <= end) {
      const to = cursor + 99n < end ? cursor + 99n : end
      out.push(...await read(cursor, to))
      cursor = to + 1n
    }
    next = cursor
    return out
  }
}
