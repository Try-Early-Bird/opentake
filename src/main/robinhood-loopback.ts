import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const redirectUrl = 'http://127.0.0.1:3119/callback';

// Same callback splash treatment as the original desktop app. Only static copy
// is rendered: never echo authorization codes, state, or provider error text.
function callbackPage(ok: boolean): string {
  const title = ok ? 'Authorization received' : 'Authorization could not finish';
  const body = ok ? 'You can close this tab and return to Earlybird-Opentake to finish connecting.'
    : 'Return to Earlybird-Opentake and try signing in again.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Earlybird-Opentake</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8eaed}
  .card{max-width:34rem;margin:1rem;padding:2.5rem;border-radius:1rem;background:#15181d;
        border:1px solid #262b33;text-align:center}
  h1{margin:0 0 .75rem;font-size:1.35rem;color:${ok ? '#6ee7a8' : '#f87171'}}
  p{margin:0;color:#9aa3ad}
</style></head><body><main class="card"><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

const pageHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
  'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };

export async function captureCallback(expectedState: string, signal: AbortSignal, port = 3119) {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  const callback = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // The listener can fail before the caller begins awaiting the callback.
  void callback.catch(() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const state = url.searchParams.get('state') ?? '';
    const validState = Buffer.byteLength(state) === Buffer.byteLength(expectedState) &&
      timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));
    const issuer = url.searchParams.get('iss');
    if (request.method !== 'GET' || url.pathname !== '/callback' || !validState || url.searchParams.getAll('state').length !== 1 ||
      (issuer !== null && (issuer !== 'https://agent.robinhood.com/mcp/trading' || url.searchParams.getAll('iss').length !== 1))) {
      response.writeHead(400, pageHeaders).end(callbackPage(false));
      return;
    }
    const code = url.searchParams.get('code');
    const denied = url.searchParams.has('error') || !code || code.length > 8192 || url.searchParams.getAll('code').length !== 1;
    response.writeHead(denied ? 400 : 200, pageHeaders).end(callbackPage(!denied));
    if (denied) reject(new Error('Authorization denied'));
    else resolve(code);
    server.close();
  });
  server.requestTimeout = 10_000;
  const abort = () => { reject(new Error('Authorization cancelled')); server.close(); server.closeAllConnections(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
    signal.throwIfAborted();
  } catch (error) { abort(); signal.removeEventListener('abort', abort); throw error; }
  const address = server.address();
  return { callback, port: typeof address === 'object' && address ? address.port : port,
    close: () => { signal.removeEventListener('abort', abort); server.close(); server.closeAllConnections(); } };
}
