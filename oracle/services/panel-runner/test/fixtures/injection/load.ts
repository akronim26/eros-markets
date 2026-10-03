// The injection fixtures (manifest.json) as one snapshot: item i is manifest entry i, allow-listed, HTTP 200.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Item, Snapshot } from '@eros-oracle/snapshotter'

const DIR = new URL('./', import.meta.url).pathname
export type Entry = { file: string; contentType: string }
export const manifest = (): Entry[] => JSON.parse(readFileSync(`${DIR}manifest.json`, 'utf8'))

export function fixtureItem(e: Entry): Item {
  const bytes = readFileSync(DIR + e.file)
  return {
    url: `https://fixtures.example/${e.file}`, host: 'fixtures.example', allowListed: true, fetchedAt: 1_800_000_000, httpStatus: 200,
    contentType: e.contentType, sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64'), truncated: false,
  }
}

export function fixtureSnapshot(entries: Entry[] = manifest()): Snapshot {
  return { version: 1, marketId: '0x01', takenAt: 1_800_000_000, allowList: ['fixtures.example'], items: entries.map(fixtureItem), omitted: [] }
}
