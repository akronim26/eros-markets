// Task O30.1: the ABI copy cannot drift. Three links are checked: the Solidity sources against the snapshot
// (`forge inspect`, byte for byte; the output is identical on Foundry 1.5.1 and 1.8.3), the snapshot against
// oracle/abi/SHA256SUMS, and the SDK's src/abi modules against the snapshot (stamped hash and parsed content).
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as abis from '../src/abi'
import { ABI_DIR, SOURCES } from '../src/abi/sources'
import { forgeInspect, tsModule } from '../scripts/sync-abis'

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const sums = new Map(
  readFileSync(join(ABI_DIR, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => {
    const [hash, file] = l.split(/\s+/)
    return [file, hash] as const
  }),
)

describe('snapshot', () => {
  test('SHA256SUMS lists exactly the JSON files, and every hash matches', () => {
    const files = readdirSync(ABI_DIR).filter((f) => f.endsWith('.json')).sort()
    expect([...sums.keys()].sort()).toEqual(files)
    for (const f of files) expect(sha256(readFileSync(join(ABI_DIR, f)))).toBe(sums.get(f)!)
  })

  test('every SDK source has a snapshot file, and every snapshot file a source', () => {
    expect(SOURCES.map((s) => `${s.name}.json`).sort()).toEqual([...sums.keys()].sort())
  })

  test('the snapshot is what forge inspect gives for the current sources', () => {
    for (const { name, source } of SOURCES) {
      const fresh = forgeInspect(source, name)
      expect(sha256(fresh), `${name} drifted from ${source}: run bun run sync-abis`).toBe(sums.get(`${name}.json`)!)
    }
  }, 600_000)
})

describe('SDK copy', () => {
  test('each module is the generated form of its snapshot file and carries its hash', () => {
    for (const { name } of SOURCES) {
      const json = readFileSync(join(ABI_DIR, `${name}.json`), 'utf8')
      const mod = readFileSync(new URL(`../src/abi/${name}.ts`, import.meta.url), 'utf8')
      expect(mod).toBe(tsModule(name, json))
      expect(mod).toContain(`(sha256 ${sums.get(`${name}.json`)})`)
      expect((abis as Record<string, unknown>)[`${name}Abi`]).toEqual(JSON.parse(json))
    }
  })

  test('the oracle ABI carries the calls the services make', () => {
    const fns = new Set(abis.ResolutionOracleAbi.filter((x) => x.type === 'function').map((x) => x.name))
    for (const f of ['submitPanelResult', 'submitReviewedProposal', 'haltScheduled', 'requestResolution', 'assertProposal',
      'finalizeMarket', 'voidMarket', 'hashPanelResult', 'hashReviewedProposal', 'getResolution', 'getL1Job']) {
      expect(fns.has(f), f).toBe(true)
    }
  })

  test('a changed snapshot is detected', () => {
    const json = readFileSync(join(ABI_DIR, 'IKeeperRouter.json'), 'utf8')
    const tampered = json.replace('"assertMany"', '"assertAll"')
    expect(sha256(tampered)).not.toBe(sums.get('IKeeperRouter.json')!)
    expect(tsModule('IKeeperRouter', tampered)).not.toBe(readFileSync(new URL('../src/abi/IKeeperRouter.ts', import.meta.url), 'utf8'))
  })
})
