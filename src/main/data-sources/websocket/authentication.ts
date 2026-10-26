import { z } from 'zod';
import { isIP } from 'node:net';
import { containsCredentialEcho, credentialEchoValues } from '../credential-echo';

const path = z.array(z.string().min(1).max(80).refine(key => !['__proto__', 'prototype', 'constructor'].includes(key))).min(1).max(8);
const scalar = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
const predicate = z.object({ path, equals: scalar }).strict();
const template = z.object({ body: z.record(z.string(), z.unknown()), secretPaths: z.array(path).max(4).default([]) }).strict();
const acknowledgement = z.object({ success: predicate, failure: predicate }).strict().refine(value => JSON.stringify(value.success) !== JSON.stringify(value.failure), 'Acknowledgments must differ');
export const websocketAuthConfig = z.object({
  endpoint: z.string().max(2048).refine(value => {
    try { const url = new URL(value); return url.protocol === 'wss:' && (!url.port || url.port === '443') && !url.username && !url.password && !url.search && !url.hash && !isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname.includes('.') && !/%|\\/.test(url.pathname); }
    catch { return false; }
  }),
  auth: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }).strict(),
    z.object({ mode: z.literal('header'), credentialId: z.uuid() }).strict(),
    z.object({ mode: z.literal('login'), credentialId: z.uuid(), message: template, acknowledgement }).strict(),
    z.object({ mode: z.literal('subscription'), credentialId: z.uuid() }).strict(),
  ]),
  dataMode: z.enum(['json', 'text']).default('json'),
  subscription: template,
  acknowledgement,
}).strict();
export interface ScopedWsCredential {
  /** Explicit WSS endpoint authorization. HTTP credentials cannot satisfy it. */
  endpoint: string; generation: string;
  kind: 'bearer' | 'basic' | 'api-key' | 'message'; value: string; header?: 'X-API-Key' | 'API-Key';
}
export type WsAuthFailure = 'configuration' | 'authentication' | 'timeout' | 'invalid_data';
function field(value: unknown, keys: string[]): unknown {
  for (const key of keys) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined; value = (value as Record<string, unknown>)[key]; }
  return value;
}
function validateTree(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 256 || depth > 8) throw Error();
  if (value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 2048 || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) validateTree(item, depth + 1, budget); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { if (['__proto__', 'prototype', 'constructor'].includes(key) || key.length > 80) throw Error(); validateTree(item, depth + 1, budget); }
    return;
  }
  throw Error();
}
/** Host-only authentication preparation. Transport must pin the validated public
 * destination before using these headers or sending frames. This module alone
 * grants no network access, storage, renderer preview or source activation. */
export async function prepareWebsocketAuthentication(raw: unknown, resolve: (id: string, endpoint: string) => Promise<ScopedWsCredential>, signal: AbortSignal) {
  try {
    const config = websocketAuthConfig.parse(raw);
    if (Buffer.byteLength(JSON.stringify(config)) > 16 * 1024) throw Error();
    const templates = [config.subscription, ...(config.auth.mode === 'login' ? [config.auth.message] : [])];
    for (const item of templates) {
      validateTree(item.body);
      const paths = item.secretPaths.map(keys => JSON.stringify(keys));
      if (new Set(paths).size !== paths.length || item.secretPaths.some(keys => field(item.body, keys) !== null)) throw Error();
    }
    if (config.auth.mode === 'subscription' ? !config.subscription.secretPaths.length : config.subscription.secretPaths.length > 0) throw Error();
    if (config.auth.mode === 'login' && !config.auth.message.secretPaths.length) throw Error();
    signal.throwIfAborted();
    const credential = config.auth.mode === 'none' ? undefined : await resolve(config.auth.credentialId, config.endpoint);
    signal.throwIfAborted();
    if (credential && (new URL(credential.endpoint).href !== new URL(config.endpoint).href || !credential.endpoint.startsWith('wss:') || !credential.generation || credential.generation.length > 128 || !credential.value || credential.value.length > 8192 || /[\r\n]/.test(credential.value))) throw Error();
    if (config.auth.mode !== 'none' && !credential) throw Error();
    const hidden = credentialEchoValues(credential);
    if (containsCredentialEcho(config, hidden)) throw Error();
    const headers: Record<string, string> = {};
    if (config.auth.mode === 'header') {
      if (credential!.kind === 'bearer' || credential!.kind === 'basic') headers.Authorization = `${credential!.kind === 'basic' ? 'Basic' : 'Bearer'} ${credential!.value}`;
      else if (credential!.kind === 'api-key' && ['X-API-Key', 'API-Key'].includes(credential!.header ?? '')) headers[credential!.header!] = credential!.value;
      else throw Error();
    } else if (credential && credential.kind !== 'message') throw Error();
    function render(item: z.infer<typeof template>) {
      const body = structuredClone(item.body);
      for (const keys of item.secretPaths) {
        let target: Record<string, unknown> = body;
        for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
        target[keys.at(-1)!] = credential!.value;
      }
      const encoded = JSON.stringify(body); if (Buffer.byteLength(encoded) > 16 * 1024) throw Error(); return encoded;
    }
    return {
      endpoint: config.endpoint, headers,
      authScope: credential ? `${config.auth.mode === 'none' ? '' : config.auth.credentialId}:${credential.generation}` : 'public',
      start(callbacks: { send(frame: string): void; ready(): void; data(value: unknown): void; message?(text: string): void; failed(reason: WsAuthFailure): void }) {
        let state: 'authentication' | 'subscription' | 'ready' | 'closed' = config.auth.mode === 'login' ? 'authentication' : 'subscription';
        let timer: ReturnType<typeof setTimeout> | undefined;
        function stop() { state = 'closed'; if (timer) clearTimeout(timer); signal.removeEventListener('abort', stop); }
        function fail(reason: WsAuthFailure) { if (state !== 'closed') { stop(); callbacks.failed(reason); } }
        function wait() { if (timer) clearTimeout(timer); timer = setTimeout(() => fail('timeout'), 10_000); }
        function subscribe() { state = 'subscription'; wait(); callbacks.send(render(config.subscription)); }
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        else try { if (config.auth.mode === 'login') { wait(); callbacks.send(render(config.auth.message)); } else subscribe(); }
        catch { fail('configuration'); }
        return {
          receive(text: string) {
            if (state === 'closed') return;
            try {
              if (Buffer.byteLength(text) > 256 * 1024) return fail('invalid_data');
              let body: unknown;
              try { body = JSON.parse(text); } catch { if (state !== 'ready' || config.dataMode !== 'text') return fail('invalid_data'); }
              if (config.dataMode !== 'text' || state !== 'ready') validateTree(body);
              // Authentication/subscribe replies are never observations, including echoes.
              const ack = state === 'authentication' && config.auth.mode === 'login' ? config.auth.acknowledgement : config.acknowledgement;
              const matches = (rule: z.infer<typeof predicate>) => field(body, rule.path) === rule.equals;
              const authRejected = config.auth.mode === 'login' && matches(config.auth.acknowledgement.failure);
              if (authRejected || matches(ack.failure)) return fail('authentication');
              if (state !== 'ready') {
                if (!matches(ack.success)) return;
                if (state === 'authentication') subscribe();
                else { state = 'ready'; if (timer) clearTimeout(timer); callbacks.ready(); }
                return;
              }
              if (matches(ack.success) || config.auth.mode === 'login' && matches(config.auth.acknowledgement.success)) return;
              if (containsCredentialEcho(body, hidden) || containsCredentialEcho(text, hidden)) return fail('invalid_data');
              if (config.dataMode === 'text' && Buffer.byteLength(text) > 65536) return fail('invalid_data');
              callbacks.message?.(text);
              callbacks.data(config.dataMode === 'text' ? text : body);
            } catch { fail('invalid_data'); }
          },
          close: stop,
        };
      },
    };
  } catch { throw Error('WebSocket authentication configuration or credential unavailable'); }
}
