// Signs PanelResults with a local attestor key (a KMS key is out of hackathon scope, ADJ-42). Every signature is
// checked against SigLib's rules (65 bytes, v 27/28, low s) before it is returned.
import { oracleDomain, panelResultDigest, type PanelResult } from '@eros-oracle/oracle-sdk'
import { type Address, type Hex, recoverAddress, serializeSignature } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
export const HALF_N = SECP256K1_N / 2n // SigLib.HALF_N

export class SignerError extends Error {}

export type Signature = { r: Hex; s: Hex; v: 27 | 28 }

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

export function signerFromEnv(env: Record<string, string | undefined> = process.env): DigestSigner {
  const key = env.ATTESTOR_PRIVATE_KEY
  if (!key) throw new SignerError('set ATTESTOR_PRIVATE_KEY (the testnet attestor key, ADJ-38)')
  return localSigner(key as Hex)
}

/** 65-byte r‖s‖v. */
export const packSignature = (sig: Signature): Hex => serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) })

export async function signPanelResult(signer: DigestSigner, chainId: number, oracle: Address, result: PanelResult): Promise<{ digest: Hex; signature: Hex }> {
  const digest = panelResultDigest(oracleDomain(chainId, oracle), result)
  return { digest, signature: packSignature(await signer.signDigest(digest)) }
}
