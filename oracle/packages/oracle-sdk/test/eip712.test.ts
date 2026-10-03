// Task O30.2: the EIP-712 mirror reproduces vectors/eip712.json (written from SigLib and the oracle's views):
// type strings, typehashes, domain separator, P1 and R1 digests, and the signed examples byte for byte.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, concatHex, keccak256, numberToHex, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ORACLE_ROOT } from '../src/abi/sources'
import {
  HALF_N,
  type PanelResult,
  type ReviewedProposal,
  domainSeparator,
  hashText,
  oracleDomain,
  panelResultDigest,
  panelResultTypes,
  recoverSigner,
  reviewedProposalDigest,
  reviewedProposalTypes,
  signPanelResult,
  signReviewedProposal,
  sortCommitteeSigs,
} from '../src/eip712'

const V = JSON.parse(readFileSync(join(ORACLE_ROOT, 'vectors', 'eip712.json'), 'utf8'))
const domain = oracleDomain(V.domain.chainId, V.domain.verifyingContract)

const p1: PanelResult = {
  marketId: hashText(V.P1.preimages.marketId),
  phase: V.P1.phase,
  attempt: V.P1.attempt,
  labels: V.P1.labels,
  calibratedBps: V.P1.calibratedBps,
  evidenceHash: hashText(V.P1.preimages.evidenceHash),
  evidenceURIHash: hashText(V.P1.preimages.evidenceURIHash),
  gateHash: hashText(V.P1.preimages.gateHash),
  flags: V.P1.flags,
  trustSetId: V.P1.trustSetId,
  deadline: BigInt(V.P1.deadline),
}

const r1: ReviewedProposal = {
  marketId: hashText(V.R1.preimages.marketId),
  outcome: V.R1.outcome,
  evidenceHash: hashText(V.R1.preimages.evidenceHash),
  evidenceURIHash: hashText(V.R1.preimages.evidenceURIHash),
  noteHash: hashText(V.R1.preimages.noteHash),
  attempt: V.R1.attempt,
  rejectedMask: V.R1.rejectedMask,
  early: V.R1.early,
  trustSetId: V.R1.trustSetId,
  deadline: BigInt(V.R1.deadline),
}

describe('types and domain', () => {
  test('type strings and typehashes are the Solidity ones', () => {
    for (const [name, types] of [['PanelResult', panelResultTypes], ['ReviewedProposal', reviewedProposalTypes]] as const) {
      // No nested structs, so the encoded type is the field list.
      const fields = (types as Record<string, readonly { name: string; type: string }[]>)[name]
      const s = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`
      expect(s).toBe(V.typeString[name])
      expect(keccak256(toHex(s))).toBe(V.typehash[name])
    }
  })

  test('domain separator matches, and moves with the chain and the contract', () => {
    expect(domain.name).toBe(V.domain.name)
    expect(domain.version).toBe(V.domain.version)
    expect(domainSeparator(domain)).toBe(V.domainSeparator)
    expect(domainSeparator(oracleDomain(143, V.domain.verifyingContract))).not.toBe(V.domainSeparator)
    expect(domainSeparator(oracleDomain(10143, '0x00000000000000000000000000000000000000BB'))).not.toBe(V.domainSeparator)
  })
})

describe('digests', () => {
  test('P1 and R1 digests match the vectors', () => {
    expect(panelResultDigest(domain, p1)).toBe(V.P1.digest)
    expect(reviewedProposalDigest(domain, r1)).toBe(V.R1.digest)
  })

  test('every field is bound: changing any one changes the digest', () => {
    const pEdits: Partial<PanelResult>[] = [
      { marketId: hashText('market-2') }, { phase: 1 }, { attempt: 1 }, { labels: [1, 1, 2] }, { calibratedBps: [9500, 9400, 9301] },
      { evidenceHash: hashText('x') }, { evidenceURIHash: hashText('x') }, { gateHash: hashText('x') }, { flags: 1 },
      { trustSetId: 2 }, { deadline: 1800000001n },
    ]
    for (const e of pEdits) expect(panelResultDigest(domain, { ...p1, ...e }), JSON.stringify(e, (_, v) => String(v))).not.toBe(V.P1.digest)
    const rEdits: Partial<ReviewedProposal>[] = [
      { marketId: hashText('market-2') }, { outcome: 2 }, { evidenceHash: hashText('x') }, { evidenceURIHash: hashText('x') },
      { noteHash: hashText('x') }, { attempt: 2 }, { rejectedMask: 0 }, { early: true }, { trustSetId: 2 }, { deadline: 1800000001n },
    ]
    for (const e of rEdits) expect(reviewedProposalDigest(domain, { ...r1, ...e }), JSON.stringify(e, (_, v) => String(v))).not.toBe(V.R1.digest)
  })
})

describe('signatures', () => {
  test('the attestor signature over P1 is the vector, byte for byte, and recovers to the signer', async () => {
    const acct = privateKeyToAccount(V.signed.P1.privateKey)
    expect(acct.address).toBe(V.signed.P1.signer)
    const sig = await signPanelResult(acct, domain, p1)
    expect(sig).toBe(V.signed.P1.signature)
    expect(await recoverSigner(V.P1.digest, sig)).toBe(V.signed.P1.signer)
  })

  test('the two committee signatures over R1 are the vectors, in ascending signer order', async () => {
    const R = V.signed.R1
    const sigs = await Promise.all(
      [...R.privateKeys].reverse().map(async (k: Hex) => {
        const a = privateKeyToAccount(k)
        return { signer: a.address, signature: await signReviewedProposal(a, domain, r1) }
      }),
    )
    const sorted = sortCommitteeSigs(sigs)
    expect(sorted.map((s) => s.signer)).toEqual(R.signers)
    expect(sorted.map((s) => s.signature)).toEqual(R.signatures)
    for (const s of sorted) expect(await recoverSigner(V.R1.digest, s.signature)).toBe(s.signer)
    expect(() => sortCommitteeSigs([sigs[0], sigs[0]])).toThrow(/duplicate committee signer/)
  })

  test('a signature SigLib refuses is refused here: wrong length, bad v, high s', async () => {
    const sig: Hex = V.signed.P1.signature
    expect(await recoverSigner(V.P1.digest, sig.slice(0, -2) as Hex)).toBeNull()
    expect(await recoverSigner(V.P1.digest, (sig.slice(0, -2) + '01') as Hex)).toBeNull()
    // The malleable twin: s' = n - s, v flipped. ecrecover accepts it; SigLib does not.
    const n = 2n * HALF_N + 1n
    const s = BigInt('0x' + sig.slice(66, 130))
    const v = parseInt(sig.slice(130), 16)
    const twin = concatHex([`0x${sig.slice(2, 66)}`, numberToHex(n - s, { size: 32 }), numberToHex(v === 27 ? 28 : 27, { size: 1 })])
    expect(await recoverSigner(V.P1.digest, twin)).toBeNull()
  })
})
