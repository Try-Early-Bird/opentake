import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { endpointSchema } from './config';

const excluded = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) excluded.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) excluded.addSubnet(address, prefix, 'ipv6');
const publicV6 = new BlockList(); publicV6.addSubnet('2000::', 3, 'ipv6');
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !excluded.check(address, 'ipv4') : family === 6 && publicV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
}
export class SourceHttpError extends Error {
  constructor(readonly code: 'destination' | 'capacity' | 'timeout' | 'cancelled' | 'authentication' | 'rate_limited' | 'response' | 'transport', readonly retryAfterMs = 0) {
    super(`Custom source ${code}`);
  }
}
type Address = { address: string; family: number };
export function retryAfter(value: string | undefined, now: number): number {
  if (!value) return 0;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}
/** Direct HTTPS: no global agent/proxy, redirects, cookies or compressed bodies.
 * Dependency injection is host/test-only, never a source configuration option.
 */
export function createSourceHttpClient(deps: {
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: typeof httpsRequest;
  now?: () => number;
} = {}) {
  const resolve = deps.resolve ?? (hostname => dnsLookup(hostname, { all: true, verbatim: true }));
  const request = deps.request ?? httpsRequest, now = deps.now ?? Date.now;
  // Previews/inspection have their own key space and budget so they never contend with live polls.
  const pools = { live: { active: new Set<string>(), limit: 4 }, preview: { active: new Set<string>(), limit: 2 } };
  return {
    async read(sourceKey: string, endpoint: string, signal: AbortSignal, credentials?: { kind: 'bearer' | 'basic' | 'api-key'; value: string; header?: 'X-API-Key' | 'API-Key' }, pool: 'live' | 'preview' = 'live'): Promise<unknown> {
      const { active, limit } = pools[pool] ?? pools.live;
      if (active.size >= limit || active.has(sourceKey)) throw new SourceHttpError('capacity');
      const parsed = endpointSchema.safeParse(endpoint);
      if (!parsed.success) throw new SourceHttpError('destination');
      const url = new URL(parsed.data), hostname = url.hostname.replace(/^\[|\]$/g, '');
      // Require DNS names in this first custom HTTP slice; no literal-IP bypass.
      if (isIP(hostname) || !hostname.includes('.')) throw new SourceHttpError('destination');
      if (credentials && (!credentials.value || credentials.value.length > 8192 || /[\r\n]/.test(credentials.value) || credentials.kind === 'api-key' && !['X-API-Key', 'API-Key'].includes(credentials.header ?? ''))) throw new SourceHttpError('authentication');
      signal.throwIfAborted(); active.add(sourceKey);
      const deadline = AbortSignal.timeout(10_000), combined = AbortSignal.any([signal, deadline]);
      try {
        const addresses = await new Promise<Address[]>((accept, reject) => {
          const abort = () => reject(new SourceHttpError(signal.aborted ? 'cancelled' : 'timeout'));
          combined.addEventListener('abort', abort, { once: true });
          if (combined.aborted) { abort(); return; }
          // Lookup failure is transient; only answers are policy.
          void resolve(hostname).then(accept, () => reject(new SourceHttpError('transport'))).finally(() => combined.removeEventListener('abort', abort));
        });
        combined.throwIfAborted();
        if (!addresses.length || addresses.length > 32 || addresses.some(item => !publicAddress(item.address) || isIP(item.address) !== item.family)) throw new SourceHttpError('destination');
        const pinned = addresses[0];
        const headers: Record<string, string> = { Accept: 'application/json', 'Accept-Encoding': 'identity' };
        if (credentials) headers[credentials.kind === 'api-key' ? credentials.header! : 'Authorization'] = credentials.kind === 'api-key' ? credentials.value : `${credentials.kind === 'basic' ? 'Basic' : 'Bearer'} ${credentials.value}`;
        return await new Promise((accept, reject) => {
          const req = request(url, {
            method: 'GET', agent: false, family: pinned.family,
            servername: hostname, rejectUnauthorized: true, signal: combined, headers,
            lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
          }, response => {
            const status = response.statusCode ?? 0;
            const stop = (error: SourceHttpError) => { response.destroy(); req.destroy(); reject(error); };
            if (status === 401 || status === 403) { stop(new SourceHttpError('authentication')); return; }
            if (status === 429 || status === 503) { stop(new SourceHttpError('rate_limited', retryAfter(response.headers['retry-after'], now()))); return; }
            if (status < 200 || status >= 300) { stop(new SourceHttpError('response')); return; }
            const type = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
            if (!type || !(type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)) || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' || Number(response.headers['content-length'] ?? 0) > 1024 * 1024) { stop(new SourceHttpError('response')); return; }
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1024 * 1024) { stop(new SourceHttpError('response')); return; }
              chunks.push(chunk);
            });
            response.once('aborted', () => reject(new SourceHttpError('transport')));
            response.once('error', () => reject(new SourceHttpError('transport')));
            response.once('end', () => {
              try { accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
              catch { reject(new SourceHttpError('response')); }
            });
          });
          req.once('error', () => reject(new SourceHttpError(signal.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'transport')));
          req.end();
        });
      } catch (error) {
        if (error instanceof SourceHttpError) throw error;
        throw new SourceHttpError(signal.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'transport');
      } finally { active.delete(sourceKey); }
    },
  };
}
