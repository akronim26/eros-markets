// The workflow's constants must equal the contracts'. An ABI carries enums only as uint8, so the RState order is read
// from OracleTypes.sol.
import { expect, test } from 'bun:test'
import { type AbiEvent, toEventSelector } from 'viem'
import { RESOLUTION_REQUESTED, STATE_L1_PENDING } from './main'

const ORACLE_ROOT = new URL('../../', import.meta.url)
const abi = (await Bun.file(new URL('abi/IResolutionOracle.json', ORACLE_ROOT)).json()) as any[]
const types = await Bun.file(new URL('src/types/OracleTypes.sol', ORACLE_ROOT)).text()

test('RESOLUTION_REQUESTED is the ABI snapshot event topic, 0xa3af…3a13 (C.7)', () => {
  const event = abi.find((x) => x.type === 'event' && x.name === 'ResolutionRequested') as AbiEvent
  expect(event).toBeDefined()
  expect(event.inputs.map((i) => i.type)).toEqual(['bytes32', 'uint64', 'uint32'])
  expect(event.inputs[0].indexed).toBe(true) // marketId is topics[1]
  expect(event.inputs[1].indexed || event.inputs[2].indexed).toBe(false) // requestedAt, requestCount in data
  expect(toEventSelector(event)).toBe('0xa3af2aef1d2a3c4b347e31fedf3782adb4c12febbd7961c698f034aed1a93a13')
  expect(RESOLUTION_REQUESTED).toBe(toEventSelector(event))
})

test('STATE_L1_PENDING is RState.L1Pending, 3', () => {
  const body = /enum RState \{([^}]*)\}/.exec(types)?.[1]
  expect(body).toBeDefined()
  const members = body!
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
    .filter((m) => m.length > 0)
  expect(members.indexOf('L1Pending')).toBe(3)
  expect(STATE_L1_PENDING).toBe(members.indexOf('L1Pending'))
  // getL1Job returns the state as its first output, a uint8
  const getL1Job = abi.find((x) => x.type === 'function' && x.name === 'getL1Job')
  expect(getL1Job.outputs[0].name).toBe('state')
  expect(getL1Job.outputs[0].type).toBe('uint8')
})
