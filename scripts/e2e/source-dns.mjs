/** Optional process-only DNS resolver for the two public Polymarket read APIs.
 * HTTPS hostnames and certificate verification remain unchanged. No system DNS,
 * RPC endpoint, wallet request, or other host uses this resolver.
 */
import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

const servers = process.env.EROS_SOURCE_DNS_SERVERS?.split(',').filter(Boolean);
if (servers?.length) {
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  resolver.setServers(servers);
  const original = dns.lookup;
  const hosts = new Set(['clob.polymarket.com', 'gamma-api.polymarket.com']);
  const cache = new Map();
  dns.lookup = function (hostname, options, callback) {
    if (!hosts.has(hostname)) return original.apply(this, arguments);
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    options ||= {};
    const family = options.family === 6 || options.family === 'IPv6' ? 6 : 4;
    const key = `${hostname}:${family}`;
    let entry = cache.get(key);
    if (!entry || Date.now() >= entry.expires) {
      const resolve = family === 6 ? resolver.resolve6.bind(resolver) : resolver.resolve4.bind(resolver);
      entry = { expires: Date.now() + 30_000, result: resolve(hostname, { ttl: true }).then(records => {
        if (!records.length) throw Object.assign(new Error('No public source DNS records'), { code: 'ENOTFOUND' });
        entry.expires = Date.now() + Math.min(60, ...records.map(r => r.ttl)) * 1000;
        return records.map(r => ({ address: r.address, family }));
      }) };
      cache.set(key, entry);
      entry.result.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    }
    entry.result.then(addresses => options.all
      ? callback(null, addresses)
      : callback(null, addresses[0].address, addresses[0].family), callback);
  };
  syncBuiltinESMExports();
}
