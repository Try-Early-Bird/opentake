import {describe,expect,test} from 'vitest';
import {classifyRobinhoodCryptoSubmission as classify,classifyRobinhoodCryptoCancellation as cancel,
 recoverRobinhoodCryptoOrder as recover,type CryptoSubmissionScope,type CryptoPendingApproval,type CryptoSubmissionResult} from '../../src/main/orders/robinhood-crypto-adapter';
import {dispatchOrder} from '../../src/main/trading/dispatch';
const scope:CryptoSubmissionScope={accountId:'local-account',accountNumber:'ALPHA',cryptoAccountNumber:'CRYPTO',clientRef:'client-1',symbol:'BTC-USD',
 order:{currency_pair_id:'pair-1',side:'buy',type:'limit',quantity:'0.001',limit_price:'50000'}};
const order={id:'order-1',ref_id:'client-1',currency_pair_id:'pair-1',side:'buy',type:'limit',time_in_force:'gtc',quantity:'0.001',cumulative_quantity:'0',state:'queued',limit_price:'50000',speculative:false};
const approval={approval_id:'approval-1',account_number:'ALPHA',asset_class:'ASSET_CLASS_CRYPTO',state:'APPROVAL_STATE_PENDING',is_edited:false,
 proposed_order:{asset_class:'ASSET_CLASS_CRYPTO',symbol:'BTC-USD',side:'buy',order_type:'limit',time_in_force:'gtc',quantity:'0.001',limit_price:{amount:'50000',currency_code:'USD'}}};
const response=(data:unknown)=>({isError:false,errorCategory:null,data:{data,guide:'Untrusted provider text'}});
const placed=(overrides:Record<string,unknown>={})=>response({order:{...order,...overrides},crypto_account_number:'CRYPTO'});
const pending=(overrides:Record<string,unknown>={})=>response({approval:{...approval,...overrides}});
describe('Robinhood crypto submission evidence',()=>{
 test('acceptance means an exact bound order, never a fill',()=>{
  const result=classify(placed(),scope);
  expect(result).toMatchObject({state:'accepted',providerRef:'order-1'});
  expect(JSON.stringify(result)).not.toContain('Untrusted');
  expect(JSON.stringify(result)).not.toContain('CRYPTO');
 });
 test.each([{ref_id:'other'},{currency_pair_id:'other'},{side:'sell'},{quantity:'0.002'},{limit_price:'50001'},
  {speculative:true},{cumulative_quantity:'0.002'},{time_in_force:'gfd'}])('rejects contradictory order identity %j',patch=>{
  expect(classify(placed(patch),scope).state).toBe('unknown');
 });
 test('fails closed for empty, conflicting, unbound and equity-style envelopes',()=>{
  for(const raw of [response({}),response({order,approval,crypto_account_number:'CRYPTO'}),response({order}),response({order,crypto_account_number:'OTHER'}),
   {isError:false,errorCategory:null,data:{id:'order-1'}}])expect(classify(raw,scope).state).toBe('unknown');
 });
 test('persists a pending approval separately and strips account identifiers',()=>{
  const result=classify(pending(),scope);
  expect(result).toEqual({state:'approval_pending',approvalRef:'approval-1',evidence:{approvalRef:'approval-1',state:'APPROVAL_STATE_PENDING',isEdited:false}});
 });
 test.each([{account_number:'OTHER'},{asset_class:'ASSET_CLASS_EQUITY'},
  {proposed_order:{...approval.proposed_order,symbol:'BCH-USD'}},{proposed_order:{...approval.proposed_order,quantity:'0.002'}}])('does not bind an unrelated approval %j',patch=>{
  expect(classify(pending(patch),scope).state).toBe('unknown');
 });
 test('approved or edited approval awaits reconciliation; only provider-declined/expired is rejected',()=>{
  for(const state of ['APPROVAL_STATE_APPROVED','APPROVAL_STATE_AUTO_APPROVED','unexpected'])expect(classify(pending({state}),scope).state).toBe('unknown');
  expect(classify(pending({is_edited:true}),scope).state).toBe('unknown');
  expect(classify(pending({state:'APPROVAL_STATE_DECLINED'}),scope)).toMatchObject({state:'rejected',code:'approval_declined'});
  expect(classify(pending({state:'APPROVAL_STATE_EXPIRED'}),scope)).toMatchObject({state:'rejected',code:'approval_expired'});
 });
 test('tool failure is uncertain except a definitive invalid request',()=>{
  expect(classify({...placed(),isError:true,errorCategory:'timeout'},scope).state).toBe('unknown');
  expect(classify({isError:true,errorCategory:'invalid_request',data:{}},scope).state).toBe('rejected');
  expect(classify({...placed(),isError:true,errorCategory:'invalid_request'},scope).state).toBe('unknown');
 });
 test('dollar orders permit derived quantity but approvals must match the reviewed USD amount',()=>{
  const dollarScope={...scope,order:{currency_pair_id:'pair-1',side:'buy' as const,type:'market' as const,dollar_amount:'50.00'}};
  expect(classify(placed({type:'market',limit_price:null}),dollarScope).state).toBe('accepted');
  const proposed={...approval.proposed_order,order_type:'market',quantity:undefined,limit_price:null,dollar_amount:{amount:'50',currency_code:'USD'}};
  expect(classify(pending({proposed_order:proposed}),dollarScope).state).toBe('approval_pending');
  expect(classify(pending({proposed_order:{...proposed,dollar_amount:{amount:'50',currency_code:'USDC'}}}),dollarScope).state).toBe('unknown');
 });
});
test('recovery binds either client or approval reference and refuses missing, foreign, edited or ambiguous evidence',()=>{
 const batch=(orders:unknown[])=>({accountId:scope.accountId,orders});
 const approved={approvalRef:'approval-1',approval:{...approval,state:'APPROVAL_STATE_APPROVED'}};
 expect(recover(scope,batch([]),approved)).toBeNull();
 expect(recover(scope,batch([order]))?.providerRef).toBe('order-1');
 expect(recover(scope,batch([{...order,ref_id:'approval-1'}]),approved)?.providerRef).toBe('order-1');
 expect(recover(scope,batch([{...order,ref_id:'unrelated'}]),approved)).toBeNull();
 expect(()=>recover(scope,{accountId:'other',orders:[order]})).toThrow('account mismatch');
 expect(()=>recover(scope,batch([{...order,ref_id:'approval-1'}]),{...approved,approval:{...approved.approval,is_edited:true}})).toThrow('requires reconciliation');
 expect(()=>recover(scope,batch([{...order,ref_id:'approval-1'}]),{...approved,approval})).toThrow('requires reconciliation');
 expect(()=>recover(scope,batch([{...order,ref_id:'approval-1',quantity:'0.002'}]),approved)).toThrow('reviewed terms');
 expect(()=>recover(scope,batch([order,{...order,id:'order-2',ref_id:'approval-1'}]),approved)).toThrow('Ambiguous');
});
test('cancel accepted is only requested; missing/error evidence never confirms cancellation',()=>{
 expect(cancel(response({accepted:true}))).toBe('requested');
 expect(cancel(response({accepted:false}))).toBe('rejected');
 expect(cancel(response({}))).toBe('unknown');
 expect(cancel({...response({}),isError:true,errorCategory:'timeout'})).toBe('unknown');
});
test('shared durable dispatch records approval once under simultaneous confirmation',async()=>{
 let claimed=false,sends=0;const records:CryptoSubmissionResult[]=[];
 const journal={claim:async()=>{if(claimed)throw Error('Already attempted');claimed=true;},record:async(result:CryptoSubmissionResult)=>{records.push(result);},unknown:async()=>{throw Error('Unexpected uncertainty');}};
 const run=()=>dispatchOrder<unknown,CryptoPendingApproval>({send:async before=>{await before();sends++;return classify(pending(),scope);}},journal);
 const results=await Promise.allSettled([run(),run()]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(sends).toBe(1);
 expect(records).toHaveLength(1);expect(records[0].state).toBe('approval_pending');
});
test('lost approval response or failed persistence remains uncertain and is never retried',async()=>{
 for(const failure of ['transport','persistence']){
  let claimed=false,sends=0;const codes:string[]=[];
  const run=()=>dispatchOrder<unknown,CryptoPendingApproval>({send:async before=>{await before();sends++;if(failure==='transport')throw Error('Socket reset');return classify(pending(),scope);}},
   {claim:async()=>{if(claimed)throw Error('Already attempted');claimed=true;},record:async()=>{throw Error('Disk unavailable');},unknown:async code=>{codes.push(code);}});
  expect((await run()).state).toBe('unknown');await expect(run()).rejects.toThrow('Already attempted');
  expect(sends).toBe(1);expect(codes).toEqual([failure==='transport'?'transport_error':'persistence_error']);
 }
});

import {reconcileRobinhoodCryptoEvidence as reconcile} from '../../src/main/orders/robinhood-crypto-adapter';
const readEvidence=(state='APPROVAL_STATE_APPROVED',orders:unknown[]=[{...order,ref_id:'approval-1'}])=>({accountId:scope.accountId,complete:true,orders,approvals:[{...approval,state}]});
test('approved submissions retain their approval reference until the actual order arrives',()=>{
 expect(classify(pending({state:'APPROVAL_STATE_APPROVED'}),scope)).toMatchObject({state:'unknown',approvalRef:'approval-1'});
 expect(reconcile(scope,readEvidence(),'approval-1')).toMatchObject({state:'accepted',providerRef:'order-1',approvalRef:'approval-1'});
 expect(reconcile(scope,readEvidence('APPROVAL_STATE_APPROVED',[]),'approval-1')).toMatchObject({state:'unknown',code:'order_not_observed'});
});
test('only a matching terminal approval without conflicting orders proves rejection',()=>{
 for(const state of ['APPROVAL_STATE_DECLINED','APPROVAL_STATE_EXPIRED']){
  expect(reconcile(scope,readEvidence(state,[]),'approval-1').state).toBe('rejected');
  expect(reconcile(scope,readEvidence(state),'approval-1').state).toBe('unknown');
 }
 expect(reconcile(scope,readEvidence('APPROVAL_STATE_PENDING',[]),'approval-1').state).toBe('approval_pending');
 expect(reconcile(scope,readEvidence('APPROVAL_STATE_PENDING'),'approval-1').state).toBe('unknown');
});
test('incomplete, foreign, absent, duplicate and edited approval evidence never releases cash',()=>{
 const base=readEvidence('APPROVAL_STATE_DECLINED',[]);
 for(const value of [{...base,complete:false},{...base,accountId:'other'},{...base,approvals:[]},
  {...base,approvals:[...base.approvals,...base.approvals]},
  {...base,approvals:[{...base.approvals[0],is_edited:true}]},
  {...base,approvals:[{...base.approvals[0],account_number:'other'}]}])expect(reconcile(scope,value,'approval-1').state).toBe('unknown');
});


test('rejected submissions retain only recognized reason codes and never raw provider data',()=>{
 for(const [data,code] of [
  [{error:{message:'Insufficient buying power for synthetic account 123'}},'buying_power'],
  [[{error:'No crypto account found'},'guide text'],'crypto_account_missing'],
  [{data:{errors:{limit_price:['Price must be a multiple of 0.01']}}},'price_increment'],
 ] as const){
  const result=classify({isError:true,errorCategory:'invalid_request',data},scope);
  expect(result).toMatchObject({state:'rejected',code:'provider_invalid_request_'+code});
  expect(JSON.stringify(result)).not.toContain('Untrusted');
 }
 for(const data of [{error:'synthetic secret unknown failure'},{guide:'insufficient buying power'},{error:['insufficient funds','account is restricted']}]){
  expect(classify({isError:true,errorCategory:'invalid_request',data},scope)).toMatchObject({state:'rejected',code:'provider_invalid_request'});
 }
 expect(classify({...placed(),isError:true,errorCategory:'invalid_request',data:{data:{order},error:'insufficient funds'}},scope).state).toBe('unknown');
 expect(classify({isError:true,errorCategory:'internal_error',data:{error:'insufficient funds'}},scope).state).toBe('unknown');
});


test('MCP text error details survive structured-content precedence without persisting raw identifiers',async()=>{
 const {cryptoErrorDetails,cryptoRejectionDiagnostic}=await import('../../src/main/orders/crypto-rejection');
 const raw={structuredContent:{data:{}},content:[{type:'text',text:JSON.stringify({error:'Limit price is too low for account SECRET-12345 token abcdefghijkl https://private.example'})}]};
 const errorDetails=cryptoErrorDetails(raw);
 const result=classify({isError:true,errorCategory:'invalid_request',data:raw.structuredContent,errorDetails},scope);
 expect(result).toMatchObject({state:'rejected',code:'provider_invalid_request_price_bounds',evidence:{rejectionDiagnostic:expect.stringContaining('Limit price is too low')}});
 for(const value of ['abcdefghijkl','private.example'])expect(JSON.stringify(result)).not.toContain(value);
 expect(cryptoRejectionDiagnostic({message:'Order quantity has unexpected precision'})).toBe('Order quantity has unexpected precision');
 expect(cryptoRejectionDiagnostic({guide:'insufficient funds'})).toBeNull();
});


test('broker restriction explanations retain their full wording while credential fields stay hidden',async()=>{
 const {cryptoRejectionDiagnostic}=await import('../../src/main/orders/crypto-rejection');
 const message='API error: Cryptocurrency trading is not available to residents of Example State.';
 expect(cryptoRejectionDiagnostic({error:message})).toBe(message);
 expect(cryptoRejectionDiagnostic({message:'Account RHC123 is restricted',access_token:'synthetic-secret'})).toBe('Account RHC123 is restricted');
 const result=cryptoRejectionDiagnostic({error:'Authorization Bearer fake.secret.token access_token="synthetic-access" password=synthetic-password'});
 for(const secret of ['fake.secret.token','synthetic-access','synthetic-password'])expect(result).not.toContain(secret);
});
