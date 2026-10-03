// Sources without an outcome do not count. The watchdog disputes only when every answering source contradicts the
// proposal; a split goes to a human.
import type { OutcomeName, Signal, Verdict } from './types'

export function combine(proposed: OutcomeName, signals: Signal[]): Verdict {
  const answered = signals.filter((s) => s.outcome !== null)
  const support = answered.filter((s) => s.outcome === proposed)
  const against = answered.filter((s) => s.outcome !== proposed)
  const list = (xs: Signal[]) => xs.map((s) => `${s.source} ${s.outcome}`).join(', ')
  if (answered.length === 0) return { kind: 'UNSURE', signals, reason: 'no source gave an outcome' }
  if (against.length === 0) return { kind: 'AGREE', signals, reason: `${list(support)} support ${proposed}` }
  if (support.length === 0) return { kind: 'CONTRADICT', signals, reason: `${list(against)} against the proposed ${proposed}` }
  return { kind: 'UNSURE', signals, reason: `sources disagree: ${list(support)} for, ${list(against)} against ${proposed}` }
}
