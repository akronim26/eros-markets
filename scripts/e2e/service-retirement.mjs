import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Any retirement marker, including an incomplete one after a crash, fails closed. */
export function assertServiceNotRetired(servicesDirectory) {
  try { lstatSync(join(servicesDirectory, 'retired.json')); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  throw Error('RETIRED_MARKET_SERVICE');
}

/** Durable fence before native recovery signs; it never edits any worker journal. */
export function installServiceRetirement(servicesDirectory, marker) {
  if (marker?.schema !== 'eros-market-native-retirement/1'
    || !/^0x[0-9a-f]{64}$/i.test(marker.planSetHash ?? '')
    || !/^0x[0-9a-f]{40}$/i.test(marker.engine ?? '')
    || !/^0x[0-9a-f]{40}$/i.test(marker.recipient ?? '')
    || !Array.isArray(marker.senders) || marker.senders.length !== 4
    || marker.senders.some(a => !/^0x[0-9a-f]{40}$/i.test(a))
    || new Set(marker.senders.map(a => a.toLowerCase())).size !== 4) throw Error('INVALID_SERVICE_RETIREMENT');
  const file = join(servicesDirectory, 'retired.json');
  const body = JSON.stringify(marker, null, 2) + '\n';
  let fd;
  try { fd = openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== body) throw Error('RETIREMENT_FENCE_CHANGED');
    return;
  }
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
