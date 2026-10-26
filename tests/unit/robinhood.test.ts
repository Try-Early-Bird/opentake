import { expect, test, vi } from 'vitest';
import * as loopback from '../../src/main/robinhood-loopback';
import { captureCallback } from '../../src/main/robinhood-loopback';
import { loadProvider, parseAccounts, robinhoodFetch, validateRobinhoodUrl } from '../../src/main/robinhood-client';
import type { SecretStore } from '../../src/main/secret-store';

export function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return { available: () => true, get: async ref => values.get(ref) ?? null,
    set: async (ref, value) => { values.set(ref, value); }, has: async ref => values.has(ref), delete: async ref => { values.delete(ref); } };
}

test('loopback rejects wrong state, accepts one callback, and cleans up on cancel', async () => {
  const controller = new AbortController();
  const capture = await captureCallback('expected-state', controller.signal, 0);
  try {
    const base = `http://127.0.0.1:${capture.port}/callback`;
    expect((await fetch(`${base}?state=wrong&code=bad`)).status).toBe(400);
    expect((await fetch(`${base}?state=expected-state&code=bad&iss=https://attacker.test`)).status).toBe(400);
    const response = await fetch(`${base}?state=expected-state&code=synthetic-code`);
    const html = await response.text();
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html).toContain('<main class="card">');
    expect(html).toContain('Authorization received');
    expect(html).toContain('Earlybird-Opentake');
    expect(html).not.toContain('connected');
    expect(html).not.toContain('synthetic-code');
    expect(html).not.toContain('expected-state');
    expect(await capture.callback).toBe('synthetic-code');
  } finally { capture.close(); }
  const cancelled = await captureCallback('expected-state', controller.signal, 0);
  controller.abort();
  await expect(cancelled.callback).rejects.toThrow('cancelled');
  cancelled.close();
});

test('loopback denial renders the splash without reflecting provider input', async () => {
  const capture = await captureCallback('expected-state', new AbortController().signal, 0);
  try {
    const rejected = expect(capture.callback).rejects.toThrow('Authorization denied');
    const response = await fetch(`http://127.0.0.1:${capture.port}/callback?state=expected-state&error=%3Cscript%3Ealert(1)%3C/script%3E`);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Authorization could not finish');
    expect(html).not.toContain('<script>');
    await rejected;
  } finally { capture.close(); }
});

test('tokens and client registration persist only through SecretStore and are owner-bound', async () => {
  const secrets = memorySecrets();
  const provider = await loadProvider(secrets, 'robinhood:test', 'owner', 'connection', true);
  await provider.saveClientInformation({ client_id: 'synthetic-client' });
  await provider.saveTokens({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600 });
  const reloaded = await loadProvider(secrets, 'robinhood:test', 'owner', 'connection');
  expect(reloaded.tokens()?.access_token).toBe('synthetic-access');
  await reloaded.saveTokens({ access_token: 'rotated-access', token_type: 'Bearer', expires_in: 3600 });
  expect(reloaded.tokens()?.refresh_token).toBe('synthetic-refresh');
  await expect(loadProvider(secrets, 'robinhood:test', 'different-owner', 'connection')).rejects.toThrow('binding');
  await reloaded.invalidateCredentials('tokens');
  expect((await loadProvider(secrets, 'robinhood:test', 'owner', 'connection')).tokens()).toBeUndefined();
});

test('denied consent fails, and an occupied callback port does not open another listener', async () => {
  const signal = new AbortController().signal;
  const capture = await captureCallback('expected', signal, 0);
  try {
    await expect(captureCallback('other', signal, capture.port)).rejects.toThrow();
    await fetch(`http://127.0.0.1:${capture.port}/callback?state=expected&error=access_denied`);
    await expect(capture.callback).rejects.toThrow('denied');
  } finally { capture.close(); }
});

test('outbound requests reject non-Robinhood endpoints and redirects', async () => {
  for (const url of ['http://api.robinhood.com/', 'https://robinhood.com.attacker.test/', 'https://user@robinhood.com/', 'https://127.0.0.1/']) {
    expect(() => validateRobinhoodUrl(url)).toThrow();
  }
  const fetcher = vi.fn(async () => new Response('{}'));
  await robinhoodFetch(new AbortController().signal, fetcher)('https://api.robinhood.com/oauth2/token/');
  expect(fetcher.mock.calls[0][1].redirect).toBe('error');
});

test('account discovery normalizes, deduplicates, and keeps full account numbers out of metadata', () => {
  const accounts = parseAccounts({ results: [{ account_number: '12345678', agentic_allowed: true, type: 'cash', option_level:'option_level_2' }, { account_number: '12345678', agentic_allowed: true, type: 'cash', option_level:'option_level_2' }] });
  expect(accounts).toHaveLength(1);
  expect(accounts[0].maskedNumber).toBe('••••5678');
  expect(accounts[0].optionLevel).toBe('option_level_2');
  expect(JSON.stringify(accounts)).not.toContain('12345678');
});

test('real SDK performs PKCE exchange, account discovery and refresh with synthetic endpoints', async () => {
  // This fixture must never bind the real app's OAuth port.
  const originalCapture = loopback.captureCallback;
  let callbackPort = 0;
  const captureSpy = vi.spyOn(loopback, 'captureCallback').mockImplementation(async (state, signal) => {
    const capture = await originalCapture(state, signal, 0);
    callbackPort = capture.port;
    return capture;
  });
  const realFetch = globalThis.fetch;
  const secrets = memorySecrets();
  const provider = await loadProvider(secrets, 'robinhood:oauth-fixture', 'owner', 'connection', true);
  let challenge = '';
  let exchanges = 0;
  let refreshes = 0;
  let accountCalls = 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const metadata = { issuer: 'https://agent.robinhood.com/mcp/trading', authorization_endpoint: 'https://robinhood.com/oauth',
    token_endpoint: 'https://api.robinhood.com/oauth2/token/', registration_endpoint: 'https://agent.robinhood.com/oauth/trading/register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource: 'https://agent.robinhood.com/mcp/trading', authorization_servers: ['https://agent.robinhood.com/mcp/trading'], scopes_supported: ['internal'] });
    if (url.pathname.includes('oauth-authorization-server')) return json(metadata);
    if (url.pathname === '/oauth/trading/register') return json({ ...JSON.parse(String(init?.body)), client_id: 'synthetic-client' }, 201);
    if (url.pathname === '/oauth2/token/') {
      const params = new URLSearchParams(String(init?.body));
      if (params.get('grant_type') === 'authorization_code') {
        const { createHash } = await import('node:crypto');
        expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(challenge);
        expect(params.get('code')).toBe('synthetic-code');
        exchanges++;
        return json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 0, token_type: 'Bearer' });
      }
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('synthetic-refresh');
      refreshes++;
      return json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.pathname === '/mcp/trading') {
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (request.method === 'initialize') return json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
      expect(request.method).toBe('tools/call');
      expect(request.params.name).toBe('get_accounts');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer rotated-access');
      accountCalls++;
      return json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ account_number: '87654321', agentic_allowed: true }] }) }] } });
    }
    throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
  });
  try {
    await provider.authorize(new AbortController().signal, async value => {
      const url = new URL(value);
      challenge = url.searchParams.get('code_challenge')!;
      expect(challenge).toBeTruthy();
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.port = String(callbackPort);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set('code', 'synthetic-code');
      expect((await realFetch(callback)).status).toBe(200);
    });
    const reloaded = await loadProvider(secrets, 'robinhood:oauth-fixture', 'owner', 'connection');
    expect((await reloaded.accounts(new AbortController().signal))[0].maskedNumber).toBe('••••4321');
    expect(exchanges).toBe(1); expect(refreshes).toBe(1); expect(accountCalls).toBe(1);
    expect((await loadProvider(secrets, 'robinhood:oauth-fixture', 'owner', 'connection')).tokens()?.refresh_token).toBe('rotated-refresh');
  } finally { captureSpy.mockRestore(); vi.unstubAllGlobals(); }
});

test('429 Retry-After is exposed without retrying the request',async()=>{
 let calls=0,until=0;const before=Date.now();
 const request=robinhoodFetch(new AbortController().signal,async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'12'}});},value=>{until=value;});
 const response=await request('https://agent.robinhood.com/mcp/trading');
 expect(response.status).toBe(429);expect(calls).toBe(1);expect(until-before).toBeGreaterThanOrEqual(12000);
});
