import {expect,test} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {InstructionCard,type StrategyInstruction} from '../../src/renderer/src/strategies/InstructionCard';
const instruction:StrategyInstruction={id:'test',kind:'partial_redemption',requestedAmount:'3',status:'open',pendingReason:null,waitingFor:'requested',symbols:['BTC'],expectedAt:null,cancellable:true,previewLegs:[]};
const render=(overrides:Partial<StrategyInstruction>={})=>renderToStaticMarkup(createElement(InstructionCard,{instruction:{...instruction,...overrides},currency:'USDC',busy:false,onCancel:()=>{},onConfirm:()=>{}}));
test('unsent withdrawal is pending without a scheduling or automatic execution promise',()=>{
 const html=render();expect(html).toContain('Pending');expect(html).toContain('Orders have not been submitted yet.');expect(html).not.toContain('scheduled');expect(html).not.toContain('automatically');expect(html).not.toContain('Cancel anytime');
});
test('submitted withdrawals show selling while genuine market waits remain scheduled',()=>{
 expect(render({waitingFor:'orders_pending'})).toContain('Selling');
 const scheduled=render({waitingFor:'market_closed'});expect(scheduled).toContain('Scheduled');expect(scheduled).not.toContain('Cancel anytime before then');
 expect(render({status:'settled',waitingFor:null})).toContain('Completed');
});
test('unsent withdrawal recovery has an explicit retry button',()=>{
 const html=renderToStaticMarkup(createElement(InstructionCard,{instruction:{...instruction,waitingFor:'retry_required'},currency:'USDC',busy:false,onCancel:()=>{},onConfirm:()=>{},onRetry:()=>{}}));
 expect(html).toContain('Didn’t start');expect(html).toContain('Retry withdrawal');expect(html).not.toContain('Pending');
});

test('action stays in the header and partial completion is shown in the body for both venues',()=>{
 for(const platform of ['Coinbase','Robinhood'] as const){
  const html=renderToStaticMarkup(createElement(InstructionCard,{instruction:{...instruction,kind:'subscription',status:'settled',pendingReason:'partial_completion',waitingFor:null},currency:'USD',platform,busy:false,onCancel:()=>{},onConfirm:()=>{}}));
  const header=html.match(/<header[^>]*>(.*?)<\/header>/s)![1];
  expect(header).toContain('Investment');expect(header).not.toContain('Partially completed');
  expect(html.slice(html.indexOf('</header>'))).toContain('Partially completed');
 }
});

test('mixed order results show the filled and unfilled assets in the action body',()=>{
 const html=render({kind:'subscription',status:'settled',pendingReason:'partial_completion',waitingFor:null,orders:[{symbol:'BTC',side:'buy',filledQuantity:'0.00005993',execution:{state:'filled',cancelState:'none'}},{symbol:'ZEC',side:'buy',filledQuantity:'0',execution:{state:'cancelled',cancelState:'requested'}}]});
 expect(html).toContain('BTC buy · Filled');expect(html).toContain('0.00005993 BTC bought.');expect(html).toContain('ZEC buy · Cancelled');expect(html).toContain('Nothing filled.');expect(html).not.toContain('See Activity');
});

test('resolved partial investment offers a cash-funded retry without promising a refund',()=>{
 const html=renderToStaticMarkup(createElement(InstructionCard,{instruction:{...instruction,kind:'subscription',status:'settled',pendingReason:'partial_completion',waitingFor:null,cancellable:false},currency:'USDC',busy:false,onCancel:()=>{},onConfirm:()=>{},onRetry:()=>{}}));
 expect(html).toContain('Retry investment');expect(html).toContain('unused cash remain in this Take');expect(html).not.toContain('Cancel to return');
});

test('detailed multi-asset steps distinguish accepted orders from unsent orders and label estimates',()=>{
 const html=render({kind:'rebalance',accountLabel:'Example account',venue:'Coinbase',waitingFor:'orders_pending',orders:[{symbol:'BTC',side:'sell',orderType:'market',estimatedValue:'1.93',estimatedPrice:'83060.15',estimatedFee:'0.02',currency:'USDC',execution:{state:'accepted',cancelState:'none'}},{symbol:'ETH',side:'sell',orderType:'market',estimatedValue:'2.5',currency:'USDC',execution:{state:'reserved',cancelState:'none'}}]});
 for(const text of ['Example account','1 of 2 orders accepted by Coinbase. 0 filled.','BTC market sell · Open','Estimated amount: 1.93 USDC','Estimated net proceeds: 1.91 USDC','ETH market sell · Not submitted'])expect(html).toContain(text);
 expect(html).not.toContain('Orders submitted. Waiting for fills');expect(html).not.toContain('estimated price');expect(html).not.toContain('estimated fee');
});

 test('filled order shows quantity once while partial fills retain planned amount',()=>{
 const order={symbol:'BTC',side:'sell' as const,orderType:'market' as const,quantity:'0.001',filledQuantity:'0.001',estimatedValue:'83',estimatedFee:'0.02',currency:'USDC',execution:{state:'filled' as const,cancelState:'none' as const}};
 const full=render({status:'settled',waitingFor:null,orders:[order]});
 expect(full.match(/0.001 BTC/g)).toHaveLength(1);expect(full).toContain('Estimated net proceeds: 82.98 USDC');
 const partial=render({waitingFor:'orders_pending',orders:[{...order,filledQuantity:'0.0005',execution:{state:'partially_filled',cancelState:'none'}}]});
 expect(partial).toContain('0.0005 BTC sold.');expect(partial).toContain('Amount: 0.001 BTC');
 });
