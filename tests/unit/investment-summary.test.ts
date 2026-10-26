import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,test} from 'vitest';
import {InvestmentSummary} from '../../src/renderer/src/strategies/InvestmentSummary';
test('investment holdings display unit prices and actual weights including cash in the denominator',()=>{
 const html=renderToStaticMarkup(createElement(InvestmentSummary,{value:'100',currency:'USD',positions:[{symbol:'BTC',name:'BTC',quantity:'0.001',price:'60000',value:'60'}],cash:[{currency:'USD',value:'40'}]}));
 expect(html).toContain('60,000.00');expect(html).toContain('60.0%');expect(html).toContain('0.001');expect(html).toContain('$60.00');expect(html).toContain('40.0%');expect(html).toContain('USD held in the take');expect(html).not.toContain('<table');
 const unknown=renderToStaticMarkup(createElement(InvestmentSummary,{value:null,currency:'USD',positions:[{symbol:'BTC',name:'BTC',quantity:'0.001'}],cash:[{currency:'USD',value:'40'}]}));
 expect(unknown).not.toContain('0.0%');expect(unknown).toContain('—');
});

test('combined holdings show one total, whole-Take weights and account labels',async()=>{
 const {combineInvestmentSummaries}=await import('../../src/renderer/src/strategies/mixed-summary');
 const data=combineInvestmentSummaries([
  {account:'Opentake · Coinbase',data:{value:'7',currency:'USD',gain:0.1,returnPercent:2,positions:[{symbol:'BTC',name:'BTC',quantity:'0.00005',value:'4'},{symbol:'ZEC',name:'ZEC',quantity:'0.002',value:'3'}],cash:[]}},
  {account:'MCP · Robinhood',data:{value:'3',currency:'USD',gain:0,returnPercent:0,positions:[],cash:[{currency:'USD',value:'3'}]}},
 ],true);
 expect(data.value).toBe('10');expect(data.gain).toBe(0.1);expect(data.returnPercent).toBeCloseTo(0.1/9.9*100);
 const html=renderToStaticMarkup(createElement(InvestmentSummary,data));
 expect(html.match(/Your investment/g)).toHaveLength(1);expect(html).toContain('$10.00');expect(html).toContain('40.0%');expect(html).toContain('Opentake · Coinbase');expect(html).toContain('MCP · Robinhood');
});

test('combined totals stay unavailable for missing accounts or incompatible valuations',async()=>{
 const {combineInvestmentSummaries}=await import('../../src/renderer/src/strategies/mixed-summary');
 const parts=[{account:'Coinbase',data:{value:'7',currency:'USDC',gain:1,positions:[],cash:[{currency:'USDC',value:'7'}]}}];
 expect(combineInvestmentSummaries(parts,true)).toMatchObject({value:null,gain:null,cash:[{value:null}]});
 expect(combineInvestmentSummaries([{account:'Robinhood',data:{...parts[0].data,currency:'USD'}}],false).value).toBeNull();
});

test('venue summaries are suppressed inside a unified investment collector',async()=>{
 const {InvestmentSummaryCollector}=await import('../../src/renderer/src/strategies/InvestmentSummary');
 const html=renderToStaticMarkup(createElement(InvestmentSummaryCollector.Provider,{value:()=>{}},createElement(InvestmentSummary,{value:'7',currency:'USD',positions:[],cash:[]})));
 expect(html).toBe('');
});


test('combined P&L percentage uses total net investment instead of averaging venue percentages',async()=>{
 const {combineInvestmentSummaries}=await import('../../src/renderer/src/strategies/mixed-summary');
 const result=combineInvestmentSummaries([
  {account:'Coinbase',data:{value:'110',gain:10,returnPercent:10,currency:'USD',positions:[],cash:[]}},
  {account:'Robinhood',data:{value:'900',gain:0,returnPercent:0,currency:'USD',positions:[],cash:[]}},
 ],true);
 expect(result.gain).toBe(10);expect(result.returnPercent).toBe(1);
 expect(combineInvestmentSummaries([{account:'closed',data:{value:'1',gain:1,currency:'USD',positions:[],cash:[]}}],true).returnPercent).toBeNull();
});
