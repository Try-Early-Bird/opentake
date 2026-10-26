import {expect,test} from 'vitest';
import {generateKeyPairSync} from 'node:crypto';
import {coinbaseGet,coinbasePreviewPost,coinbaseOrderPost,coinbaseCancelPost} from '../../src/main/coinbase/rest';
test('preview transport signs the fixed POST route and GET signing remains unchanged',async()=>{
 const key={name:'organizations/synthetic/apiKeys/preview',privateKey:generateKeyPairSync('ec',{namedCurve:'prime256v1',privateKeyEncoding:{type:'sec1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey};
 const calls:{url:string;method:string;uri:string;body:unknown}[]=[];
 const fetcher=(async(url:unknown,init:RequestInit)=>{
  const token=(init.headers as Record<string,string>).Authorization.split(' ')[1];
  const payload=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
  calls.push({url:String(url),method:init.method!,uri:payload.uri,body:init.body});
  expect(init.redirect).toBe('error');return new Response(JSON.stringify({ok:true}));
 }) as typeof fetch;
 const signal=new AbortController().signal;
 await coinbasePreviewPost(key,signal,{product_id:'BTC-USDC'},fetcher);
 await coinbaseGet(key,signal,fetcher)('/api/v3/brokerage/products/BTC-USDC');
 expect(calls[0]).toMatchObject({method:'POST',uri:'POST api.coinbase.com/api/v3/brokerage/orders/preview',body:'{"product_id":"BTC-USDC"}'});
 expect(calls[1]).toMatchObject({method:'GET',uri:'GET api.coinbase.com/api/v3/brokerage/products/BTC-USDC',body:undefined});
 await coinbaseOrderPost(key,signal,{client_order_id:'synthetic'},fetcher);
 await coinbaseCancelPost(key,signal,{order_ids:['synthetic']},fetcher);
 expect(calls[2]).toMatchObject({method:'POST',uri:'POST api.coinbase.com/api/v3/brokerage/orders',body:'{"client_order_id":"synthetic"}'});
 expect(calls[3]).toMatchObject({method:'POST',uri:'POST api.coinbase.com/api/v3/brokerage/orders/batch_cancel',body:'{"order_ids":["synthetic"]}'});
 expect(calls[0].url).toBe('https://api.coinbase.com/api/v3/brokerage/orders/preview?');
});

import {parseSubmission} from '../../src/main/coinbase/dispatch-contract';
test('submission responses require exact identity and distinguish rejection from ambiguity',()=>{
 const request={product:'BTC-USDC',side:'buy' as const,baseSize:'0.01',limitPrice:'100',notional:'1',clientRef:'11111111-1111-4111-8111-111111111111',previewId:'synthetic-preview'};
 const success={success:true,success_response:{order_id:'one',product_id:'BTC-USDC',side:'BUY',client_order_id:request.clientRef}};
 expect(parseSubmission(success,request)).toEqual({state:'accepted',providerRef:'one'});
 expect(()=>parseSubmission({...success,success_response:{...success.success_response,client_order_id:'foreign'}},request)).toThrow('Uncertain');
 expect(parseSubmission({success:false,error_response:{error:'INSUFFICIENT_FUND'}},request)).toEqual({state:'rejected'});
 expect(()=>parseSubmission({success:false,error_response:{error:'UNKNOWN_FAILURE_REASON'}},request)).toThrow('Uncertain');
 expect(()=>parseSubmission({success:false,error_response:{error:'DUPLICATE_CLIENT_ORDER_ID'}},request)).toThrow('Uncertain');
 expect(()=>parseSubmission({...success,success:false,error_response:{error:'INSUFFICIENT_FUND'}},request)).toThrow('Uncertain');
});
