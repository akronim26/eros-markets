/** Writes the canonical Layer-1 FeedSpec for a native spot market from its reviewed sports binding
 *  (NM-S02). The listing script and the Solidity tests read this file, so the on-chain spec is
 *  byte-identical to what the shared evaluator (CRE workflow, watchdog) accepts.
 *
 *    bun e2e/src/native-spot-feed.ts listings/native/<market>/binding.json   (from oracle/)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes } from 'viem'
import { buildUrl } from '../../packages/feedspec/src'
import { API_SPORTS_PROVIDERS } from '../../packages/feedspec/src/api-sports'
import { sportsFeed, type SportsBinding } from '../../packages/feedspec/src/sports'

const file = process.argv[2]
if (!file) throw new Error('usage: native-spot-feed.ts <binding.json>')
const binding = JSON.parse(readFileSync(resolve(file), 'utf8')) as SportsBinding
const provider = API_SPORTS_PROVIDERS.find(p => p.id === binding.sport)
if (!provider) throw new Error('UNKNOWN_SPORT')
const authRef = keccak256(toBytes(provider.authRefLabel))
const feed = sportsFeed(binding, authRef)
const specHash = keccak256(encodeAbiParameters(
  parseAbiParameters('(string,string,bytes32,string,string,string,uint8,uint8,uint8,string,uint32,uint32)'),
  [[feed.urlTemplate, feed.urlParam, feed.authRef as `0x${string}`, feed.finalPath, feed.finalValue, feed.valuePath,
    feed.valueType, feed.decimals, feed.op, feed.target, feed.bufferSecs, feed.l1TimeoutSecs]]))
const out = { provider: provider.host, authRefLabel: provider.authRefLabel, url: buildUrl(feed), specHash, feed }
writeFileSync(join(dirname(resolve(file)), 'feed.json'), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
