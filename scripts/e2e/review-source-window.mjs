/** Re-evaluate preserved captures against the actual 30s lifetime / 5s headroom.
 * No timestamp rewriting, new observations, signatures or transactions. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Journal } from '../../packages/pricefeed/dist/src/journal.js';
import { inspectSnapshot, metadataIdentity, verifyEventMembership } from '../../packages/pricefeed/dist/src/collector.js';
const [directory] = process.argv.slice(2);
if (!directory?.startsWith('tmp/')) throw Error('IGNORED_RUN_DIRECTORY_REQUIRED');
const source = JSON.parse(fs.readFileSync(`${directory}/source-candidate.json`, 'utf8'));
const journal = new Journal(`${directory}/qualification.sqlite`, true);
try {
  if (!journal.verify()) throw Error('CAPTURE_HASH_MISMATCH');
  const worker = `readonly:${source.config.mapping.conditionId}:${source.config.mapping.outcomeTokenId}`;
  if (journal.workers().length !== 1 || journal.workers()[0] !== worker) throw Error('SOURCE_JOURNAL_IDENTITY_MISMATCH');
  const rows = journal.read(worker);
  let previous = null, maxCarryMs = 0, maxAgeMs = 0, maxCaptureGapMs = 0, lastAt = null;
  const digest = createHash('sha256');
  for (const { atMs, payload: p } of rows) {
    digest.update(JSON.stringify(p));
    const metadata = metadataIdentity(source.config, JSON.parse(p.metadata.body));
    const event = verifyEventMembership(source.config, JSON.parse(p.event.body));
    const combined = { tradeable: metadata.tradeable && event.tradeable,
      rulesDigest: createHash('sha256').update(`${event.rulesDigest}:${metadata.rulesDigest}`).digest('hex') };
    const check = inspectSnapshot(source.config, JSON.parse(p.book.body), atMs,
      previous, combined, BigInt(p.metadata.receivedAtMs), source.rules.externalRulesDigest.slice(2));
    if (check.status !== 'COLLECTING' || !check.time?.hasHeadroom || !check.summary?.valid) throw Error('CAPTURE_NOT_VALID:' + check.reason);
    const stamp = check.time.sourceMs;
    maxAgeMs = Math.max(maxAgeMs, Number(atMs - (stamp / 1000n) * 1000n));
    if (previous !== null) maxCarryMs = Math.max(maxCarryMs, Number(atMs - (previous / 1000n) * 1000n));
    if (lastAt !== null) maxCaptureGapMs = Math.max(maxCaptureGapMs, Number(atMs - lastAt));
    previous = stamp; lastAt = atMs;
  }
  const durationMs = rows.length ? Number(rows.at(-1).atMs - rows[0].atMs) : 0;
  const passed = rows.length >= 550 && durationMs >= 590000 && maxAgeMs < 25000 && maxCarryMs < 25000;
  const report = { passed, reviewedAt: new Date().toISOString(), captures: rows.length, durationMs, maxAgeMs, maxCarryMs, maxCaptureGapMs,
    lifetimeMs: 30000, requiredHeadroomMs: 5000, captureDigest: digest.digest('hex'),
    scope: 'Authentic capture continuity; publication, index coverage and leverage still require on-chain verification.' };
  fs.writeFileSync(`${directory}/source-window-review.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (!passed) process.exitCode = 1;
} finally { journal.close(); }
