import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, keccak256, type Address, type Hex } from 'viem'
import { createTraderClient, transactionData, OrderKind, toPublicManifest, publicManifestSchema, claimAvailability } from '../src/browser'

const address = (value: number) => `0x${value.toString(16).padStart(40, '0')}` as Address
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}` as Hex
const raw = { scope: 'local-only', chainId: 31337, sourceCommit: 'test', rpcUrl: 'https://private.invalid/secret',
  contracts: Object.fromEntries(['MarketRegistry', 'ResolutionOracle', 'CollateralVault', 'CollateralToken'].map((name, index) => [name,
    { address: address(index + 10), codehash: keccak256('0x6000'), deployBlock: 1, privateTransport: 'secret' }])),
  markets: [{ name: 'demo', engine: address(1), marketId: hash(1), sourceId: hash(2), listingHash: hash(3), codehash: keccak256('0x6000'), deployBlock: 1 }],
}
const manifest = toPublicManifest(raw)
const client = createTraderClient(manifest, 'demo', address(100))
const order = { kind: OrderKind.POST_ONLY, isBuy: true, reduceOnly: false, tick: 450, size: 12_000n, maxFills: 8, expiryBlock: 0 }

describe('browser-safe owner-correct trading client', () => {
  test('public identity strips private transports recursively and preserves explicit provenance', () => {
    expect(JSON.stringify(manifest)).not.toContain('secret')
    expect(manifest.manifestVersion).toBe(1)
    expect(manifest.provenance?.index).toBe('fixture')
    expect(toPublicManifest({ ...raw, sourceMode: 'polymarket', riskScenario: 'leveraged-fixture' }).provenance).toEqual({
      index: 'external', collateral: 'fixture', resolution: 'fixture', calibration: 'synthetic',
    })
    expect(() => publicManifestSchema.parse({ ...raw, chainId: 10143 })).toThrow('CHAIN_SCOPE')
  })

  test('all writes encode the selected owner, exact amounts and correct custody recipient', () => {
    const requests = [client.approve(17n), client.deposit(17n), client.allocate(17n), client.placeOrder(order),
      client.cancel(7), client.cancelAll(), client.release(17n), client.withdraw(17n), client.claim()]
    for (const request of requests) {
      const encoded = transactionData(request)
      expect(encoded.account).toBe(client.owner)
      expect(encoded.chainId).toBe(31337)
      expect(encoded.to).toBe(request.address)
      expect(decodeFunctionData({ abi: request.abi, data: encoded.data }).functionName).toBe(request.functionName)
    }
    expect(client.approve(17n).args).toEqual([client.vault, 17n])
    expect(client.allocate(17n).args).toEqual([client.market.engine, 17n, false])
    expect(client.claim().args).toEqual([client.market.engine, client.owner])
  })

  test('owner, chain, units and order bounds are enforced without computing a replacement margin rule', () => {
    expect(() => client.assertWallet(10143, client.owner)).toThrow('WRONG_WALLET_CHAIN')
    expect(() => client.assertWallet(31337, address(99))).toThrow('WRONG_WALLET_OWNER')
    expect(() => client.deposit(0n)).toThrow('POSITIVE_INTEGER')
    expect(() => client.deposit(1.5 as unknown as bigint)).toThrow('POSITIVE_INTEGER')
    for (const bad of [{ tick: 0 }, { tick: 1000 }, { size: 1n << 64n }, { maxFills: 9 }, { expiryBlock: -1 }]) {
      expect(() => client.placeOrder({ ...order, ...bad })).toThrow('INVALID_')
    }
    expect(() => createTraderClient(manifest, 'missing', client.owner)).toThrow('UNKNOWN_MARKET')
    expect(client.previewOrder(1, order).args).toEqual([1, 0, 450, 12000n, false])
    expect(client.previewOrder(1, { ...order, isBuy: false }).args[1]).toBe(1)
  })

  test('browser entry builds without Node or Bun runtime imports', async () => {
    const build = await Bun.build({ entrypoints: [fileURLToPath(new URL('../src/browser.ts', import.meta.url))], target: 'browser' })
    expect(build.success).toBe(true)
    const output = await build.outputs[0].text()
    expect(output).not.toMatch(/(?:from|require\()\s*['"]node:/)
  })

  test('claimability requires both the actual claims gate and owner escrow, even after oracle finality', () => {
    const preparing = { claimsEnabled: false, oracleFinalityAccepted: true, accountingComplete: false }
    expect(claimAvailability(preparing, 100n)).toEqual({ available: false, reason: 'CLAIMS_DISABLED' })
    const accounted = { ...preparing, accountingComplete: true }
    expect(claimAvailability(accounted, 100n).available).toBe(false)
    expect(claimAvailability({ claimsEnabled: true }, 0n)).toEqual({ available: false, reason: 'NO_CLAIM' })
    expect(claimAvailability({ claimsEnabled: true }, 100n)).toEqual({ available: true, reason: 'CLAIMABLE' })
    expect(() => claimAvailability({ claimsEnabled: true }, -1n)).toThrow('INVALID_CLAIM_ATOMS')
  })
})
