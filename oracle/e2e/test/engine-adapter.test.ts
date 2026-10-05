import { describe, expect, test } from 'bun:test'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { EngineAdapter, parseEngineConfig, type EngineReader, type Settlement } from '../src/engine-adapter'

const engine = '0x1111111111111111111111111111111111111111' as Address
const code = '0x1234' as Hex
const hash = toHex(1, { size: 32 })
const raw = { kind: 'book-risk', chainId: 31337, claimsTimeoutMs: 2000,
  markets: [{ tag: 'e1', marketId: hash, engine, codehash: keccak256(code), listingHash: hash, deployBlock: '100' }] }

function setup() {
  const state: Settlement = { finalOutcome: 2, oracleFinalityAccepted: true, claimsEnabled: false, recoveryRequired: false }
  const client: EngineReader = { getChainId: async () => 31337, getCode: async () => code,
    readContract: async call => call.functionName === 'listingHash' ? hash : { ...state } }
  return { state, client, adapter: new EngineAdapter(parseEngineConfig(raw), client, []) }
}

describe('explicit oracle engine adapter', () => {
  test('requires concrete chain and unique market pins instead of stub listing defaults', () => {
    expect(() => parseEngineConfig({ kind: 'book-risk' })).toThrow()
    expect(() => parseEngineConfig({ ...raw, chainId: 143 })).toThrow()
    expect(() => parseEngineConfig({ ...raw, markets: [...raw.markets, ...raw.markets] })).toThrow('Duplicate')
    expect(() => parseEngineConfig({ ...raw, claimsTimeoutMs: 0 })).toThrow('timeout')
    const { adapter } = setup()
    expect(adapter.pinForTag('e1').deployBlock).toBe(100n)
    expect(() => adapter.pinForTag('e2')).toThrow('Prelist and pin')
  })
  test('real monitor uses requestReduceOnly while the legacy stub adapter keeps its own selector', async () => {
    const { adapter, client } = setup()
    expect(await adapter.restriction(engine, hash)).toMatchObject({ functionName: 'requestReduceOnly', args: [hash] })
    const stub = new EngineAdapter({ kind: 'stub' }, client, [])
    expect(await stub.restriction(engine, hash)).toMatchObject({ functionName: 'setMonitorRestricted', args: [true] })
  })
  test('wrong chain, runtime, listing or unregistered engine cannot reach a monitor call', async () => {
    for (const change of [
      (client: EngineReader) => { client.getChainId = async () => 10143 },
      (client: EngineReader) => { client.getCode = async () => '0xabcd' },
      (client: EngineReader) => { client.readContract = async () => toHex(9, { size: 32 }) },
    ]) {
      const { adapter, client } = setup()
      change(client)
      await expect(adapter.restriction(engine, hash)).rejects.toThrow('mismatch')
    }
    await expect(setup().adapter.restriction('0x2222222222222222222222222222222222222222', hash)).rejects.toThrow('not enrolled')
  })
  test('oracle Final waits for keeper preparation, including multiple bounded pages', async () => {
    const { adapter, state } = setup()
    let clock = 0
    let pages = 0
    const result = await adapter.waitForClaims(engine, { now: () => clock, sleep: async ms => {
      clock += ms
      if (++pages === 2) state.claimsEnabled = true
    } })
    expect(pages).toBe(2)
    expect(result.claimsEnabled).toBeTrue()
  })
  test('recovery, stalled preparation and changed runtime never count as settled', async () => {
    const value = setup()
    value.state.recoveryRequired = true
    await expect(value.adapter.waitForClaims(engine)).rejects.toThrow('recovery')
    const stalled = setup()
    let clock = 0
    await expect(stalled.adapter.waitForClaims(engine, { now: () => clock, sleep: async ms => { clock += ms } })).rejects.toThrow('timeout')
    const changed = setup()
    await expect(changed.adapter.waitForClaims(engine, { now: () => 0, sleep: async () => {
      changed.client.getCode = async () => '0x5678'
    } })).rejects.toThrow('identity mismatch')
  })
})
