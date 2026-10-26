import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'node:https';
import WebSocket, { type ClientOptions } from 'ws';
import { publicAddress } from '../http';
import { prepareWebsocketAuthentication, websocketAuthConfig, type ScopedWsCredential, type WsAuthFailure } from './authentication';

type Failure = WsAuthFailure | 'destination' | 'capacity' | 'transport';
type Callbacks = { ready(): void; data(value: unknown): void; message?(text: string): void; heartbeat?(): void; failed(reason: Failure): void };
/** Host-only custom WSS connections. Each attempt resolves and pins public DNS
 * anew, then resolves endpoint-scoped credentials. No retry or persistence here:
 * the shared runtime must own those policies before this can be activated. */
export function createSourceWebsocketTransport(deps: {
  credential: (id: string, endpoint: string) => Promise<ScopedWsCredential>;
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  makeSocket?: (url: string, options: ClientOptions) => WebSocket;
}) {
  const active = new Set<string>();
  const resolve = deps.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const makeSocket = deps.makeSocket ?? ((url, options) => new WebSocket(url, options));
  return {
    connect(sourceKey: string, raw: unknown, signal: AbortSignal, callbacks: Callbacks) {
      let stopped = false, socket: WebSocket | undefined;
      let gate: ReturnType<Awaited<ReturnType<typeof prepareWebsocketAuthentication>>['start']> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let agent: Agent | undefined;
      let pingTimer: ReturnType<typeof setInterval> | undefined, pongTimer: ReturnType<typeof setTimeout> | undefined;
      let ping: string | undefined;
      const controller = new AbortController();
      // Reserve synchronously so overlapping DNS/credential lookups count too.
      const reserved = !signal.aborted && active.size < 4 && !active.has(sourceKey);
      if (reserved) active.add(sourceKey);
      function close() {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        if (pingTimer) clearInterval(pingTimer);
        if (pongTimer) clearTimeout(pongTimer);
        signal.removeEventListener('abort', close);
        controller.abort(); gate?.close(); socket?.terminate(); agent?.destroy();
        if (reserved) active.delete(sourceKey);
      }
      function fail(reason: Failure) { if (!stopped) { close(); callbacks.failed(reason); } }
      signal.addEventListener('abort', close, { once: true });
      if (signal.aborted) close();
      else if (!reserved) queueMicrotask(() => fail('capacity'));
      else {
        timer = setTimeout(() => fail('timeout'), 10_000);
        void (async () => {
          const parsed = websocketAuthConfig.safeParse(raw);
          if (!parsed.success) return fail('configuration');
          const hostname = new URL(parsed.data.endpoint).hostname;
          let addresses: Array<{ address: string; family: number }>;
          try { addresses = await resolve(hostname); } catch { return fail('destination'); }
          if (stopped) return;
          if (!addresses.length || addresses.length > 32 || addresses.some(item => !publicAddress(item.address) || isIP(item.address) !== item.family)) return fail('destination');
          const pinned = addresses[0];
          let prepared: Awaited<ReturnType<typeof prepareWebsocketAuthentication>>;
          try { prepared = await prepareWebsocketAuthentication(parsed.data, deps.credential, controller.signal); }
          catch { return fail('configuration'); }
          if (stopped) return;
          agent = new Agent({
            keepAlive: false, family: pinned.family, servername: hostname, rejectUnauthorized: true,
            lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
          });
          socket = makeSocket(prepared.endpoint, {
            headers: prepared.headers, agent, family: pinned.family,
            rejectUnauthorized: true,
            maxPayload: 256 * 1024, maxFragments: 1024, maxBufferedChunks: 4096,
            perMessageDeflate: false, followRedirects: false,
            handshakeTimeout: 10_000, skipUTF8Validation: false,
          });
          socket.on('error', () => fail('transport'));
          socket.on('close', () => fail('transport'));
          socket.on('unexpected-response', (_request, response) => {
            response.destroy(); fail(response.statusCode === 401 || response.statusCode === 403 ? 'authentication' : 'transport');
          });
          socket.on('pong', data => {
            if (stopped || !ping || data.toString() !== ping) return;
            ping = undefined; if (pongTimer) clearTimeout(pongTimer);
            callbacks.heartbeat?.();
          });
          socket.on('open', () => {
            if (stopped) return;
            if (timer) clearTimeout(timer);
            gate = prepared.start({
              send(frame) {
                if (stopped || socket!.readyState !== WebSocket.OPEN || Buffer.byteLength(frame) > 16 * 1024 || socket!.bufferedAmount > 64 * 1024) throw Error('WebSocket send unavailable');
                socket!.send(frame, error => { if (error) fail('transport'); });
              },
              ready: () => { if (!stopped) callbacks.ready(); },
              data: value => { if (!stopped) callbacks.data(value); },
              message: text => { if (!stopped) callbacks.message?.(text); },
              failed: fail,
            });
            if (stopped) gate.close();
            else pingTimer = setInterval(() => {
              if (stopped) return;
              ping = randomUUID();
              pongTimer = setTimeout(() => fail('timeout'), 10_000);
              try { socket!.ping(ping, undefined, error => { if (error) fail('transport'); }); } catch { fail('transport'); }
            }, 15_000);
          });
          socket.on('message', (data, binary) => {
            if (stopped) return;
            if (binary) return fail('invalid_data');
            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (bytes.length > 256 * 1024) return fail('invalid_data');
            gate?.receive(bytes.toString('utf8'));
          });
        })().catch(() => fail('transport')); // Never forward provider errors or headers.
      }
      return { close };
    },
  };
}
