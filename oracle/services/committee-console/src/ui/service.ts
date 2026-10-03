// Review service level: an alert at T_r after entering review, and pages 2 h before the L2 deadline and before
// `retryOpensAt`, after which anyone may act.
import type { Case } from '../backend/types'

export const PAGE_BEFORE_SECS = 2n * 3600n

export type ServiceAlert = {
  kind: 'REVIEW_SERVICE_LEVEL' | 'L2_DEADLINE_SOON' | 'RETRY_OPENS_SOON'
  at: bigint
  /** The deadline it warns about. */
  deadline: bigint
  severity: 'alert' | 'page'
}

/** Every alert of a waiting case, fired or not, earliest first. */
export function serviceAlerts(c: Case): ServiceAlert[] {
  if (!c.reviewable) return []
  const out: ServiceAlert[] = []
  const d = c.deadlines
  if (d.serviceLevelAt !== null) out.push({ kind: 'REVIEW_SERVICE_LEVEL', at: d.serviceLevelAt, deadline: d.serviceLevelAt, severity: 'alert' })
  if (c.state === 'Review' && d.l2DeadlineAt !== null) out.push({ kind: 'L2_DEADLINE_SOON', at: d.l2DeadlineAt - PAGE_BEFORE_SECS, deadline: d.l2DeadlineAt, severity: 'page' })
  if (d.retryOpensAt !== null) out.push({ kind: 'RETRY_OPENS_SOON', at: d.retryOpensAt - PAGE_BEFORE_SECS, deadline: d.retryOpensAt, severity: 'page' })
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** Fired by `now` and before their deadline; past the deadline the committee is no longer the only one who can act. */
export const dueAlerts = (c: Case, now: bigint) => serviceAlerts(c).filter((a) => a.at <= now && (a.kind === 'REVIEW_SERVICE_LEVEL' || now < a.deadline))
