import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,test} from 'vitest';
import {MixedInvestmentSummary} from '../../src/renderer/src/strategies/MixedInvestmentSummary';
import type {TakeAccountPlan} from '../../src/shared/strategy-account-plan';
import type {MixedExecution} from '../../src/shared/mixed-execution';
const plan:TakeAccountPlan={takeId:'take',strategyId:'strategy',draftRevision:'draft',revision:'rev',editable:false,reason:null,accounts:[
 {id:'cb',venue:'coinbase',label:'Opentake',available:true,disabledReason:null,otherTakeCount:0,balances:[{asset:'USDC',amount:'85.58'}]},
 {id:'rh',venue:'robinhood',label:'MCP',available:true,disabledReason:null,otherTakeCount:0,balances:[{asset:'USD',amount:'11.84'}]},
],routes:[{venue:'coinbase',accountId:'cb',assets:[{symbol:'BTC',bps:4000},{symbol:'ZEC',bps:3000}]},{venue:'robinhood',accountId:'rh',assets:[{symbol:'AAPL',bps:3000}]}]};
const run:MixedExecution={id:'run',takeId:'take',previewId:'preview',state:'running',legs:[{venue:'coinbase',accountId:'cb',operationId:'cbop',reference:'cbref',state:'completed',message:null},{venue:'robinhood',accountId:'rh',operationId:'rhop',reference:'rhref',state:'waiting_market',message:null}]};
test('grouped panel includes waiting cash in the total and shows the queued buy inline',()=>{
 const html=renderToStaticMarkup(createElement(MixedInvestmentSummary,{plan,run,onManage:()=>{},summaries:{
 coinbase:{value:'6.94',currency:'USD',gain:-0.06,positions:[{symbol:'BTC',name:'BTC',quantity:'0.00004673',price:'83666.86',value:'3.91'},{symbol:'ZEC',name:'ZEC',quantity:'0.00231264',price:'1266.84',value:'2.93'}],cash:[{currency:'USDC',value:'0.1'}]},
 robinhood:{value:'3',currency:'USD',gain:0,positions:[],cash:[{currency:'USD',value:'3'}],pendingBuys:[{symbol:'AAPL',amount:'3',expectedAt:null}]},
 }}));
 expect(html).toContain('aria-label="Manage Coinbase"');expect(html).toContain('aria-label="Manage Robinhood"');expect(html).toContain('aria-haspopup="dialog"');expect(html).toContain('items-baseline');
 expect(html).toContain('$9.94');expect(html).toContain('-$0.06 (-0.60%)');expect(html).toContain('39.3%');expect(html).toContain('USDC 85.58');expect(html).toContain('0% of 30%');expect(html).toContain('Buying $3.00');expect(html).toContain('waiting for market open');expect(html).toContain('$3.10');expect(html).toContain('Cash breakdown');expect(html).toContain('Includes cash held for pending buys');
 expect(html.indexOf('Opentake')).toBeLessThan(html.indexOf('BTC'));expect(html.indexOf('MCP')).toBeLessThan(html.indexOf('AAPL'));
 expect(html.match(/Your investment<\/p>/g)).toHaveLength(1);expect(html).not.toContain('role="tab"');
});
test('incomplete data stays unavailable and cancelled legs do not look like queued buys',()=>{
 const cancelled={...run,legs:run.legs.map(l=>({...l,state:'cancelled' as const}))};
 const html=renderToStaticMarkup(createElement(MixedInvestmentSummary,{plan,run:cancelled,summaries:{robinhood:{value:'3',currency:'USD',positions:[],cash:[{currency:'USD',value:'3',reserved:'0'}]}}}));
 expect(html).toContain('Loading holdings');expect(html).not.toContain('Buy queued');expect(html).not.toContain('pending buys');expect(html).not.toContain('0% of 30%');
});
