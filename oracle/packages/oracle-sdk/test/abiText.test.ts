import { describe, expect, test } from 'bun:test'
import { abiTextHash, canonicalAbiText, tsModule } from '../scripts/sync-abis'

describe('ABI text fingerprint portability', () => {
  const original = '[\n  {"type":"function","name":"assertMany"}\n]\n'

  test('only checkout CRLF line endings are normalized', () => {
    const windows = original.replaceAll('\n', '\r\n')
    expect(canonicalAbiText(windows)).toBe(original)
    expect(abiTextHash(windows)).toBe(abiTextHash(original))
    expect(tsModule('Example', windows)).toBe(tsModule('Example', original))
  })

  test('ABI changes and other byte changes still fail the fingerprint', () => {
    for (const changed of [
      original.replace('assertMany', 'assertAll'),
      original.replace('  {', ' {'),
      original.trimEnd(),
      `${original}\n`,
      original.replace('assertMany', 'assert\\rMany'),
      original.replace('  {', '\r  {'),
    ]) expect(abiTextHash(changed)).not.toBe(abiTextHash(original))
  })
})
