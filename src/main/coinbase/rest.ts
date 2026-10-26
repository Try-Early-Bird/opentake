import { randomBytes, sign } from 'node:crypto';
import type { CoinbaseKey } from './key';
import { CoinbaseError } from './errors';

/** Main-process signed transport, exposed only through GET and fixed preview wrappers. */
function transport(key: CoinbaseKey, signal: AbortSignal, fetcher: typeof fetch, method: 'GET'|'POST', body?:unknown) {
  return async (path: string, query = new URLSearchParams()) => {
      signal.throwIfAborted();
      const seconds = Math.floor(Date.now()/1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = encode({alg:'ES256',typ:'JWT',kid:key.name,nonce:randomBytes(16).toString('hex')}) + '.' +
        encode({sub:key.name,iss:'cdp',nbf:seconds,exp:seconds+120,uri:`${method} api.coinbase.com${path}`});
      const token = unsigned + '.' + sign('sha256',Buffer.from(unsigned),{key:key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
      const response = await fetcher(`https://api.coinbase.com${path}?${query}`, {method,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal,
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'CB-VERSION':'2019-08-15'}});
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new CoinbaseError('authentication'); }
      if (!response.ok) { await response.body?.cancel(); throw new CoinbaseError('provider'); }
      const reader = response.body?.getReader(); if (!reader) throw new CoinbaseError('provider');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const chunk=await reader.read(); if(chunk.done)break; size+=chunk.value.length;
        if(size>2_000_000) {await reader.cancel();throw new CoinbaseError('provider');} chunks.push(chunk.value); }
        return JSON.parse(Buffer.concat(chunks).toString());
      } finally {reader.releaseLock();}
  };
}

export function coinbaseGet(key:CoinbaseKey,signal:AbortSignal,fetcher:typeof fetch=fetch){return transport(key,signal,fetcher,'GET');}
/** Sole POST capability here is a non-submitting preview; callers cannot choose its URL. */
export function coinbasePreviewPost(key:CoinbaseKey,signal:AbortSignal,body:unknown,fetcher:typeof fetch=fetch){
 return transport(key,signal,fetcher,'POST',body)('/api/v3/brokerage/orders/preview');
}

/** Fixed order-write endpoints, usable only by the governed main-process dispatcher. */
export function coinbaseOrderPost(key:CoinbaseKey,signal:AbortSignal,body:unknown,fetcher:typeof fetch=fetch){
 return transport(key,signal,fetcher,'POST',body)('/api/v3/brokerage/orders');
}
export function coinbaseCancelPost(key:CoinbaseKey,signal:AbortSignal,body:unknown,fetcher:typeof fetch=fetch){
 return transport(key,signal,fetcher,'POST',body)('/api/v3/brokerage/orders/batch_cancel');
}

/** Supplement fields omitted by the pinned MCP product response. */
export function coinbaseProductGet(key:CoinbaseKey,signal:AbortSignal,product:string){
 if(!/^[A-Z0-9._]+-[A-Z0-9._]+$/.test(product)||product.length>81)throw new CoinbaseError('provider');
 return coinbaseGet(key,signal)(`/api/v3/brokerage/products/${product}`);
}

/** Position-cost fields omitted by the pinned MCP portfolio response. */
export function coinbasePortfolioGet(key:CoinbaseKey,signal:AbortSignal,portfolio:string){
 if(!/^[0-9a-f-]{36}$/i.test(portfolio))throw new CoinbaseError('scope');
 return coinbaseGet(key,signal)(`/api/v3/brokerage/portfolios/${portfolio}`);
}
