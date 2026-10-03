// Task O34.3: the reviewer console (plan §8.4), as a CLI (§13.1 cut: "partial (as a CLI)"; ADJ-43). One reviewer takes a
// case from reading to a submitted proposal without leaving it:
//   case <id>                         the case (rules first; evidence; panel as reference; deadlines and alerts)
//   snapshot <id> [url ...]           a new snapshot with the added sources (ADJ-22); the case then shows it
//   propose <id> <YES|NO|INVALID> <note>   writes the note (noteHash), builds the ReviewedProposal and signs it
//   sign <bundle> <YES|NO|INVALID>    another member signs, naming the outcome they chose themselves
//   typed-data <bundle>               the eth_signTypedData_v4 payload for a wallet (hardware wallet, Safe)
//   add-sig <bundle> <signer> <sig>   a signature made in a wallet
//   status <bundle>                   signatures checked as the contract will, threshold, staleness
//   submit <bundle>                   eth_call, then send (anyone)
//   alerts                            service-level alerts across markets waiting for the committee
// Per-market state (the reviewer's current snapshot) is kept in <dataDir>/cases/<id>.json; bundles in
// <dataDir>/proposals/<digest>.json.
import type { GasTable } from '@eros-oracle/oracle-sdk'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import type { LocalAccount } from 'viem/accounts'
import { buildCase, type EvidenceChoice } from '../backend/case'
import { makeNote } from '../backend/note'
import type { EvidenceStore } from '../backend/store'
import { type Case, type CaseChain, CHOICES, type Choice, OUTCOME_NAME, RState } from '../backend/types'
import { type Bundle, bundleDigest, bundleJson, newBundle, parseBundle, ProposalError, typedData } from '../sign/bundle'
import { collect, signBundle, staleness, withSignature } from '../sign/collect'
import { submitBundle } from '../sign/submit'
import { renderCase } from './render'
import { dueAlerts } from './service'
import { resnapshot, type TakeSnapshot } from './sources'

export type ConsoleDeps = {
  chain: CaseChain
  store: EvidenceStore
  gas: GasTable
  takeSnapshot: TakeSnapshot
  /** The reviewer's own key (a committee member); not needed to read, check or submit. */
  account?: LocalAccount
  dataDir: string
  /** Unix seconds for the note's writtenAt (default the clock). */
  clock?: () => number
}

type Session = EvidenceChoice & { addedSources: string[] }

export class CommitteeConsole {
  constructor(private readonly d: ConsoleDeps) {}

  private sessionPath(id: Hex) {
    return join(this.d.dataDir, 'cases', `${id.toLowerCase()}.json`)
  }
  private session(id: Hex): Session | null {
    const p = this.sessionPath(id)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  }

  /** The case with the reviewer's own snapshot when they took one. */
  async case(id: Hex): Promise<Case> {
    const s = this.session(id)
    return buildCase(id, this.d.chain, this.d.store, s ? { evidenceHash: s.evidenceHash, evidenceURI: s.evidenceURI } : undefined)
  }

  async show(id: Hex): Promise<string> {
    return renderCase(await this.case(id), await this.d.chain.now())
  }

  /** A new snapshot: the panel's sources (or the reviewer's last snapshot's) plus `urls`. */
  async snapshot(id: Hex, urls: string[]): Promise<Session> {
    const c = await this.case(id)
    const prev = this.session(id)
    const r = await resnapshot(id, this.d.chain, this.d.store, this.d.takeSnapshot, { previous: c.evidence?.available ? c.evidence.evidenceHash : undefined, added: urls })
    const s: Session = { evidenceHash: r.evidenceHash, evidenceURI: r.evidenceURI, addedSources: [...new Set([...(prev?.addedSources ?? []), ...urls])] }
    mkdirSync(join(this.d.dataDir, 'cases'), { recursive: true })
    writeFileSync(this.sessionPath(id), JSON.stringify(s, null, 2) + '\n')
    return s
  }

  /**
   * The reviewer's decision: the note is written and hashed, the proposal built on the case's snapshot (which the
   * reviewer must have been able to read) and signed with the reviewer's key. Returns the bundle's path.
   */
  async propose(id: Hex, outcome: Choice, noteText: string): Promise<{ path: string; bundle: Bundle }> {
    const account = this.requireAccount()
    const c = await this.case(id)
    this.requireMember(c, account.address)
    if (!c.evidence) throw new ProposalError('no evidence recorded for this market: take a snapshot first')
    if (!c.evidence.available) throw new ProposalError(`snapshot ${c.evidence.evidenceHash} is not in the local store: take a snapshot first`)
    const note = makeNote({
      marketId: id,
      outcome,
      evidenceHash: c.evidence.evidenceHash,
      addedSources: this.session(id)?.addedSources ?? [],
      reviewer: account.address,
      text: noteText,
      writtenAt: this.d.clock?.() ?? Math.floor(Date.now() / 1000),
    })
    const noteHash = this.d.store.putNote(note)
    const b = newBundle(c, {
      chainId: this.d.chain.chainId,
      oracle: this.d.chain.oracle,
      outcome,
      evidenceHash: c.evidence.evidenceHash,
      evidenceURI: c.evidence.evidenceURI,
      noteHash,
      now: await this.d.chain.now(),
    })
    const signed = await signBundle(b, account)
    return { path: this.save(signed), bundle: signed }
  }

  /** Another member signs, after choosing the same outcome on their own. */
  async sign(path: string, outcome: Choice): Promise<Bundle> {
    const account = this.requireAccount()
    const b = this.load(path)
    const chosen = OUTCOME_NAME[b.proposal.outcome]
    if (chosen !== outcome) throw new ProposalError(`the proposal is ${chosen}; you chose ${outcome}: not signed`)
    const c = await this.case(b.proposal.marketId)
    this.requireMember(c, account.address)
    const stale = await staleness(b, this.d.chain)
    if (stale.length > 0) throw new ProposalError(`not current: ${stale.join('; ')}`)
    const signed = await signBundle(b, account)
    this.save(signed, path)
    return signed
  }

  addSignature(path: string, signer: Address, signature: Hex): Bundle {
    const b = withSignature(this.load(path), { signer, signature })
    this.save(b, path)
    return b
  }

  typedData(path: string) {
    return typedData(this.load(path))
  }

  async status(path: string) {
    const b = this.load(path)
    const [c, stale] = await Promise.all([collect(b, this.d.chain), staleness(b, this.d.chain)])
    return { digest: bundleDigest(b), outcome: OUTCOME_NAME[b.proposal.outcome], ...c, stale }
  }

  async submit(path: string): Promise<Hex> {
    return submitBundle(this.load(path), this.d.chain, this.d.gas)
  }

  /** Due service-level alerts of every market waiting for the committee. */
  async alerts() {
    const now = await this.d.chain.now()
    const out: { marketId: Hex; kind: string; severity: string; at: bigint; deadline: bigint }[] = []
    for (const id of await this.d.chain.markets()) {
      const r = await this.d.chain.resolution(id)
      if (r.state !== RState.Review && r.state !== RState.Open && r.state !== RState.EarlyReview) continue
      for (const a of dueAlerts(await this.case(id), now)) out.push({ marketId: id, ...a })
    }
    return out
  }

  private requireAccount(): LocalAccount {
    if (!this.d.account) throw new ProposalError('set COMMITTEE_PRIVATE_KEY (your committee key) to sign')
    return this.d.account
  }

  private requireMember(c: Case, a: Address) {
    const i = c.committee.members.findIndex((m) => m.toLowerCase() === a.toLowerCase())
    if (i < 0) throw new ProposalError(`${a} is not a member of trust set ${c.trustSetId}`)
    if (c.committee.revoked[i]) throw new ProposalError(`${a} is revoked in trust set ${c.trustSetId}`)
  }

  private load(path: string): Bundle {
    return parseBundle(readFileSync(path, 'utf8'))
  }

  private save(b: Bundle, path?: string): string {
    const p = path ?? join(this.d.dataDir, 'proposals', `${bundleDigest(b)}.json`)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, bundleJson(b))
    return p
  }
}

export const parseChoice = (s: string): Choice => {
  const u = s.toUpperCase()
  if (!(CHOICES as readonly string[]).includes(u)) throw new ProposalError(`choose YES, NO or INVALID (from the rules), not ${s}`)
  return u as Choice
}
