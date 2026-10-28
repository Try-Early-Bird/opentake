import {test,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {cryptoRpcReply} from '../../../src/main/orders/crypto-rpc';
import {startHostRpc,hostCall} from '../../../src/main/host-rpc';
import {ConnectionFailure} from '../../../src/main/connection-errors';

test('crypto review errors survive the host boundary without claiming the host is unavailable',async()=>{
 const profile=await mkdtemp(join(tmpdir(),'crypto-rpc-'));
 const host=await startHostRpc(profile,'synthetic',async method=>method==='host:status'?{ready:true}:cryptoRpcReply('review',async()=>{throw Error('Robinhood read failed');}));
 try{
  expect(await hostCall(host.manifest,'orders:crypto',[{action:'review'}],randomUUID())).toEqual({ok:false,message:'Robinhood could not complete the crypto account or preview request. Check the connection and order details. This review did not submit an order.'});
  expect(await hostCall(host.manifest,'host:status',[],randomUUID())).toEqual({ready:true});
 }finally{await host.close();await rm(profile,{recursive:true,force:true});}
});
test('crypto errors expose only approved text and never suggest resubmission after confirmation failure',async()=>{
 for(const error of [Error('synthetic-private-token'),{message:'synthetic-private-token'},new ConnectionFailure('reauth_required')]){
  const result=await cryptoRpcReply('confirm',async()=>{throw error;});
  expect(JSON.stringify(result)).not.toContain('synthetic-private-token');expect(result).toMatchObject({ok:false,message:expect.stringContaining('do not submit a replacement')});
 }
 expect(await cryptoRpcReply('review',async()=>{throw new ConnectionFailure('storage_locked');})).toMatchObject({ok:false,message:expect.stringContaining('Sign in to Robinhood again')});
 expect(await cryptoRpcReply('review',async()=>({enabled:true,orders:[]}))).toEqual({ok:true,value:{enabled:true,orders:[]}});
});

test('Robinhood errors identify the failed read and allow only recognized metadata',async()=>{
 const {RobinhoodReadFailure}=await import('../../../src/main/robinhood-read-error');
 for(const [operation,label] of [['get_accounts','account lookup'],['get_currency_pairs','crypto market lookup'],['preview_crypto_order','crypto order preview']]){
  const result=await cryptoRpcReply('review',async()=>{throw new RobinhoodReadFailure(operation,'invalid_request');});
  expect(result).toMatchObject({ok:false,message:expect.stringContaining(label)});
  expect(result).toMatchObject({message:expect.stringContaining('rejected the request parameters')});
 }
 const unknown=await cryptoRpcReply('review',async()=>{throw new RobinhoodReadFailure('synthetic-secret-operation','synthetic-secret-category');});
 expect(JSON.stringify(unknown)).not.toContain('synthetic-secret');
 expect(unknown).toMatchObject({message:expect.stringContaining('did not supply a recognized error category')});
});

test('review reports connection and storage stages without leaking unknown failure values',async()=>{
 const {cryptoReviewStep}=await import('../../../src/main/orders/crypto-review-error');
 const failed=(stage:any,error:unknown)=>cryptoRpcReply('review',()=>cryptoReviewStep(stage,async()=>{throw error;}));
 expect(await failed('provider',Object.assign(Error('private-url'),{cause:{code:'ECONNRESET'}}))).toMatchObject({message:expect.stringContaining('network connection was reset')});
 expect(await failed('save',Object.assign(Error('private-query'),{code:'23514'}))).toMatchObject({message:expect.stringContaining('constraint was not satisfied')});
 const result=await failed('account',Object.assign(Error('private-content'),{code:'private-code'}));
 expect(result).toMatchObject({message:expect.stringContaining('checking the selected account')});expect(JSON.stringify(result)).not.toContain('private-');
});


test('preview price failures report only validated requested and returned prices',async()=>{
 const {CryptoPreviewPriceMismatch}=await import('../../../src/main/orders/crypto-preview-price');
 const result=await cryptoRpcReply('review',async()=>{throw new CryptoPreviewPriceMismatch('90000',null,'89999');});
 expect(result).toMatchObject({ok:false,message:expect.stringContaining('Returned limit_price: missing; price: $89999')});
 expect(result).toMatchObject({message:expect.stringContaining('your $90000 limit')});
 expect(result).toMatchObject({message:expect.stringContaining('This review did not submit an order')});
 expect(()=>new CryptoPreviewPriceMismatch('90000','private-provider-text',null)).toThrow();
});
