// Assembles a committee case: rules, the snapshot as the panel saw it, the panel's answers, the outcomes still allowed
// and the deadlines. The snapshot comes from the local store, checked against its hash.
import { candidate } from '@eros-oracle/panel-runner'
import { promptText } from '@eros-oracle/snapshotter'
import type { Hex } from 'viem'
import { EvidenceStore, hashFromURI } from './store'
import {
  type Case,
  type CaseChain,
  type CaseItem,
  type Choice,
  CHOICES,
  LABEL_NAME,
  OUTCOME_CODE,
  RState,
  STATE_NAME,
} from './types'

/** Review service level T_r (placeholder value). */
export const T_R_SECS = 2n * 3600n

/** A reviewer's re-snapshot when given, else the panel's. */
export type EvidenceChoice = { evidenceHash: Hex; evidenceURI: string }

export async function buildCase(id: Hex, chain: CaseChain, store: EvidenceStore, evidence?: EvidenceChoice): Promise<Case> {
  const [r, core, text, panelEv, now] = await Promise.all([
    chain.resolution(id),
    chain.core(id),
    chain.text(id),
    chain.lastPanelResult(id),
    chain.now(),
  ])
  const early = r.state === RState.EarlyReview
  const earlyExpiresAt = r.earlyStartedAt !== 0n ? r.earlyStartedAt + core.earlyTtlSecs : null
  const reviewable =
    r.state === RState.Review || r.state === RState.Open || (early && now < core.tau && earlyExpiresAt !== null && now < earlyExpiresAt)
  const trustSetId = early ? await chain.activeTrustSetId() : r.trustSetId
  const committee = await chain.committee(trustSetId)
  const allowed = CHOICES.filter((c: Choice) => (r.rejectedMask & (1 << OUTCOME_CODE[c])) === 0)

  const ev = evidence ?? (panelEv ? { evidenceHash: panelEv.evidenceHash, evidenceURI: panelEv.evidenceURI } : null)
  let evidenceView: Case['evidence'] = null
  if (ev) {
    const named = hashFromURI(ev.evidenceURI)
    const snap = named === ev.evidenceHash.toLowerCase() ? store.snapshot(ev.evidenceHash) : null
    const items: CaseItem[] = (snap?.items ?? []).map((it, index) => ({
      index,
      url: it.url,
      host: it.host,
      allowListed: it.allowListed,
      httpStatus: it.httpStatus,
      contentType: it.contentType,
      fetchedAt: it.fetchedAt,
      truncated: it.truncated,
      ...(it.error ? { error: it.error } : {}),
      text: promptText(it),
    }))
    evidenceView = { evidenceHash: ev.evidenceHash, evidenceURI: ev.evidenceURI, available: snap !== null, items }
  }

  let panel: Case['panel'] = null
  if (panelEv) {
    const record = store.panelRecord(panelEv.evidenceHash)
    const labels = panelEv.labels.map((l) => LABEL_NAME[l] ?? `UNKNOWN(${l})`)
    panel = {
      phase: panelEv.phase,
      labels,
      calibratedBps: panelEv.calibratedBps,
      chat: panelEv.calibratedBps.map((b) => b / 10_000),
      // PanelResultAccepted does not carry the flags, so they come from the runner's record if stored.
      flags: record ? record.flags : null,
      injectionSuspected: record ? record.flags !== 0 : null,
      routedTo: STATE_NAME[panelEv.routedTo] ?? String(panelEv.routedTo),
      at: panelEv.at,
      models: record
        ? record.outcomes.map((o) => ({
            model: o.model,
            label: o.label,
            confidence: o.confidence,
            cited: o.cited,
            rationale: o.rationale,
            ...(o.abstainReason ? { abstainReason: o.abstainReason } : {}),
          }))
        : null,
      // from the signed labels and ĉ, not the record
      candidate: candidate(labels.map((label) => ({ label })) as never, panelEv.calibratedBps),
    }
  }

  const reviewSince = await chain.enteredAt(id, early ? RState.EarlyReview : RState.Review)
  const halted = r.l2StartedAt !== 0n
  return {
    marketId: id,
    state: STATE_NAME[r.state] ?? String(r.state),
    reviewable,
    early,
    question: text.question,
    rules: text.rules,
    tau: core.tau,
    attempt: r.attempts,
    rejectedMask: r.rejectedMask,
    allowed,
    trustSetId,
    committee,
    evidence: evidenceView,
    panel,
    deadlines: {
      reviewSince,
      serviceLevelAt: reviewSince !== null ? reviewSince + T_R_SECS : null,
      l2DeadlineAt: halted ? r.l2StartedAt + core.l2DeadlineSecs : null,
      retryOpensAt: r.retryOpensAt !== 0n ? r.retryOpensAt : null,
      earlyExpiresAt: early ? earlyExpiresAt : null,
      voidDeadline: r.voidDeadline !== 0n ? r.voidDeadline : null,
    },
  }
}
