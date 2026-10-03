// The keeper's planners, most urgent first (plan §9.1). O31.2: the resolution jobs; O31.3 adds the engine
// follow-up and treasury jobs.
import type { Planner } from '../types'
import { resolutionPlanner } from './resolution'

export { FINALIZE_BATCH, finalizeManyGas, FinalizeStatus, resolutionPlanner, RState } from './resolution'

export function planners(opts: { realEngine: boolean }): Planner[] {
  return [resolutionPlanner(opts)]
}
