// In-memory CaseChain loaded from test/fixtures/recorded-review (written by the fork test with RECORD=1).
import type { ReviewedProposal } from '@eros-oracle/oracle-sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Address, getAddress, type Hex } from 'viem'
import type { CaseChain, Committee, CoreView, PanelEvent, ResolutionView, Sig } from '../src/backend/types'

export const RECORDED = fileURLToPath(new URL('./fixtures/recorded-review/', import.meta.url))

/** Anvil's public test keys #6-#8, the fork test's committee. */
export const MEMBER_KEYS = [
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
] as const satisfies readonly Hex[]

export type Recorded = {
  chainId: number
  oracle: Address
  marketId: Hex
  now: string
  resolution: Record<string, string | number>
  core: Record<string, string | boolean>
  text: { question: string; rules: string }
  allowList: string[]
  l1Url: string | null
  activeTrustSetId: number
  committee: { members: Address[]; threshold: number; revoked: boolean[] }
  lastPanelResult: Record<string, unknown>
  enteredReview: string
}

export const loadRecorded = (): Recorded => JSON.parse(readFileSync(join(RECORDED, 'chain.json'), 'utf8'))

const big = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, keys.includes(k) ? BigInt(v as string) : v]))

export class FakeChain implements CaseChain {
  chainId: number
  oracle: Address
  t: bigint
  res: ResolutionView
  coreView: CoreView
  text_: { question: string; rules: string }
  allow: string[]
  url: string | undefined
  active: number
  committees = new Map<number, Committee>()
  panel: PanelEvent | null
  entered = new Map<number, bigint>()
  contracts = new Map<string, (digest: Hex, sig: Hex) => boolean>()
  simulated: { id: Hex; p: ReviewedProposal; uri: string; sigs: readonly Sig[] }[] = []
  sent: { id: Hex; p: ReviewedProposal; uri: string; sigs: readonly Sig[]; gas: bigint }[] = []
  revert: string | null = null

  constructor(readonly id: Hex, r: Recorded) {
    this.chainId = r.chainId
    this.oracle = getAddress(r.oracle)
    this.t = BigInt(r.now)
    this.res = big(r.resolution, ['haltedAt', 'voidDeadline', 'l2StartedAt', 'retryOpensAt', 'earlyStartedAt']) as ResolutionView
    this.coreView = big(r.core, ['tau', 'l2DeadlineSecs', 'earlyTtlSecs']) as CoreView
    this.text_ = r.text
    this.allow = r.allowList
    this.url = r.l1Url ?? undefined
    this.active = r.activeTrustSetId
    this.committees.set(this.res.trustSetId, { threshold: r.committee.threshold, members: r.committee.members.map((m) => getAddress(m)), revoked: [...r.committee.revoked] })
    this.committees.set(r.activeTrustSetId, this.committees.get(this.res.trustSetId)!)
    this.panel = big(r.lastPanelResult, ['at']) as PanelEvent
    this.entered.set(5, BigInt(r.enteredReview))
  }

  async now() {
    return this.t
  }
  async resolution() {
    return { ...this.res }
  }
  async core() {
    return { ...this.coreView }
  }
  async text() {
    return this.text_
  }
  async allowList() {
    return this.allow
  }
  async l1Url() {
    return this.url
  }
  async activeTrustSetId() {
    return this.active
  }
  async committee(setId: number) {
    const c = this.committees.get(setId)
    if (!c) throw new Error(`no trust set ${setId}`)
    return c
  }
  async lastPanelResult() {
    return this.panel
  }
  async enteredAt(_id: Hex, state: number) {
    return this.entered.get(state) ?? null
  }
  async markets() {
    return [this.id]
  }
  async isContract(a: Address) {
    return this.contracts.has(a.toLowerCase())
  }
  async isValidSignature(signer: Address, digest: Hex, sig: Hex) {
    return this.contracts.get(signer.toLowerCase())?.(digest, sig) ?? false
  }
  async simulateReviewed(id: Hex, p: ReviewedProposal, uri: string, sigs: readonly Sig[]) {
    this.simulated.push({ id, p, uri, sigs })
    if (this.revert) throw new Error(this.revert)
  }
  async sendReviewed(id: Hex, p: ReviewedProposal, uri: string, sigs: readonly Sig[], gas: bigint) {
    this.sent.push({ id, p, uri, sigs, gas })
    return `0x${'ab'.repeat(32)}` as Hex
  }
}
