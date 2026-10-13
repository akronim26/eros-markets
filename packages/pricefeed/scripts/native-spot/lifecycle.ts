#!/usr/bin/env bun
/** Oracle lifecycle service for a native spot market (NM-S09). Every call is permissionless and
 *  idempotent; the service only decides *when* to call, from chain state and the game state.
 *
 *    pre-game   from T − WATCH_BEFORE_SECS: read the API-Sports game every PRE_EVERY_SECS through the
 *               shared FeedSpec evaluator and log identity/schedule/status problems (moved tip-off,
 *               postponement) before trading closes. Nothing on chain changes here.
 *    T          `haltScheduled` → the oracle halts the anchor; vault issuance closes; Layer 1 opens.
 *    T + buffer poll the game every POST_EVERY_SECS; once the evaluator says YES/NO, call
 *               `requestResolution` (the CRE log trigger). The CRE listener (`oracle/workflows/listen`)
 *               fetches, evaluates and reports through the sim forwarder; this service never reports.
 *    Proposed   `assertProposal`, then after liveness `finalizeMarket`.
 *    Final      `syncResolution` on the vault: holders can redeem.
 *    fallbacks  `escalateToL2` after T + l1Timeout (committee/review route), `voidMarket` at the void
 *               deadline (INVALID: 0.5 per token).
 *
 *    D=<deployment.json> RPC=.. KEEPER_KEY=0x.. FEED=oracle/listings/native/<m>/feed.json \
 *    SPORTSDATA_API_KEY_VALUE=.. bun scripts/native-spot/lifecycle.ts
 *
 *  API budget: ~4 pre-game reads + one read per POST_EVERY_SECS (default 600) after T + buffer, well
 *  inside the Free plan's 100/day; the CRE workflow adds one read per resolution request.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, parseAbi, type Hex } from 'viem';
import { evaluateResponse } from '../../../../oracle/packages/feedspec/src';
import { API_SPORTS_AUTH } from '../../../../oracle/packages/feedspec/src/api-sports';
import { MARKET_ID, T, V, VAULT, env, log, nowSecs, read, sleep, wallet } from './chain';

const ORACLE = getAddress(env('ORACLE', '0xb86a48B07eE07037F1B52273B9B50f20615B61e4'));
const RO = parseAbi([
  'function haltScheduled(bytes32) returns (bool)', 'function requestResolution(bytes32) returns (bool)',
  'function assertProposal(bytes32) returns (bool)', 'function finalizeMarket(bytes32) returns (uint8)',
  'function escalateToL2(bytes32) returns (bool)', 'function voidMarket(bytes32) returns (bool)',
  'function livenessFor(bytes32) view returns (uint64)',
  'function getResolution(bytes32) view returns ((uint8 state,uint8 proposed,uint8 path,uint8 attempts,uint8 rejectedMask,uint8 outcome,uint8 finalReason,bool voided,uint64 haltedAt,uint64 voidDeadline,uint64 l2StartedAt,uint64 retryOpensAt,uint64 earlyStartedAt,uint64 lastRequestAt,uint32 requestCount,uint32 trustSetId,uint32 globalsVersion,uint256 oiHaltLots,bytes32 evidenceHash,bytes32 valueHash,bytes32 assertionId,address assertionVenue,uint256 bond,address proposer,uint256 rewardAtoms))',
]);
const STATE = ['None', 'EarlyCheck', 'EarlyReview', 'L1Pending', 'L2Pending', 'Review', 'Open', 'Proposed', 'Disputed', 'Voided', 'Final'];
const OUTCOME = ['NONE', 'YES', 'NO', 'INVALID'];

const w = wallet(env('KEEPER_KEY') as Hex);
const feedFile = JSON.parse(readFileSync(resolve(env('FEED')), 'utf8'));
const spec = feedFile.feed, url: string = feedFile.url;
const API_KEY = env(API_SPORTS_AUTH.env);
const WATCH_BEFORE = Number(env('WATCH_BEFORE_SECS', '3600')), PRE_EVERY = Number(env('PRE_EVERY_SECS', '900'));
const POST_EVERY = Number(env('POST_EVERY_SECS', '600')), TICK = Number(env('TICK_MS', '30000'));

/** One provider read through the shared evaluator (same code path as the CRE workflow). */
async function game(): Promise<{ status: string; code: string; detail: string }> {
  const r = await fetch(url, { headers: { [API_SPORTS_AUTH.header]: API_KEY, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12_000) });
  const body = await r.text();
  const e = evaluateResponse(spec, r.status, body, new TextEncoder().encode(body).length);
  let detail = '';
  try { const g = JSON.parse(body).response?.[0]; detail = g ? `${g.status?.short} ${g.teams?.away?.name} ${g.scores?.away?.total ?? '-'} @ ${g.teams?.home?.name} ${g.scores?.home?.total ?? '-'} (${g.date})` : JSON.stringify(JSON.parse(body).errors); } catch { detail = `HTTP ${r.status}`; }
  return { status: e.status, code: e.code, detail };
}
const resolution = async () => (await read(ORACLE, RO, 'getResolution', [MARKET_ID])) as any;
const call = async (fn: string) => { const r = await w.send(ORACLE, RO, fn, [MARKET_ID]); log('oracle', `${fn} tx ${r.transactionHash}`); };

let lastPre = 0, lastPost = 0, finalSeen = false;
log('oracle', `market ${MARKET_ID.slice(0, 10)}… tip-off ${new Date(T * 1000).toISOString()} feed ${url} buffer ${spec.bufferSecs}s L1 timeout ${spec.l1TimeoutSecs}s`);
for (;;) {
  try {
    const now = nowSecs(), r = await resolution(), state = STATE[r.state] ?? String(r.state);
    if (now < T) {
      if (now >= T - WATCH_BEFORE && now - lastPre >= PRE_EVERY) {
        lastPre = now;
        const g = await game();
        const ok = g.status === 'NOT_READY' && g.code === 'SPORTS_NOT_FINAL';
        log('pregame', `${ok ? 'ok' : 'ATTENTION'} ${g.status}/${g.code} ${g.detail}`);
      }
    } else if (state === 'None') {
      await call('haltScheduled');
    } else if (state === 'L1Pending') {
      if (now >= T + spec.l1TimeoutSecs) { log('oracle', 'no Layer-1 result within the timeout: escalating to the review route'); await call('escalateToL2'); }
      else if (now >= T + spec.bufferSecs && now - lastPost >= POST_EVERY) {
        lastPost = now;
        const g = await game();
        log('game', `${g.status}/${g.code} ${g.detail}`);
        if (g.status === 'YES' || g.status === 'NO') { finalSeen = true; }
      }
      // Simulate first: the oracle rate-limits requests (false = no event), so only send one that emits.
      if (finalSeen && now >= T + spec.bufferSecs && await read(ORACLE, RO, 'requestResolution', [MARKET_ID])) await call('requestResolution');
    } else if (state === 'Proposed' && r.assertionId === `0x${'00'.repeat(32)}`) {
      log('oracle', `Layer-1 report: ${OUTCOME[r.proposed]}; asserting`);
      await call('assertProposal');
    } else if (state === 'Proposed' || state === 'Disputed') {
      await call('finalizeMarket'); // NOT_READY during liveness is a no-op
    } else if (state === 'Final') {
      if (!(await read(V, VAULT, 'resolved'))) { await w.send(V, VAULT, 'syncResolution', []); }
      log('oracle', `final ${OUTCOME[r.outcome]}; vault payout per YES ${Number(await read(V, VAULT, 'payoutYesWad')) / 1e18}. Done.`);
      break;
    } else if (r.voidDeadline > 0n && now >= Number(r.voidDeadline)) {
      await call('voidMarket');
    } else {
      // L2Pending / Review / Open: the committee or permissionless route owns the next step.
      if (now % 1800 < TICK / 1000) log('oracle', `state ${state}: waiting for the review route`);
    }
  } catch (e) { log('oracle', `error: ${String(e).slice(0, 200)}`); }
  await sleep(TICK);
}
