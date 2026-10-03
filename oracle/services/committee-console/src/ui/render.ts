// Task O34.3: the case as the reviewer reads it. The rules come first and in full: the reviewer chooses YES, NO or
// INVALID from the rules alone (plan §8.4); the panel's labels and the candidate follow as reference.
import type { Case } from '../backend/types'
import { dueAlerts, serviceAlerts } from './service'

const ITEM_TEXT_CHARS = 2000
const iso = (t: bigint | null) => (t === null ? '-' : new Date(Number(t) * 1000).toISOString().replace('.000Z', 'Z'))

export function renderCase(c: Case, now: bigint): string {
  const L: string[] = []
  L.push(`Market ${c.marketId}`, `State ${c.state}${c.early ? ' (early: a proposal halts the market at once)' : ''}${c.reviewable ? '' : ' — not open to the committee'}`, '')
  L.push('RULES (decide from these alone)', c.rules, '', `QUESTION ${c.question}`, `T ${iso(c.tau)}`, '')
  L.push(`Allowed outcomes: ${c.allowed.join(', ')}${c.rejectedMask ? ` (rejectedMask ${c.rejectedMask})` : ''}`)
  L.push(`Attempt ${c.attempt} · trust set ${c.trustSetId} · threshold ${c.committee.threshold} of ${c.committee.members.length}`, '')
  const d = c.deadlines
  L.push('DEADLINES', `  in review since   ${iso(d.reviewSince)}`, `  service level T_r ${iso(d.serviceLevelAt)}`, `  L2 deadline       ${iso(d.l2DeadlineAt)}`, `  retry opens       ${iso(d.retryOpensAt)}`, `  early TTL ends    ${iso(d.earlyExpiresAt)}`, `  void deadline     ${iso(d.voidDeadline)}`)
  for (const a of dueAlerts(c, now)) L.push(`  ! ${a.kind} (${a.severity}) since ${iso(a.at)}`)
  const next = serviceAlerts(c).find((a) => a.at > now)
  if (next) L.push(`  next alert ${next.kind} at ${iso(next.at)}`)
  L.push('')
  if (!c.evidence) L.push('EVIDENCE none recorded')
  else {
    L.push(`EVIDENCE ${c.evidence.evidenceURI}`)
    if (!c.evidence.available) L.push('  not in the local store: take a snapshot (`snapshot <marketId> [url ...]`) to read the sources')
    for (const it of c.evidence.items) {
      L.push(`  [${it.index}] ${it.allowListed ? 'allow-listed' : 'context'} ${it.url} · HTTP ${it.httpStatus}${it.error ? ` ${it.error}` : ''} · ${it.contentType || '-'} · fetched ${iso(BigInt(it.fetchedAt))}${it.truncated ? ' · truncated' : ''}`)
      if (it.text !== null) L.push(...it.text.slice(0, ITEM_TEXT_CHARS).split('\n').map((x) => `      ${x}`), ...(it.text.length > ITEM_TEXT_CHARS ? ['      …'] : []))
    }
  }
  L.push('')
  if (!c.panel) L.push('PANEL no result recorded')
  else {
    const p = c.panel
    L.push(`PANEL (reference only) routed to ${p.routedTo} at ${iso(p.at)}${p.injectionSuspected ? ' · INJECTION SUSPECTED' : p.injectionSuspected === null ? ' · flags unknown (no run record)' : ''}`)
    p.labels.forEach((l, i) => {
      const m = p.models?.[i]
      L.push(`  ${m?.model ?? `model ${i}`}: ${l} · ĉ ${p.chat[i].toFixed(4)}${m && m.confidence !== null ? ` · raw ${m.confidence}` : ''}${m?.cited.length ? ` · cites ${m.cited.join(', ')}` : ''}${m?.abstainReason ? ` · ${m.abstainReason}` : ''}`)
      if (m?.rationale) L.push(`      ${m.rationale}`)
    })
    L.push(`  candidate (display only): P(YES) ${p.candidate.probabilityYes.toFixed(4)} · log-odds ${p.candidate.logOdds.toFixed(4)} · n_eff ${p.candidate.nEff}`)
  }
  return L.join('\n')
}
