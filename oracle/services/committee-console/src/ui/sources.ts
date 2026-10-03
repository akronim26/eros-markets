// Task O34.3 (ADJ-22): a reviewer adds sources. That is a new snapshot through the snapshotter (plan §8.2, spec §6.6):
// the market's Layer 1 endpoint and allow-list as for the panel, the panel's pages (from its snapshot when the store
// has it) and the added pages, all fetched fresh. It gets its own hash and URI and is kept in the store.
import { type Snapshot, type SnapshotRequest } from '@eros-oracle/snapshotter'
import type { Hex } from 'viem'
import type { EvidenceStore } from '../backend/store'
import type { CaseChain } from '../backend/types'

export type TakeSnapshot = (req: SnapshotRequest) => Promise<Snapshot>

export async function resnapshot(
  id: Hex,
  chain: CaseChain,
  store: EvidenceStore,
  take: TakeSnapshot,
  a: { previous?: Hex; added: string[] },
): Promise<{ evidenceHash: Hex; evidenceURI: string; snapshot: Snapshot }> {
  const l1Url = await chain.l1Url(id)
  const prev = a.previous ? store.snapshot(a.previous) : null
  const pages = [...new Set([...(prev?.items ?? []).map((i) => i.url).filter((u) => u !== l1Url), ...a.added])]
  const snapshot = await take({ marketId: id, l1Url, allowList: await chain.allowList(id), pages })
  return { ...store.putSnapshot(snapshot), snapshot }
}
