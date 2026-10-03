// Task O33.4: signing the EIP-712 PanelResult (plan §8.3). The contract accepts a 65-byte r‖s‖v signature with
// v ∈ {27, 28} and s ≤ n/2 that `ecrecover`s to the trust set's runner attestor (SigLib.isValidAttestorSig).
// Hackathon scope (ADJ-42): the attestor is a local key from the environment (ATTESTOR_PRIVATE_KEY, a testnet-only
// key, ADJ-38), not a KMS key. Every signature is checked against the contract's rules before it is returned.
import { oracleDomain, panelResultDigest, type PanelResult } from '@eros-oracle/oracle-sdk'
import { type Address, type Hex, recoverAddress, serializeSignature } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
export const HALF_N = SECP256K1_N / 2n // SigLib.HALF_N

export class SignerError extends Error {}

export type Signature = { r: Hex; s: Hex; v: 27 | 28 }

/** Signs a 32-byte digest as the attestor. */
export type DigestSigner = { address: Address; signDigest(digest: Hex): Promise<Signature> }

export function localSigner(privateKey: Hex): DigestSigner {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new SignerError('the attestor key must be 32 bytes of hex (0x…)')
  const address = privateKeyToAccount(privateKey).address
  return {
    address,
    async signDigest(digest) {
      const sig = await sign({ hash: digest, privateKey })
      const v = Number(sig.v ?? 27n + BigInt(sig.yParity ?? 0))
      if (BigInt(sig.s) > HALF_N || (v !== 27 && v !== 28)) throw new SignerError('signature is not low-s with v 27 or 28')
      const out: Signature = { r: sig.r, s: sig.s, v }
      if ((await recoverAddress({ hash: digest, signature: packSignature(out) })) !== address) throw new SignerError('signature does not recover to the attestor')
      return out
    },
  }
}

/** The attestor from ATTESTOR_PRIVATE_KEY. */
export function signerFromEnv(env: Record<string, string | undefined> = process.env): DigestSigner {
  const key = env.ATTESTOR_PRIVATE_KEY
  if (!key) throw new SignerError('set ATTESTOR_PRIVATE_KEY (the testnet attestor key, ADJ-38)')
  return localSigner(key as Hex)
}

/** The 65-byte r‖s‖v the contract takes. */
export const packSignature = (sig: Signature): Hex => serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) })

/** Signs a PanelResult for the oracle at `oracle` on `chainId`; returns the digest and the packed signature. */
export async function signPanelResult(signer: DigestSigner, chainId: number, oracle: Address, result: PanelResult): Promise<{ digest: Hex; signature: Hex }> {
  const digest = panelResultDigest(oracleDomain(chainId, oracle), result)
  return { digest, signature: packSignature(await signer.signDigest(digest)) }
}
