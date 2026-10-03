// The keeper's planners, most urgent first (plan §9.1): the resolution jobs (O31.2), then the engine follow-up
// after Final (O31.3); and the global ones: treasury disputes and skim, the hourly commitments check (O31.3).
import type { DisputeSource, GlobalPlanner, Planner } from '../types'
import { enginePlanner } from './engine'
import { resolutionPlanner } from './resolution'
import { commitmentsCheck, treasuryPlanner } from './treasury'

export { CHUNK, enginePlanner, engineVersion } from './engine'
export { FINALIZE_BATCH, finalizeManyGas, FinalizeStatus, resolutionPlanner, RState } from './resolution'
export { COMMITMENTS_EVERY_SECS, commitmentsCheck, treasuryPlanner } from './treasury'

export function planners(opts: { realEngine: boolean }): Planner[] {
  return [resolutionPlanner(opts), enginePlanner()]
}

export function globalPlanners(disputes: DisputeSource): GlobalPlanner[] {
  return [treasuryPlanner(disputes), commitmentsCheck()]
}
