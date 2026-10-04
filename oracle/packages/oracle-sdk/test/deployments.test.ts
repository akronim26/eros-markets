// The fixture is DeployOracle's output from a dry run on a Monad testnet fork.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contractAddress, DeploymentsError, gasLimit, loadDeployments, loadGas } from '../src/deployments'

const FIXTURE = new URL('./fixtures/deployments.monad-testnet.json', import.meta.url).pathname
const raw = () => JSON.parse(readFileSync(FIXTURE, 'utf8'))
function variant(edit: (d: any) => void): string {
  const d = raw()
  edit(d)
  const p = join(mkdtempSync(join(tmpdir(), 'sdk-')), 'monad-testnet.json')
  writeFileSync(p, JSON.stringify(d))
  return p
}

describe('loadDeployments', () => {
  test('parses the testnet file DeployOracle writes', () => {
    const d = loadDeployments('monad-testnet', { path: FIXTURE, expectChainId: 10143 })
    expect(d.chainId).toBe(10143)
    expect(d.creChainSelector).toBe(2183018362218727504n)
    expect(contractAddress(d, 'ResolutionOracle')).toBe('0x837a41023CF81234f89F956C94D676918b4791c1')
    expect(d.contracts.StubMarketFactory.testnetOnly).toBe(true)
    expect(d.uma.finalFeeAtoms).toBe(1_000_000n)
    expect(d.cre.mockForwarder).toBe('0xB9F79d863261869B234c481D1f9A7af84AeAd192')
  })

  test('addresses come back checksummed whatever their case in the file', () => {
    const p = variant((d) => (d.usdc = d.usdc.toLowerCase()))
    expect(loadDeployments('monad-testnet', { path: p }).usdc).toBe('0xD5bFeBDce5c91413E41cc7B24C8402c59A344f7c')
  })

  test('a missing core contract, a bad address, another network or chain is refused', () => {
    const cases: [(d: any) => void, RegExp, object?][] = [
      [(d) => delete d.contracts.KeeperRouter, /contracts must include/],
      [(d) => (d.contracts.ResolutionOracle.address = '0x1234'), /contracts\.ResolutionOracle\.address/],
      [(d) => (d.roles.lister = undefined), /roles\.lister/],
      [(d) => (d.creChainSelector = 2183018362218727504), /creChainSelector/],
      [(d) => (d.network = 'monad-mainnet'), /network is monad-mainnet, expected monad-testnet/],
      [() => {}, /chainId 10143, expected 143/, { expectChainId: 143 }],
    ]
    for (const [edit, msg, opts] of cases) {
      expect(() => loadDeployments('monad-testnet', { path: variant(edit), ...opts })).toThrow(msg)
    }
    const bad = join(mkdtempSync(join(tmpdir(), 'sdk-')), 'monad-testnet.json')
    writeFileSync(bad, '{"network":')
    expect(() => loadDeployments('monad-testnet', { path: bad })).toThrow(DeploymentsError)
  })

  test('an unknown contract name is an error, not undefined', () => {
    const d = loadDeployments('monad-testnet', { path: FIXTURE })
    expect(() => contractAddress(d, 'MarketFactory')).toThrow(/has no MarketFactory/)
  })
})

describe('loadGas', () => {
  test('reads the measured limits; an unlisted call has no guessed limit', () => {
    const gas = loadGas()
    expect(gasLimit(gas, 'onReport')).toBe(140000n)
    expect(gasLimit(gas, 'onReportViaForwarder')).toBe(400000n)
    expect(() => gasLimit(gas, 'notACall')).toThrow(/no limit for notACall/)
  })
})
