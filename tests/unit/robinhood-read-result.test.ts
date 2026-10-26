import {test,expect} from 'vitest';
import {robinhoodReadData,robinhoodReadCall} from '../../src/main/robinhood-read-result';
import {cryptoRpcReply} from '../../src/main/orders/crypto-rpc';
import {cryptoReviewStep} from '../../src/main/orders/crypto-review-error';

test('read transport accepts JSON plus a prose guide and prefers structured data',()=>{
 const payload={data:{order:{quantity:'0.00005'}}};
 expect(robinhoodReadData({content:[{type:'text',text:JSON.stringify(payload)},{type:'text',text:'Provider guide: ask for confirmation next.'}]},'preview_crypto_order')).toEqual(payload);
 expect(robinhoodReadData({structuredContent:payload,content:[{type:'text',text:'arbitrary text'}]},'preview_crypto_order')).toEqual(payload);
 expect(robinhoodReadData({content:[{type:'text',text:'{"results":[]}'}]},'get_accounts')).toEqual({results:[]});
});
test('malformed JSON data and prose-only responses fail closed without returning provider content',()=>{
 for(const content of [[{type:'text',text:'private-provider-text'}],[{type:'text',text:'{"data":{}'},{type:'text',text:'{"data":{}}'}]]){
  try{robinhoodReadData({content},'preview_crypto_order');throw Error('should fail');}catch(e){expect((e as Error).message).toBe('Robinhood read failed');}
 }
});
test('SDK errors raised before tool responses retain safe operation and protocol classification',async()=>{
 for(const [code,reason] of [[-32602,'schema validation'],[-32601,'did not recognize'],[-32001,'timed out'],[401,'authorization']] as const){
  const reply=await cryptoRpcReply('review',()=>cryptoReviewStep('provider',async()=>{
   await robinhoodReadCall('preview_crypto_order',async()=>{throw Object.assign(Error('private-server-content'),{code});});return {enabled:true,orders:[]};
  }));
  expect(reply).toMatchObject({ok:false,message:expect.stringContaining('crypto order preview')});
  expect(reply).toMatchObject({message:expect.stringContaining(reason)});expect(JSON.stringify(reply)).not.toContain('private-server-content');
 }
});
