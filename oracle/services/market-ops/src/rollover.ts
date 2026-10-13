/** Permissionless accounting only. Owner liquidity/quoting belongs to a separate operator. */
export const ROLLOVER_PAGE_SIZE = 32

export type RolloverState = {
  timestamp: bigint
  scheduledT: bigint
  halted: boolean
  epochId: bigint
  epochEnd: bigint
  work: number
  cursor: bigint
  count: bigint
}

export type RolloverAction = 'beginRollover' | 'rollPage' | 'finishRollover'

export function nextRollover(state: RolloverState): RolloverAction | null {
  if (!Number.isInteger(state.work) || state.work < 0 || state.work > 3 || state.epochId < 0n
      || state.epochEnd < 0n || state.cursor < 0n || state.count < 0n || state.count > 1024n
      || state.cursor > state.count) throw new Error('Invalid rollover snapshot')
  // Before activation no accounting epoch exists; other sweeps and halt belong to the keeper.
  if (state.halted || state.timestamp >= state.scheduledT || state.epochId === 0n) return null
  if (state.work === 0) return state.timestamp >= state.epochEnd ? 'beginRollover' : null
  if (state.work !== 1) return null
  return state.cursor < state.count ? 'rollPage' : 'finishRollover'
}

export function sameRolloverStep(left: RolloverState, right: RolloverState): boolean {
  return nextRollover(left) === nextRollover(right) && left.epochId === right.epochId
    && left.epochEnd === right.epochEnd && left.work === right.work
    && left.cursor === right.cursor && left.count === right.count
}
