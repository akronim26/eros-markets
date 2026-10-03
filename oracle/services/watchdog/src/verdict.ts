// Task O35.1: one rule turns the watchdog's signals into a verdict on a proposal (plan §9.2). A source that gives no
// outcome (not final, an error, undetermined, low confidence) does not count either way. The watchdog disputes only when
// every source that answered supports another outcome; when they split, a human decides.
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
