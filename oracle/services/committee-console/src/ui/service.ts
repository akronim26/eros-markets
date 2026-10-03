// Task O34.3: the review service level (plan §8.4): an alert at T_r after the market entered review, and pages at the
// L2 deadline − 2 h and at `retryOpensAt` − 2 h (after either, anyone may act: openAfterDeadline, or a permissionless
// proposal once the retry window opens).
import type { Case } from '../backend/types'

export const PAGE_BEFORE_SECS = 2n * 3600n

export type ServiceAlert = {
  kind: 'REVIEW_SERVICE_LEVEL' | 'L2_DEADLINE_SOON' | 'RETRY_OPENS_SOON'
  /** When it fires. */
  at: bigint
  /** The deadline it warns about (the service level itself for REVIEW_SERVICE_LEVEL). */
  deadline: bigint
  severity: 'alert' | 'page'
}

/** Every service-level alert of a case that is waiting for the committee, fired or not, earliest first. */
export function serviceAlerts(c: Case): ServiceAlert[] {
  if (!c.reviewable) return []
  const out: ServiceAlert[] = []
  const d = c.deadlines
  if (d.serviceLevelAt !== null) out.push({ kind: 'REVIEW_SERVICE_LEVEL', at: d.serviceLevelAt, deadline: d.serviceLevelAt, severity: 'alert' })
  if (c.state === 'Review' && d.l2DeadlineAt !== null) out.push({ kind: 'L2_DEADLINE_SOON', at: d.l2DeadlineAt - PAGE_BEFORE_SECS, deadline: d.l2DeadlineAt, severity: 'page' })
  if (d.retryOpensAt !== null) out.push({ kind: 'RETRY_OPENS_SOON', at: d.retryOpensAt - PAGE_BEFORE_SECS, deadline: d.retryOpensAt, severity: 'page' })
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** The alerts that have fired by `now` and whose deadline has not passed (one that has passed is no longer actionable by the committee alone). */
export const dueAlerts = (c: Case, now: bigint) => serviceAlerts(c).filter((a) => a.at <= now && (a.kind === 'REVIEW_SERVICE_LEVEL' || now < a.deadline))
