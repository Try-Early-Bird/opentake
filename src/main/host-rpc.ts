import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPrivateWrite } from './private-files';
import { setTimeout as delay } from 'node:timers/promises';

export interface HostManifest { port: number; token: string; pid: number; build: string; protocol: 1 }
export type HostDispatch = (method: string, args: unknown[], clientId: string) => Promise<unknown>;
const MAX_BYTES = 8 * 1024 * 1024;
export async function readHostManifest(profile: string): Promise<HostManifest | null> {
  try {
    const file = join(profile, 'host.json');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Invalid host manifest');
    const value = JSON.parse(await readFile(file, 'utf8')) as HostManifest;
    if (value.protocol !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(value.token) || typeof value.build !== 'string' || !Number.isInteger(value.pid)) throw new Error('Invalid host manifest');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Host metadata unavailable'); }
}

export async function startHostRpc(profile: string, build: string, dispatch: HostDispatch, authorizeRun?: (token: string, method: string, args: unknown[]) => boolean) {
  const token = randomBytes(32).toString('hex');
  const pending = new Set<Promise<void>>();
  let closing = false;
  const server: Server = createServer((request, response) => {
    const supplied = request.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    const management = Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (closing || request.method !== 'POST' || request.url !== '/rpc' || request.headers.origin ||
      (!management && (!authorizeRun || !/^Bearer [a-f0-9]{64}$/.test(supplied)))) {
      response.writeHead(403).end(); return;
    }
    const work = (async () => {
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BYTES) throw new Error('Request too large');
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body.method !== 'string' || !Array.isArray(body.args) || body.args.length > 4 ||
          typeof body.clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.clientId)) throw new Error('Invalid request');
        const gateway = body.method === 'gateway:instructions' || body.method === 'gateway:list' || body.method === 'gateway:call';
        if (gateway ? !authorizeRun?.(supplied.slice(7), body.method, body.args) : !management) {
          response.writeHead(403).end(); return;
        }
        const value = await dispatch(body.method, body.args, body.clientId);
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, value: value ?? null }));
      } catch {
        // No raw exceptions, URLs, headers, credential values or request bodies in responses/logs.
        if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, message: 'Background host request failed.' }));
      }
    })();
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {});
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Host listener unavailable');
  const manifest: HostManifest = { port: address.port, token, pid: process.pid, protocol: 1, build };
  await atomicPrivateWrite(join(profile, 'host.json'), Buffer.from(JSON.stringify(manifest)));
  return {
    manifest,
    async close(removeManifest = true) {
      closing = true;
      server.close();
      await Promise.allSettled([...pending]);
      server.closeAllConnections();
      if (removeManifest) await unlink(join(profile, 'host.json')).catch(() => {});
    },
    async unpublish() { await unlink(join(profile, 'host.json')).catch(() => {}); },
  };
}

export async function hostCall<T>(host: HostManifest, method: string, args: unknown[], clientId: string, timeout = 330_000, signal?: AbortSignal): Promise<T> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  // A keep-alive socket can be reset during a dev restart. These status
  // and local data reads are safe to repeat; mutations and tool calls must never be replayed.
  const retryable = ['ai:status', 'host:status', 'strategies:read', 'strategies:available', 'notifications:navigation'].includes(method);
  for (let attempt = 0; ; attempt++) {
    try { return await hostCallOnce<T>(host, method, args, clientId, requestSignal); }
    catch (error) {
      const failure = error as { code?: string; cause?: { code?: string } };
      const code = failure?.cause?.code ?? failure?.code;
      const reset = code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET';
      if (!retryable || !reset || requestSignal.aborted) throw error;
      if (attempt > 0) throw new Error('Background host connection was interrupted. Please retry the read.');
      await delay(100, undefined, { signal: requestSignal });
    }
  }
}

async function hostCallOnce<T>(host: HostManifest, method: string, args: unknown[], clientId: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${host.port}/rpc`, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, args, clientId }), signal });
  if (!response.ok) throw new Error(response.status===400?'Background host request failed. The host is responding, but could not complete this request.':'Background host unavailable');
  // Bound responses too; never log a body if parsing/validation fails.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Background host unavailable');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Host response too large'); }
    chunks.push(value);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body.ok) throw new Error('Background host request failed');
  return body.value as T;
}
