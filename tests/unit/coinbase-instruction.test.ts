import {expect,test} from 'vitest';
import {coinbaseInstruction} from '../../src/renderer/src/strategies/coinbase-instruction';
import type {CoinbaseOrderReview} from '../../src/shared/coinbase-orders';
const review=(state:CoinbaseOrderReview['state']='confirmed'):CoinbaseOrderReview=>({id:'review',takeId:'take',accountLabel:'Synthetic',takeTitle:'Take',quote:'USDC',phase:'buy',expiresAt:'',state,skipped:[],orders:[{product:'BTC-USDC',side:'buy',baseSize:'0.1',limitPrice:'100',notional:'10',fee:'0.1',previewId:'preview',debits:[],execution:{state:'accepted',cancelState:'none'}}]});
test('accepted Coinbase orders use a pending shared instruction, never completion',()=>{
 expect(coinbaseInstruction(review(),'10')).toMatchObject({status:'open',waitingFor:'orders_pending',requestedAmount:'10',cancellable:true});
 const value=review();value.orders[0].execution!.state='filled';
 expect(coinbaseInstruction(value,'10').status).toBe('open');
 value.state='settled';expect(coinbaseInstruction(value,'10')).toMatchObject({status:'settled',waitingFor:null,cancellable:false});
});
test('confirmation, unknown outcomes and cancellation remain distinct',()=>{
 const value=review('preview');delete value.orders[0].execution;
 expect(coinbaseInstruction(value,'10',true).waitingFor).toBe('awaiting_confirmation');
 value.state='confirmed';value.orders[0].execution={state:'unknown',cancelState:'none'};
 expect(coinbaseInstruction(value,'10')).toMatchObject({waitingFor:'reconciliation_required',cancellable:false});
 value.orders[0].execution={state:'accepted',cancelState:'requested'};
 expect(coinbaseInstruction(value,'10')).toMatchObject({waitingFor:'cancellation_pending',cancellable:false});
});
test('partial cancellations and rejections do not read as fully completed investments',()=>{
 const value=review('settled');value.orders[0].execution={state:'cancelled',cancelState:'requested'};
 expect(coinbaseInstruction(value,'10').status).toBe('cancelled');
 value.orders[0].filledQuantity='0.02';expect(coinbaseInstruction(value,'10')).toMatchObject({status:'settled',pendingReason:'partial_completion'});
 delete value.orders[0].filledQuantity;value.orders[0].execution.state='rejected';expect(coinbaseInstruction(value,'10').status).toBe('failed');
 value.withdrawal={requestedAmount:'5',estimatedProceeds:'4.9'};expect(coinbaseInstruction(value,null)).toMatchObject({kind:'partial_redemption',requestedAmount:'5'});
});
test('keep-all close is completed without inventing filled orders',()=>{
 const value=review('settled');value.orders=[];value.closed=true;value.withdrawal={close:true,requestedAmount:'10',estimatedProceeds:'0'};
 expect(coinbaseInstruction(value,null)).toMatchObject({kind:'full_exit',status:'settled',waitingFor:null,cancellable:false});
});
test('unsent withdrawal offers recovery after reload without retrying submitted or uncertain orders',()=>{
 const value=review();value.withdrawal={requestedAmount:'3',estimatedProceeds:'2.98'};value.orders[0].execution={state:'reserved',cancelState:'none'};
 expect(coinbaseInstruction(value,null).waitingFor).toBe('retry_required');
 expect(coinbaseInstruction(value,null,true).waitingFor).toBe('awaiting_confirmation');
 for(const state of ['accepted','unknown','partially_filled'] as const){value.orders[0].execution.state=state;expect(coinbaseInstruction(value,null).waitingFor).not.toBe('retry_required');}
});

test('closed review never hides an unresolved order or offers confirmation again',()=>{
 for(const state of ['cancelled','settled'] as const){
  const value=review(state);value.orders[0].execution={state:'unknown',cancelState:'none'};
  expect(coinbaseInstruction(value,null,true)).toMatchObject({status:'open',waitingFor:'reconciliation_required',cancellable:false});
 }
});
