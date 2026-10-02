// Task O22.2: `oracle-cli list` writes a pack for a sample market and the pack passes createMarket (rules 1-6,
// then the commitment, the factory handshake and the store) in the Foundry dry-run. Expected values are built
// here independently: marketId and dryRunHash with viem, the claim text by token substitution (as O10.3 did),
// the pack schema from listings/example/pack.json (the one ListMarket was dry-run with in O19.4).
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, keccak256, toBytes } from 'viem'
import { list, ListError } from '../src/list'
import { ForgeError, ORACLE_ROOT } from '../src/forge'

const FIX = new URL('./fixtures/', import.meta.url).pathname
const SAMPLE = join(FIX, 'sample-listing.json')
const FINAL = join(FIX, 'reference-final.json')
const NOW = 1_800_000_000n
const ORACLE = '0x00000000000000000000000000000000000000aa'
const PROVIDERS = ['api.example-sports.com', 'stats.example-data.org']
const ZERO32 = `0x${'00'.repeat(32)}`
const FORGE = 120_000 // forge compiles on the first run

const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'))
const tmp = () => mkdtempSync(join(tmpdir(), 'oracle-cli-'))
/** A variant of the sample input, written to a temp file. */
function variant(edit: (l: any) => void): string {
  const l = structuredClone(sample)
  edit(l)
  const p = join(tmp(), 'listing.json')
  writeFileSync(p, JSON.stringify(l))
  return p
}
const base = { referenceFile: FINAL, oracle: ORACLE, now: NOW, providers: PROVIDERS }

/** The pack's key structure: every key path, with arrays reduced to their first element. */
function shape(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return v.length ? shape(v[0], `${at}[]`) : [`${at}[]`]
  if (v !== null && typeof v === 'object') {
    return Object.entries(v).filter(([k]) => k !== '_note').flatMap(([k, x]) => [`${at}.${k}`, ...shape(x, `${at}.${k}`)])
  }
  return []
}

describe('a sample market', () => {
  let r: Awaited<ReturnType<typeof list>>
  let out: string

  test('list writes pack.json, reference.json and claim.txt, and the pack passes the createMarket dry-run', async () => {
    out = tmp()
    r = await list({ input: SAMPLE, out, ...base })
    expect(r.marketId).toBe(keccak256(toBytes(sample.slug)))
    expect(r.dir).toBe(join(out, r.marketId))
    for (const f of ['pack.json', 'reference.json', 'claim.txt']) expect(existsSync(join(r.dir, f))).toBe(true)
    expect(r.check).toContain('createMarket: ok, rules 1-6 pass')
    expect(r.check).toContain(`pack: market ${r.marketId}`)
  }, FORGE)

  test('reference.json is the captured response byte for byte; dryRunHash is its keccak256', () => {
    const ref = readFileSync(join(r.dir, 'reference.json'))
    expect(Buffer.compare(ref, readFileSync(FINAL))).toBe(0)
    const pack = JSON.parse(readFileSync(join(r.dir, 'pack.json'), 'utf8'))
    expect(pack.marketInput.dryRunHash).toBe(keccak256(new Uint8Array(ref)))
    expect(r.dryRunHash).toBe(pack.marketInput.dryRunHash)
    expect(pack.marketInput.ambiguityLogHash).toBe(ZERO32) // set by the ambiguity pass (O22.3)
    expect(r.reference).toEqual({
      url: 'https://api.example-sports.com/v1/events/evt_finished_1', status: 'YES', valueHash: keccak256(toBytes('3')),
    })
  })

  test('pack.json has the key structure of ListMarket\'s example pack, and carries the input values', () => {
    const pack = JSON.parse(readFileSync(join(r.dir, 'pack.json'), 'utf8'))
    const example = JSON.parse(readFileSync(join(ORACLE_ROOT, 'listings/example/pack.json'), 'utf8'))
    expect(shape(pack).sort()).toEqual(shape(example).sort())
    const { marketId, dryRunHash, ambiguityLogHash, ...rest } = pack.marketInput
    expect(rest).toEqual(sample.marketInput)
    // 5e16 was given as a string (above 2^53 is not safe in JSON); the pack writes it as a JSON number
    const raw = readFileSync(join(r.dir, 'pack.json'), 'utf8')
    expect(raw).toContain('"maxSpreadWad": 50000000000000000,')
    expect(pack.engineInit).toBe(sample.engineInit)
  })

  test('claim.txt is the template with every token substituted for a Layer 1 YES, within maxClaimBytes', () => {
    const m = sample.marketInput
    const tau = BigInt(m.tau)
    const url = 'https://api.example-sports.com/v1/events/evt_1' // the market's own event, not the reference's
    const expected = (m.claimTemplate as string)
      .replace('{{MARKET_ID}}', r.marketId)
      .replace('{{CHAIN_ID}}', '10143')
      .replace('{{ORACLE}}', getAddress(ORACLE))
      .replace('{{QUESTION}}', m.question)
      .replace('{{RULES}}', m.rules)
      .replace('{{TAU_UTC}}', new Date(Number(tau) * 1000).toISOString().replace('.000Z', 'Z'))
      .replace('{{TAU_UNIX}}', tau.toString())
      .replace('{{OUTCOME}}', 'YES')
      .replace('{{EVIDENCE}}', `Layer 1 CRE report, value ${keccak256(toBytes('3'))}, source ${url}`)
      .replace('{{EVIDENCE_HASH}}', ZERO32)
    expect(readFileSync(join(r.dir, 'claim.txt'), 'utf8')).toBe(expected)
    expect(r.claimBytes).toBe(Buffer.byteLength(expected))
    expect(r.worstCase >= BigInt(r.claimBytes)).toBe(true)
    expect(r.worstCase <= BigInt(r.maxClaimBytes)).toBe(true)
    expect(r.maxClaimBytes).toBe(16384)
  })

  test('an existing pack directory is not replaced without --force', async () => {
    await expect(list({ input: SAMPLE, out, ...base, check: false })).rejects.toThrow(/exists/)
    const again = await list({ input: SAMPLE, out, ...base, check: false, force: true })
    expect(again.dir).toBe(r.dir)
  }, FORGE)
})

describe('fails loudly and writes nothing', () => {
  async function fails(input: string, opts: object, match: RegExp, kind: Function = ListError) {
    const out = tmp()
    const p = list({ input, out, ...base, ...opts })
    await expect(p).rejects.toThrow(match)
    await p.catch((e) => expect(e).toBeInstanceOf(kind))
    expect(existsSync(join(out, keccak256(toBytes(JSON.parse(readFileSync(input, 'utf8')).slug))))).toBe(false)
  }

  test('a reference that is not a finished event', async () => {
    await fails(SAMPLE, { referenceFile: join(FIX, 'reference-live.json') }, /NOT_READY \(NOT_FINAL\).*finished event/)
  })

  test('a reference without the value path', async () => {
    await fails(variant((l) => (l.marketInput.feed.valuePath = 'event.score.home')), {}, /ERROR \(VALUE_MISSING\)/)
  })

  test('a FeedSpec that fails rule 3 (checked before anything is fetched)', async () => {
    await fails(variant((l) => (l.marketInput.feed.decimals = 2)), {}, /BadFeed\(9\) DECIMALS/)
    await fails(variant((l) => (l.marketInput.allowList = ['stats.example-data.org', 'api.example-sports.com'])), {}, /BadFeed\(5\) L1_HOST/)
    await fails(variant((l) => (l.marketInput.feed.authRef = keccak256(toBytes('UNLISTED')))), {}, /BadFeed\(12\) AUTH_REF/)
  })

  test('a claim whose worst case exceeds maxClaimBytes', async () => {
    await fails(variant((l) => (l.marketInput.rules = 'x'.repeat(16_000))), {}, /ClaimTooLong: worst case \d+ bytes > maxClaimBytes 16384/)
  }, FORGE)

  test('createMarket rejects the pack in the dry-run: host not on the provider list (rule 4)', async () => {
    await fails(SAMPLE, { providers: [] }, /createMarket dry-run failed: BadAllowList\(3\)/, ForgeError)
  }, FORGE)

  test('createMarket rejects the pack in the dry-run: T too close to the listing (rule 2)', async () => {
    await fails(SAMPLE, { now: NOW + 172800n - 60n }, /createMarket dry-run failed: BadTimes\(\d+\)/, ForgeError)
  }, FORGE)

  test('createMarket rejects the pack in the dry-run: bondBps under the floor (rule 6)', async () => {
    await fails(variant((l) => (l.marketInput.uma.bondBps = 1000)), {}, /createMarket dry-run failed: BadUMAConfig\(\d+\)/, ForgeError)
  }, FORGE)

  test('an input outside the schema', async () => {
    await fails(variant((l) => (l.engineListing.maxSpreadWad = 50000000000000000)), {}, /maxSpreadWad: above 2\^53/)
    await fails(variant((l) => (l.marketInput.hasFeed = false)), {}, /hasFeed must be true/)
  })
})

describe('reference capture', () => {
  test('GETs the reference event URL with the authRef secret header from the workflow config', async () => {
    const authRef = keccak256(toBytes('SPORTSDATA_V1'))
    const seen: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> })
      return new Response(readFileSync(FINAL))
    }) as unknown as typeof fetch
    const out = tmp()
    const r = await list({
      input: variant((l) => (l.marketInput.feed.authRef = authRef)), out, ...base, referenceFile: undefined,
      fetchImpl, env: { SPORTSDATA_API_KEY_VALUE: 'k-123' }, check: false,
    })
    expect(seen).toEqual([{
      url: 'https://api.example-sports.com/v1/events/evt_finished_1',
      headers: { accept: 'application/json', 'x-api-key': 'k-123' },
    }])
    expect(Buffer.compare(readFileSync(join(r.dir, 'reference.json')), readFileSync(FINAL))).toBe(0)
  }, FORGE)

  test('a missing secret or a non-200 response fails', async () => {
    const authRef = keccak256(toBytes('SPORTSDATA_V1'))
    const withAuth = variant((l) => (l.marketInput.feed.authRef = authRef))
    await expect(list({ input: withAuth, out: tmp(), ...base, referenceFile: undefined, env: {}, check: false }))
      .rejects.toThrow(/set SPORTSDATA_API_KEY_VALUE/)
    const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    await expect(list({ input: SAMPLE, out: tmp(), ...base, referenceFile: undefined, fetchImpl: notFound, check: false }))
      .rejects.toThrow(/HTTP 404/)
  })
})
