// Task O33.1: the three-model panel (plan §8.3). Three families from three different providers, each pinned as
// "provider:model-id@version". The calls are independent: each model gets only the prompt and the snapshot's
// items, runs concurrently, and never sees another's output (no cross-talk, no debate).
import { type ModelCall, parseModel } from '@eros-oracle/oracle-sdk'
import type { Item } from '@eros-oracle/snapshotter'
import { askModel, type ClientDeps, type ModelOutcome } from './client'

export class PanelConfigError extends Error {}

/** Exactly three models, from three different providers, in the order of the market's `ai.modelIdHashes`. */
export function checkPanel(models: readonly string[]): void {
  if (models.length !== 3) throw new PanelConfigError(`a panel has 3 models, got ${models.length}`)
  const providers = models.map((m) => parseModel(m).provider)
  if (new Set(providers).size !== 3) throw new PanelConfigError(`the 3 models must come from 3 different providers, got ${providers.join(', ')}`)
}

export async function askPanel(models: readonly string[], call: ModelCall, items: readonly Item[], deps: ClientDeps = {}): Promise<ModelOutcome[]> {
  checkPanel(models)
  return Promise.all(models.map((m) => askModel(m, { system: call.system, user: call.user }, items, deps)))
}
