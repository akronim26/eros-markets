// Task O37.3: every query is valid against the API Envio serves for schema.graphql. Envio exposes the entities through
// Hasura; this builds Hasura's shape from schema.graphql (per entity: a list field with where / order_by / limit and
// <Type>_by_pk; comparison operators per scalar; BigInt as numeric; object and array relationships) and validates each
// query with graphql-js. That a query returns data on testnet is checked against the running indexer (O37.3 evidence).
import { readFileSync } from 'node:fs'
import { buildSchema, type GraphQLSchema, parse, validate } from 'graphql'
import { describe, expect, it } from 'vitest'
import { gql, IndexerError, QUERIES } from '../src/queries'

type Field = { name: string; type: string; list: boolean; entity: boolean }

function hasuraSchema(sdl: string): GraphQLSchema {
  const types = new Map<string, Field[]>()
  for (const [, name, body] of sdl.matchAll(/type (\w+) \{([\s\S]*?)\n\}/g)) types.set(name!, [])
  for (const [, name, body] of sdl.matchAll(/type (\w+) \{([\s\S]*?)\n\}/g)) {
    for (const line of body!.split('\n')) {
      const m = /^\s+(\w+): (\[)?(\w+)!?\]?!?/.exec(line.replace(/#.*/, ''))
      if (m) types.get(name!)!.push({ name: m[1]!, type: m[3]!, list: m[2] === '[', entity: types.has(m[3]!) })
    }
  }
  const scalar = (t: string) => ({ ID: 'String', BigInt: 'numeric', Int: 'Int', String: 'String', Boolean: 'Boolean' })[t] ?? t
  const out: string[] = ['scalar numeric', 'enum order_by { asc desc }']
  for (const s of ['String', 'Int', 'Boolean', 'numeric']) out.push(`input ${s}_comparison_exp { _eq: ${s} _neq: ${s} _gt: ${s} _lt: ${s} _gte: ${s} _lte: ${s} _in: [${s}!] _nin: [${s}!] }`)
  const query: string[] = []
  for (const [t, fields] of types) {
    const plain = fields.filter((f) => !f.entity)
    const args = `(where: ${t}_bool_exp, order_by: [${t}_order_by!], limit: Int, offset: Int)`
    // a reference field `market: Market!` is stored as market_id and is also an object relationship
    const refs = fields.filter((f) => f.entity && !f.list)
    out.push(`type ${t} { ${[
      ...plain.map((f) => `${f.name}: ${f.list ? `[${scalar(f.type)}!]` : scalar(f.type)}`),
      ...refs.flatMap((f) => [`${f.name}: ${f.type}`, `${f.name}_id: String`]),
      ...fields.filter((f) => f.entity && f.list).map((f) => `${f.name}(where: ${f.type}_bool_exp, order_by: [${f.type}_order_by!], limit: Int): [${f.type}!]!`),
    ].join(' ')} }`)
    const cmp = [...plain.filter((f) => !f.list).map((f) => `${f.name}: ${scalar(f.type)}_comparison_exp`), ...refs.map((f) => `${f.name}_id: String_comparison_exp`)]
    out.push(`input ${t}_bool_exp { _and: [${t}_bool_exp!] _or: [${t}_bool_exp!] ${cmp.join(' ')} }`)
    out.push(`input ${t}_order_by { ${[...plain.filter((f) => !f.list).map((f) => f.name), ...refs.map((f) => `${f.name}_id`)].map((n) => `${n}: order_by`).join(' ')} }`)
    query.push(`${t}${args}: [${t}!]!`, `${t}_by_pk(id: String!): ${t}`)
  }
  out.push(`type Query { ${query.join(' ')} }`)
  return buildSchema(out.join('\n'))
}

const SDL = readFileSync(new URL('../schema.graphql', import.meta.url), 'utf8')
const schema = hasuraSchema(SDL)

describe('queries', () => {
  it.each(Object.entries(QUERIES))('%s is valid against the indexer’s API', (_name, q) => {
    expect(validate(schema, parse(q)).map((e) => e.message)).toEqual([])
  })

  it('the check itself rejects a wrong field, a wrong filter and a wrong order', () => {
    for (const bad of ['{ Market { nope } }', '{ Market(where: { live: { _eq: "x" } }) { id } }', '{ Market(order_by: [{ deadline: up }]) { id } }', '{ Assertion_by_pk(id: "1") { market { nope } } }']) {
      expect(validate(schema, parse(bad)).length).toBeGreaterThan(0)
    }
  })

  it('gql sends the query and variables, returns data and throws on errors', async () => {
    const calls: { url: string; body: unknown }[] = []
    const reply = (body: unknown, status = 200) => (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) })
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    expect(await gql('http://x/v1/graphql', QUERIES.LIVE_MARKETS, { limit: 5 }, reply({ data: { Market: [] } }))).toEqual({ Market: [] })
    expect(calls[0]).toEqual({ url: 'http://x/v1/graphql', body: { query: QUERIES.LIVE_MARKETS, variables: { limit: 5 } } })
    await expect(gql('u', '{x}', {}, reply({ errors: [{ message: 'field "x" not found' }] }))).rejects.toThrow(IndexerError)
    await expect(gql('u', '{x}', {}, reply({}, 502))).rejects.toThrow(/HTTP 502/)
  })
})
