// Injection scan: the detector on raw bytes and the classifier on prompt text. Any finding, or a classifier failure,
// sets FLAG_INJECTION_SUSPECTED, which makes the contract route the result to the committee.
import type { Snapshot } from '@eros-oracle/snapshotter'
import { evidenceTexts, type PinnedPrompt } from '../prompts'
import { CLASSIFIER_THRESHOLD, ClassifierUnavailable, classify, type ClassifierDeps } from './classifier'
import { detect, type Finding as DetectorFinding } from './detector'

export * from './classifier'
export * from './detector'

/** OracleConst.FLAG_INJECTION_SUSPECTED. */
export const FLAG_INJECTION_SUSPECTED = 1

export type Finding = DetectorFinding | { item: number; rule: 'CLASSIFIER'; detail: string } | { item: number; rule: 'CLASSIFIER_UNAVAILABLE'; detail: string }

export type Scan = { flags: number; findings: Finding[]; scores: (number | null)[] }

export async function scanSnapshot(snapshot: Snapshot, prompt: Pick<PinnedPrompt, 'itemChars' | 'evidenceChars'>, deps: ClassifierDeps = {}): Promise<Scan> {
  const texts = evidenceTexts(snapshot, prompt)
  const findings: Finding[] = []
  const scores: (number | null)[] = []
  for (const [i, item] of snapshot.items.entries()) {
    findings.push(...detect(item, i))
    const text = texts[i].text
    if (text === null || text === '') {
      scores.push(null)
      continue
    }
    try {
      const s = await classify(text, deps)
      scores.push(s)
      if (s >= CLASSIFIER_THRESHOLD) findings.push({ item: i, rule: 'CLASSIFIER', detail: `attack probability ${s}` })
    } catch (e) {
      if (!(e instanceof ClassifierUnavailable)) throw e
      scores.push(null)
      findings.push({ item: i, rule: 'CLASSIFIER_UNAVAILABLE', detail: e.message })
    }
  }
  return { flags: findings.length > 0 ? FLAG_INJECTION_SUSPECTED : 0, findings, scores }
}
