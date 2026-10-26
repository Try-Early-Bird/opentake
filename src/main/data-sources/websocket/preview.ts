import { randomUUID } from 'node:crypto';
import type { createSourceWebsocketTransport } from './transport';
/** One bounded post-subscription message, no storage or retained connection. */
export function previewWebsocket(transport: ReturnType<typeof createSourceWebsocketTransport>, connection: unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false, close: (() => void) | undefined;
    const timer = setTimeout(() => finish(false), 35_000);
    function finish(ok: boolean, body?: unknown) {
      if (done) return; done = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      controller.abort(); close?.();
      if (ok) resolve(body); else reject(Error('WebSocket preview failed; check connection, acknowledgment and incoming data'));
    }
    function cancel() { finish(false); }
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try {
      close = transport.connect(`preview:${randomUUID()}`, connection, controller.signal, {
        ready() {}, data: body => finish(true, body), failed: () => finish(false),
      }).close;
      if (done) close();
    } catch { finish(false); }
  });
}
