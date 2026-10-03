// Task O34.2: building, signing, collecting and submitting ReviewedProposals against the recorded Review state. The
// contract's own acceptance is the local-deploy test (test/fork); here each check the console makes before sending.
import { HALF_N, loadGas, oracleDomain, reviewedProposalDigest } from '@eros-oracle/oracle-sdk'
import { beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concatHex, type Hex, hashTypedData, hexToBigInt, numberToHex, recoverAddress, sliceHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { buildCase } from '../src/backend/case'
import { EvidenceStore } from '../src/backend/store'
import { type Case, RState } from '../src/backend/types'
import { type Bundle, bundleDigest, bundleJson, newBundle, parseBundle, ProposalError, typedData } from '../src/sign/bundle'
import { collect, signBundle, staleness, withSignature } from '../src/sign/collect'
import { GAS_KEY_ERC1271, submitBundle } from '../src/sign/submit'
import { FakeChain, loadRecorded, MEMBER_KEYS, RECORDED } from './fake'

const rec = loadRecorded()
const ID = rec.marketId
const [A, B, C] = MEMBER_KEYS.map((k) => privateKeyToAccount(k))
const NOTE = `0x${'4e'.repeat(32)}` as Hex
const gas = loadGas()

let chain: FakeChain
let c: Case
let b: Bundle

beforeEach(async () => {
  chain = new FakeChain(ID, rec)
  const dir = mkdtempSync(join(tmpdir(), 'sign-'))
  cpSync(RECORDED, dir, { recursive: true })
  c = await buildCase(ID, chain, new EvidenceStore(dir))
  b = newBundle(c, { chainId: chain.chainId, oracle: chain.oracle, outcome: 'NO', evidenceHash: c.evidence!.evidenceHash, evidenceURI: c.evidence!.evidenceURI, noteHash: NOTE, now: chain.t })
})

/** The high-s twin of a valid signature: (r, n − s, v flipped), which ecrecover accepts and SigLib refuses. */
function highS(sig: Hex): Hex {
  const n = HALF_N * 2n + 1n
  const s = hexToBigInt(sliceHex(sig, 32, 64))
  const v = Number(hexToBigInt(sliceHex(sig, 64, 65)))
  return concatHex([sliceHex(sig, 0, 32), numberToHex(n - s, { size: 32 }), numberToHex(v === 27 ? 28 : 27, { size: 1 })])
}

describe('the bundle', () => {
  test('the proposal mirrors the case: attempt, mask, early, trust set; deadline now + 6 h', () => {
    const p = b.proposal
    expect(p).toMatchObject({ marketId: ID.toLowerCase(), outcome: 2, evidenceHash: c.evidence!.evidenceHash, noteHash: NOTE, attempt: 0, rejectedMask: 0, early: false, trustSetId: c.trustSetId })
    expect(p.deadline).toBe(chain.t + 6n * 3600n)
    expect(bundleDigest(b)).toBe(reviewedProposalDigest(oracleDomain(chain.chainId, chain.oracle), p))
  })

  test('the eth_signTypedData_v4 payload hashes to the digest the contract verifies', () => {
    const td = typedData(b)
    const { EIP712Domain: _d, ...types } = td.types
    expect(hashTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: { ...td.message, deadline: BigInt(td.message.deadline) } })).toBe(bundleDigest(b))
    expect(JSON.parse(JSON.stringify(td)).message.deadline).toBe(String(b.proposal.deadline))
  })

  test('JSON round trip; a changed evidence URI is refused', () => {
    expect(parseBundle(bundleJson(b))).toEqual(b)
    const tampered = JSON.parse(bundleJson(b))
    tampered.evidenceURI = 'eros-snapshot:0x' + '00'.repeat(32)
    expect(() => parseBundle(JSON.stringify(tampered))).toThrow(ProposalError)
  })

  test('refused: a case the committee cannot propose on, a rejected outcome, an evidence URI the contract refuses', () => {
    const args = { chainId: chain.chainId, oracle: chain.oracle, outcome: 'NO' as const, evidenceHash: c.evidence!.evidenceHash, evidenceURI: c.evidence!.evidenceURI, noteHash: NOTE, now: chain.t }
    expect(() => newBundle({ ...c, reviewable: false }, args)).toThrow(ProposalError)
    expect(() => newBundle({ ...c, allowed: ['YES', 'INVALID'] }, args)).toThrow(/rejected/)
    expect(() => newBundle(c, { ...args, evidenceURI: '' })).toThrow(ProposalError)
    expect(() => newBundle(c, { ...args, evidenceURI: 'x'.repeat(257) })).toThrow(ProposalError)
    expect(newBundle(c, { ...args, evidenceURI: 'x'.repeat(256) }).evidenceURI.length).toBe(256)
  })

  test('early: the deadline stops before T and the early TTL', () => {
    const early = { ...c, early: true, tau: chain.t + 3600n, deadlines: { ...c.deadlines, earlyExpiresAt: chain.t + 1800n } }
    const e = newBundle(early, { chainId: chain.chainId, oracle: chain.oracle, outcome: 'YES', evidenceHash: c.evidence!.evidenceHash, evidenceURI: c.evidence!.evidenceURI, noteHash: NOTE, now: chain.t })
    expect(e.proposal.early).toBe(true)
    expect(e.proposal.deadline).toBe(chain.t + 1799n)
  })
})

describe('collecting signatures', () => {
  test('two members: valid, sorted ascending by signer, threshold met', async () => {
    const s = await signBundle(await signBundle(b, B), A)
    for (const x of s.signatures) expect(await recoverAddress({ hash: bundleDigest(b), signature: x.signature })).toBe(x.signer)
    const col = await collect(s, chain)
    expect(col.checks.every((x) => x.ok && x.kind === 'EOA')).toBe(true)
    expect(col.enough).toBe(true)
    const sorted = [A.address, B.address].sort((x, y) => (hexToBigInt(x) < hexToBigInt(y) ? -1 : 1))
    expect(col.valid.map((x) => x.signer)).toEqual(sorted)
  })

  test('one signature is not enough', async () => {
    const col = await collect(await signBundle(b, A), chain)
    expect(col.valid.length).toBe(1)
    expect(col.enough).toBe(false)
  })

  test('refused: a non-member, a revoked member, a high-s twin, v 0/1, a signature over another proposal', async () => {
    const stranger = privateKeyToAccount(generatePrivateKey())
    let s = await signBundle(b, stranger)
    expect((await collect(s, chain)).checks[0]).toMatchObject({ ok: false, reason: expect.stringContaining('not a member') })

    const com = await chain.committee(c.trustSetId)
    com.revoked[com.members.indexOf(C.address)] = true
    s = await signBundle(b, C)
    expect((await collect(s, chain)).checks[0]).toMatchObject({ ok: false, reason: 'member revoked' })

    const good = (await signBundle(b, A)).signatures[0].signature
    for (const bad of [highS(good), concatHex([sliceHex(good, 0, 64), numberToHex(hexToBigInt(sliceHex(good, 64, 65)) - 27n, { size: 1 })])]) {
      const col = await collect(withSignature(b, { signer: A.address, signature: bad }), chain)
      expect(col.checks[0].ok).toBe(false)
      expect(col.valid).toEqual([])
    }
    const other = (await signBundle({ ...b, proposal: { ...b.proposal, outcome: 1 } }, A)).signatures[0].signature
    expect((await collect(withSignature(b, { signer: A.address, signature: other }), chain)).checks[0].ok).toBe(false)
  })

  test('a member signing again replaces their signature', async () => {
    const s = await signBundle(await signBundle(b, A), A)
    expect(s.signatures.length).toBe(1)
  })

  test('a contract member (Safe) counts through ERC-1271, but such a bundle is not sent: its gas is not measured', async () => {
    chain.contracts.set(C.address.toLowerCase(), (digest, sig) => digest === bundleDigest(b) && sig === '0x5afe')
    const s = withSignature(await signBundle(b, A), { signer: C.address, signature: '0x5afe' })
    const col = await collect(s, chain)
    expect(col.checks.find((x) => x.signer === C.address)).toMatchObject({ kind: 'ERC1271', ok: true })
    expect(col.enough).toBe(true)
    expect(col.erc1271).toBe(true)
    expect(gas.calls[GAS_KEY_ERC1271]).toBeUndefined()
    await expect(submitBundle(s, chain, gas)).rejects.toThrow(`no gas.json limit for ${GAS_KEY_ERC1271}`)
    expect(chain.sent).toEqual([])
    // a wrong ERC-1271 signature does not count
    const bad = withSignature(s, { signer: C.address, signature: '0xbad0' })
    expect((await collect(bad, chain)).checks.find((x) => x.signer === C.address)!.ok).toBe(false)
  })
})

describe('submission', () => {
  test('eth_call, then the threshold of signatures, ascending, with gas.json’s limit', async () => {
    const s = await signBundle(await signBundle(await signBundle(b, A), B), C)
    expect(await submitBundle(s, chain, gas)).toMatch(/^0x/)
    expect(chain.simulated.length).toBe(1)
    const sent = chain.sent[0]
    expect(sent.gas).toBe(610_000n)
    expect(sent.sigs.length).toBe(2) // threshold 2 of the 3 valid
    expect(hexToBigInt(sent.sigs[0].signer) < hexToBigInt(sent.sigs[1].signer)).toBe(true)
    expect(sent.uri).toBe(b.evidenceURI)
    expect(sent.p).toEqual(b.proposal)
  })

  test('nothing is sent below the threshold, when the eth_call reverts, or when the bundle is stale', async () => {
    await expect(submitBundle(await signBundle(b, A), chain, gas)).rejects.toThrow(/threshold 2/)
    const s = await signBundle(await signBundle(b, A), B)
    chain.revert = 'BadSignature()'
    await expect(submitBundle(s, chain, gas)).rejects.toThrow('BadSignature')
    chain.revert = null
    chain.res.attempts = 1
    await expect(submitBundle(s, chain, gas)).rejects.toThrow(/attempt 0, the market is at 1/)
    chain.res.attempts = 0
    chain.t = b.proposal.deadline + 1n
    await expect(submitBundle(s, chain, gas)).rejects.toThrow(/expired/)
    expect(chain.sent).toEqual([])
  })

  test('staleness names each payload check the contract would fail', async () => {
    expect(await staleness(b, chain)).toEqual([])
    chain.res.rejectedMask = 1 << 2
    chain.res.state = RState.EarlyReview
    const out = await staleness(b, chain)
    expect(out).toContain('the market is in EarlyReview but the proposal is not early')
    expect(out).toContain('rejectedMask 0, the market has 4')
    expect(out).toContain('the outcome was rejected by the venue')
    chain.res.state = RState.Proposed
    expect((await staleness(b, chain)).some((x) => x.startsWith('market is in state 7'))).toBe(true)
  })
})
