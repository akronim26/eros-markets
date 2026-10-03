// Task O33.4: PanelResult signing with the local attestor key (ADJ-42). The signed cases are pinned in
// vectors/panel-sig.json, which the Foundry test test/vectors/PanelSigVectors.t.sol checks with the oracle's own
// SigLib.hashPanelResult and isValidAttestorSig. Regenerate with WRITE_PANEL_SIG_VECTORS=1 bun test test/signer.test.ts.
import { type PanelResult } from '@eros-oracle/oracle-sdk'
import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { type Hex, keccak256, recoverAddress, stringToBytes } from 'viem'
import { HALF_N, localSigner, SignerError, signerFromEnv, signPanelResult } from '../src/signer'

const KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' // anvil account #9: a public test key
const ATTESTOR = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720'
const CHAIN_ID = 10143
const ORACLE = '0x837a41023CF81234f89F956C94D676918b4791c1'
const VECTORS = new URL('../../../vectors/panel-sig.json', import.meta.url).pathname

const result = (over: Partial<PanelResult> = {}): PanelResult => ({
  marketId: keccak256(stringToBytes('market-1')),
  phase: 2,
  attempt: 0,
  labels: [1, 1, 1],
  calibratedBps: [9500, 9400, 9300],
  evidenceHash: keccak256(stringToBytes('snapshot')),
  evidenceURIHash: keccak256(stringToBytes('eros-snapshot:0x01')),
  gateHash: keccak256(stringToBytes('gate')),
  flags: 0,
  trustSetId: 1,
  deadline: 1_800_000_000n,
  ...over,
})

describe('local signer', () => {
  test('from ATTESTOR_PRIVATE_KEY; a missing or malformed key is refused', () => {
    expect(signerFromEnv({ ATTESTOR_PRIVATE_KEY: KEY }).address).toBe(ATTESTOR)
    expect(() => signerFromEnv({})).toThrow('set ATTESTOR_PRIVATE_KEY')
    expect(() => localSigner('0x1234' as Hex)).toThrow(SignerError)
  })

  test('low s and v ∈ {27, 28} recovering the attestor; both recovery ids occur (64 digests)', async () => {
    const s = localSigner(KEY)
    const vs = new Set<number>()
    for (let i = 0; i < 64; i++) {
      const digest = keccak256(stringToBytes(`digest ${i}`))
      const sig = await s.signDigest(digest)
      expect(BigInt(sig.s) <= HALF_N).toBe(true)
      vs.add(sig.v)
      expect(await recoverAddress({ hash: digest, signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } })).toBe(ATTESTOR)
    }
    expect([...vs].sort()).toEqual([27, 28])
  })
})

const CASES: [string, Partial<PanelResult>][] = [
  ['post-T unanimous YES', {}],
  ['early phase, mixed labels', { phase: 1, labels: [1, 2, 0], calibratedBps: [4900, 4900, 0] }],
  ['injection flag, NOT_YET majority', { labels: [4, 4, 1], calibratedBps: [4900, 4900, 4900], flags: 1, attempt: 2, trustSetId: 7 }],
  ['maximum fields', { attempt: 255, labels: [3, 3, 3], calibratedBps: [65535, 9900, 100], flags: 255, trustSetId: 4_294_967_295, deadline: 18_446_744_073_709_551_615n }],
]

async function vectors() {
  const cases = []
  for (const [name, over] of CASES) {
    const r = result(over)
    const { digest, signature } = await signPanelResult(localSigner(KEY), CHAIN_ID, ORACLE, r)
    cases.push({ name, ...r, labels: [...r.labels], calibratedBps: [...r.calibratedBps], deadline: r.deadline.toString(), digest, signature })
  }
  return { _note: 'O33.4: PanelResults signed by the panel runner (local attestor key); checked by test/vectors/PanelSigVectors.t.sol', chainId: CHAIN_ID, oracle: ORACLE, attestor: ATTESTOR, cases }
}

describe('vectors/panel-sig.json', () => {
  test('the committed vectors are what the signer produces now', async () => {
    const text = JSON.stringify(await vectors(), null, 2) + '\n'
    if (process.env.WRITE_PANEL_SIG_VECTORS) writeFileSync(VECTORS, text)
    expect(readFileSync(VECTORS, 'utf8')).toBe(text)
  })
})
