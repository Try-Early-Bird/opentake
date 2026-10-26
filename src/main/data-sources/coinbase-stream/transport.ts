import WebSocket, { type ClientOptions } from 'ws';
import { coinbaseStreamUrl, type PublicStreamTransport } from './session';
import { streamLimits } from './protocol';
/** Fixed public endpoint only. Injection is for fixture sockets, not user config.
 * ws enforces aggregate message size across fragments before message delivery;
 * compression is disabled so there is no decompression allocation path. */
export function createCoinbasePublicTransport(makeSocket: (url: string, options: ClientOptions) => WebSocket = (url, options) => new WebSocket(url, options)): PublicStreamTransport {
  return {
    connect(request, callbacks) {
      if (request.url !== coinbaseStreamUrl || !Number.isSafeInteger(request.maxFrameBytes) || request.maxFrameBytes < 1 || request.maxFrameBytes > streamLimits.frameBytes) throw Error('Invalid public stream transport');
      const socket = makeSocket(coinbaseStreamUrl, {
        maxPayload: request.maxFrameBytes, maxFragments: 1024, maxBufferedChunks: 4096,
        perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10_000,
        rejectUnauthorized: true, skipUTF8Validation: false,
      });
      let stopped = false;
      function stop() { if (stopped) return; stopped = true; socket.terminate(); }
      function fail() { if (stopped) return; stop(); callbacks.error(); }
      socket.on('open', () => { if (!stopped) callbacks.open(); });
      socket.on('message', (data, binary) => {
        if (stopped) return;
        if (binary) return fail();
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (bytes.byteLength > request.maxFrameBytes) return fail();
        callbacks.message(bytes.toString('utf8'));
      });
      socket.on('error', fail); // Never surface provider error text or headers.
      socket.on('close', () => { if (!stopped) { stopped = true; callbacks.close(); } });
      return {
        send(text) {
          if (stopped || socket.readyState !== WebSocket.OPEN || Buffer.byteLength(text) > 2048 || socket.bufferedAmount > 64 * 1024) throw Error('Public stream send unavailable');
          socket.send(text, error => { if (error) fail(); });
        },
        close: stop,
      };
    },
  };
}
