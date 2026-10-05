// Planners, most urgent first.
import type { DisputeSource, GlobalPlanner, Planner } from '../types'
import { enginePlanner } from './engine'
import { resolutionPlanner } from './resolution'
import { commitmentsCheck, treasuryPlanner } from './treasury'

export { CHUNK, enginePlanner, engineVersion } from './engine'
export { FINALIZE_BATCH, finalizeManyGas, FinalizeStatus, resolutionPlanner, RState } from './resolution'
export { COMMITMENTS_EVERY_SECS, commitmentsCheck, treasuryPlanner } from './treasury'

export function planners(): Planner[] {
  return [resolutionPlanner(), enginePlanner()]
}

export function globalPlanners(disputes: DisputeSource): GlobalPlanner[] {
  return [treasuryPlanner(disputes), commitmentsCheck()]
}
