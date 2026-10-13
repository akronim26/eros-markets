// Native keeper liquidation scan (followup_deployment step 5): decision, cursor and send behaviour of
// scripts/native-market/liquidation.sh with `cast`, `rd` and `keeper_tx` replaced by scripted doubles.
// Expected values are written by hand from the selection rule in oracle/services/market-ops/src/operations.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const lib = fileURLToPath(new URL('./liquidation.sh', import.meta.url));
const bash = (body, env = {}) => execFileSync('bash', ['-c', `set -uo pipefail; . '${lib}'; ${body}`],
  { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const status = body => { try { bash(body); return 0; } catch (e) { return e.status; } };

// LiquidationResult (result, mode, takeoverPredicate, pairedLots, bookLots, lotsAfter, cutoff, reason) as cast prints it.
const result = ({ result = 0, mode = 0, paired = 0, book = 0, after = 0, reason = 0 }) =>
  `(${result}, ${mode}, 0, ${paired}, ${book}${book >= 1e5 ? ` [${book.toExponential()}]` : ''}, ${after}, 70779079 [7.077e7], ${reason})`;
// MarketRiskView: 19 fields; accountingState is field 4, liquidationCapLots 17, liquidationRemainingLots 18.
const view = ({ acct = 0, cap = 100000, rem = 100000 }) =>
  `(1791923037 [1.791e9], 1, 1, ${acct}, true, 524000000000000000 [5.24e17], true, 524000000000000000 [5.24e17], 3, ` +
  `0x1234000000000000000000000000000000000000000000000000000000000000, 1500000 [1.5e6], false, 1791923000 [1.791e9], 0, 0, 0, ` +
  `${cap}${cap >= 1e5 ? ` [${cap.toExponential()}]` : ''}, ${rem}, 0)`;

test('liq_productive: only reason 0 with book/paired lots or an authorized takeover is sent', () => {
  const sendable = r => status(`liq_productive '${r}'`) === 0;
  assert.equal(sendable(result({ result: 1, mode: 1, book: 250000 })), true);            // REDUCE closed book lots
  assert.equal(sendable(result({ result: 2, mode: 1, paired: 40 })), true);              // paired lots, more work
  assert.equal(sendable(result({ result: 3, mode: 2 })), true);                          // TAKEOVER_AUTHORIZED
  assert.equal(sendable(result({ result: 0, mode: 0 })), false);                         // NOT_ELIGIBLE
  assert.equal(sendable(result({ result: 2, mode: 1 })), false);                         // eligible, no liquidity: no-effect
  assert.equal(sendable(result({ result: 3, mode: 1 })), false);                         // takeover result outside TAKEOVER mode
  assert.equal(sendable(result({ result: 1, mode: 1, book: 500, reason: 7 })), false);   // any reject reason
  assert.equal(sendable(result({ result: 1, mode: 1, book: 500, after: -1200 })), true); // signed lotsAfter parses
  assert.equal(sendable(''), false);
  assert.equal(sendable('(1, 1, 0)'), false);
});

test('liq_ids: rotating window over trader ids 1..N, last line is the next cursor', () => {
  const ids = (c, n, l) => bash(`liq_ids ${c} ${n} ${l}`).trim().split('\n').map(Number);
  assert.deepEqual(ids(1, 5, 3), [1, 2, 3, 4]);
  assert.deepEqual(ids(4, 5, 3), [4, 5, 1, 2]);
  assert.deepEqual(ids(1, 2, 32), [1, 2, 1]);
  assert.deepEqual(ids(9, 5, 2), [1, 2, 3]);   // a cursor past N (participants never shrink, but be safe) restarts at 1
  assert.deepEqual(ids(0, 5, 1), [1, 2]);
  assert.deepEqual(ids(1, 0, 32), [1]);        // no participants: nothing to examine
});

// cast double: marketRiskView, participantCount and liquidate simulations come from env; every call is logged.
const scan = ({ view: v, participants = '3', results = {}, txOk = true, cursor = 1, scanLimit = 32 }) => bash(`
  ts() { echo T; }
  LOG=$(mktemp)
  cast() { echo "cast $*" >> "$LOG"
    case "$1:$3" in
      call:marketRiskView*) echo "$VIEW";;
      call:participantCount*) echo "$PARTS";;
      call:liquidate*) local v="RES_$4"; [ -n "\${!v:-}" ] && echo "\${!v}" || echo '${result({})}';;
      *) return 1;;
    esac; }
  rd() { cast "$@"; }
  keeper_tx() { echo "tx $*" >> "$LOG"; [ "$TX_OK" = 1 ]; }
  ENG=0xE R=r KA=0xK LIQ_SCAN=${scanLimit} liq_cursor=${cursor}
  # Run in this shell (not $(...)) so the cursor update survives, as in keeper-daemon.sh.
  OUT=$(mktemp); liquidation_scan > "$OUT"; echo "out=$(cat "$OUT")"
  echo "cursor=$liq_cursor"; grep -E '^(tx|cast call 0xE liquidate)' "$LOG" | sed 's/(.*)//' || true`,
{ VIEW: v, PARTS: participants, TX_OK: txOk ? '1' : '0',
  ...Object.fromEntries(Object.entries(results).map(([id, r]) => [`RES_${id}`, r])) });

test('liquidation_scan: no simulation while accounting is closed or the budget is spent', () => {
  for (const v of [view({ acct: 1 }), view({ cap: 0 }), view({ rem: 0 })]) {
    const out = scan({ view: v });
    assert.match(out, /^out=$/m);
    assert.doesNotMatch(out, /liquidate|^tx/m);
  }
  assert.doesNotMatch(scan({ view: view({}), participants: '0' }), /liquidate|^tx/m);
});

test('liquidation_scan: simulates each id, sends the first productive one with the cap, keeps its cursor', () => {
  const out = scan({ view: view({ cap: 100000 }), results: { 2: result({ result: 2, mode: 1, book: 100000 }) } });
  assert.match(out, /cast call 0xE liquidate\S* 1 100000 8 0/);
  assert.match(out, /cast call 0xE liquidate\S* 2 100000 8 0/);
  assert.doesNotMatch(out, /liquidate\S* 3 /);                        // stops after one send
  assert.match(out, /^tx 0xE liquidate\S* 2 100000 8 0$/m);
  assert.match(out, /trader 2 productive .*trader 2 sent/s);
  assert.match(out, /^cursor=2$/m);                                   // same account first next loop
});

test('liquidation_scan: nothing productive sends nothing and advances the cursor', () => {
  const out = scan({ view: view({}), participants: '5', cursor: 4, scanLimit: 3 });
  assert.deepEqual([...out.matchAll(/liquidate\S* (\d+) /g)].map(m => Number(m[1])), [4, 5, 1]);
  assert.doesNotMatch(out, /^tx/m);
  assert.match(out, /^out=$/m);
  assert.match(out, /^cursor=2$/m);
});

test('liquidation_scan: a failed send is logged and the scan moves past the account', () => {
  const out = scan({ view: view({}), participants: '5', scanLimit: 2, results: { 1: result({ result: 3, mode: 2 }) }, txOk: false });
  assert.match(out, /^tx 0xE liquidate\S* 1 /m);
  assert.match(out, /trader 1 send failed/);
  assert.match(out, /^cursor=3$/m);   // window 1..2 examined; a failed account does not pin the cursor
});
