import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { prepareWebsocketAuthentication } from '../../../src/main/data-sources/websocket/authentication';
const endpoint = 'wss://fixture.example/feed', id = '11111111-1111-4111-8111-111111111111', secret = 'synthetic-private-value';
const ack = { success: { path: ['status'], equals: 'subscribed' }, failure: { path: ['status'], equals: 'rejected' } };
const config = (auth: unknown = { mode: 'none' }) => ({ endpoint, auth, subscription: { body: { type: 'subscribe', channel: 'prices' } }, acknowledgement: ack });
const login = { mode: 'login', credentialId: id, message: { body: { type: 'login', token: null }, secretPaths: [['token']] }, acknowledgement: { success: { path: ['status'], equals: 'authenticated' }, failure: { path: ['status'], equals: 'expired' } } };
const credential = { endpoint, generation: 'revision-1', kind: 'message' as const, value: secret };
const callbacks = () => ({ send: vi.fn(), ready: vi.fn(), data: vi.fn(), failed: vi.fn() });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

test('public subscription gates data on explicit acknowledgement without credential access', async () => {
  const resolver = vi.fn(), prepared = await prepareWebsocketAuthentication(config(), resolver, new AbortController().signal);
  const cb = callbacks(), session = prepared.start(cb);
  expect(resolver).not.toHaveBeenCalled(); expect(prepared.headers).toEqual({}); expect(prepared.authScope).toBe('public');
  session.receive('{"price":1}'); expect(cb.data).not.toHaveBeenCalled();
  session.receive('{"status":"subscribed"}'); expect(cb.ready).toHaveBeenCalledTimes(1);
  session.receive('{"price":2}'); expect(cb.data).toHaveBeenCalledExactlyOnceWith({ price: 2 }); session.close();
});

test('JSON login precedes subscription, secret placeholders are host-only and login replies do not become samples', async () => {
  const raw = config(login), prepared = await prepareWebsocketAuthentication(raw, async () => credential, new AbortController().signal);
  const cb = callbacks(), session = prepared.start(cb);
  expect(JSON.stringify(raw)).not.toContain(secret);
  expect(JSON.parse(cb.send.mock.calls[0][0])).toEqual({ type: 'login', token: secret });
  session.receive(JSON.stringify({ status: 'authenticated', echo: secret })); expect(cb.send).toHaveBeenCalledTimes(2);
  session.receive('{"status":"subscribed"}'); expect(cb.ready).toHaveBeenCalledTimes(1); expect(cb.data).not.toHaveBeenCalled();
  session.receive('{"status":"expired"}'); expect(cb.failed).toHaveBeenCalledExactlyOnceWith('authentication');
  session.receive('{"price":2}'); expect(cb.data).not.toHaveBeenCalled();
});

test.each(['bearer', 'basic', 'api-key'] as const)('%s header uses explicit WSS-scoped credentials', async kind => {
  const prepared = await prepareWebsocketAuthentication(config({ mode: 'header', credentialId: id }), async () => ({ ...credential, kind, header: 'X-API-Key', value: kind === 'basic' ? Buffer.from('fixture:synthetic-password').toString('base64') : secret }), new AbortController().signal);
  expect(Object.keys(prepared.headers)).toEqual([kind === 'api-key' ? 'X-API-Key' : 'Authorization']);
  expect(prepared.authScope).toBe(`${id}:revision-1`);
});

test('subscription authentication replaces only explicit null placeholders', async () => {
  const raw = { ...config({ mode: 'subscription', credentialId: id }), subscription: { body: { type: 'subscribe', token: null }, secretPaths: [['token']] } };
  const prepared = await prepareWebsocketAuthentication(raw, async () => credential, new AbortController().signal);
  const cb = callbacks(), session = prepared.start(cb);
  expect(JSON.parse(cb.send.mock.calls[0][0]).token).toBe(secret); session.close();
  await expect(prepareWebsocketAuthentication({ ...raw, subscription: { body: { token: 'literal' }, secretPaths: [['token']] } }, async () => credential, new AbortController().signal)).rejects.toThrow('unavailable');
});

test.each(['https://fixture.example/feed', 'wss://other.example/feed', 'wss://fixture.example/other'])('credential scoped to %s cannot authorize this endpoint', async scoped => {
  await expect(prepareWebsocketAuthentication(config(login), async () => ({ ...credential, endpoint: scoped }), new AbortController().signal)).rejects.toThrow('unavailable');
});

test('credential echoes after readiness fail closed without sending data or raw errors', async () => {
  const prepared = await prepareWebsocketAuthentication(config(login), async () => credential, new AbortController().signal);
  const cb = callbacks(), session = prepared.start(cb);
  session.receive('{"status":"authenticated"}'); session.receive('{"status":"subscribed"}');
  session.receive(JSON.stringify({ nested: { token: secret } }));
  expect(cb.data).not.toHaveBeenCalled(); expect(cb.failed).toHaveBeenCalledExactlyOnceWith('invalid_data');
  expect(JSON.stringify(cb.failed.mock.calls)).not.toContain(secret);
});

test('missing acknowledgement times out and abort fences pending credential resolution and late frames', async () => {
  const prepared = await prepareWebsocketAuthentication(config(), vi.fn(), new AbortController().signal);
  const cb = callbacks(), session = prepared.start(cb); await vi.advanceTimersByTimeAsync(10_000);
  expect(cb.failed).toHaveBeenCalledExactlyOnceWith('timeout'); session.receive('{"status":"subscribed"}'); expect(cb.ready).not.toHaveBeenCalled();
  const abort = new AbortController(); let complete!: (value: typeof credential) => void;
  const pending = prepareWebsocketAuthentication(config(login), () => new Promise(resolve => { complete = resolve; }), abort.signal);
  abort.abort(); complete(credential); await expect(pending).rejects.toThrow('unavailable');
});

test('unsafe endpoints, oversized templates and reserved paths are rejected before credentials', async () => {
  const resolver = vi.fn();
  for (const target of ['ws://fixture.example/feed', 'wss://fixture.example/feed?token=x', 'wss://user:pass@fixture.example/feed', 'wss://127.0.0.1/feed']) {
    await expect(prepareWebsocketAuthentication({ ...config(login), endpoint: target }, resolver, new AbortController().signal)).rejects.toThrow('unavailable');
  }
  await expect(prepareWebsocketAuthentication({ ...config(), subscription: { body: { text: 'x'.repeat(20_000) } } }, resolver, new AbortController().signal)).rejects.toThrow('unavailable');
  await expect(prepareWebsocketAuthentication({ ...config(login), subscription: { body: {}, secretPaths: [['__proto__']] } }, resolver, new AbortController().signal)).rejects.toThrow('unavailable');
  expect(resolver).not.toHaveBeenCalled();
});
test('text mode preserves JSON whitespace and plain strings, excludes acknowledgments and blocks secret echoes', async()=>{
 const prepared=await prepareWebsocketAuthentication({...config({mode:'header',credentialId:id}),dataMode:'text'},async()=>({...credential,kind:'bearer'}),new AbortController().signal);
 const cb={...callbacks(),message:vi.fn()},session=prepared.start(cb);
 session.receive('{"status":"subscribed"}');expect(cb.message).not.toHaveBeenCalled();
 session.receive('  { "price": "1.25" }  ');session.receive('Market open — prices streaming');
 expect(cb.data.mock.calls).toEqual([['  { "price": "1.25" }  '],['Market open — prices streaming']]);
 expect(cb.message).toHaveBeenCalledTimes(2);session.receive('echo: '+secret);
 expect(cb.failed).toHaveBeenCalledWith('invalid_data');expect(cb.message).toHaveBeenCalledTimes(2);session.close();
});
