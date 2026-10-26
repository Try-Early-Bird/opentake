import {createElement} from 'react';
import {expect,test} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ClosePositionsTable,type CloseHolding} from '../../src/renderer/src/components/ClosePositionsDialog';
const holding:CloseHolding={valuation:{currency:'USD',cash:'2',complete:true,totalValue:'22'},positions:[{symbol:'BTC',quantity:'0.001',value:'20',unrealized:'-1'}]};
test('shared close review shows compact rows and includes cash in the return estimate',()=>{
 const html=renderToStaticMarkup(createElement(ClosePositionsTable,{holding,selected:new Set(['BTC']),onChange:()=>{},accountName:'Account 123'}));
 for(const text of ['Back to Account 123','Returned to Account 123','22.00','P&amp;L','Sell BTC',' sh'])expect(html).toContain(text);
 for(const text of ['Sell all','Clear','<table','Total P&amp;L'])expect(html).not.toContain(text);
});
test('Coinbase close uses fee-adjusted proceeds, keeps other cash separate and respects provider minimums',()=>{
 const html=renderToStaticMarkup(createElement(ClosePositionsTable,{holding:{...holding,valuation:{...holding.valuation,currency:'USDC'},positions:[{...holding.positions[0],value:'0.50',sellable:true}]},selected:new Set(['BTC']),onChange:()=>{},crypto:true,estimatedProceeds:'0.45',cashRows:[{asset:'USD',quantity:'1'},{asset:'USDC',quantity:'0.03'}]}));
 for(const text of ['0.48','USDC','Cash · USD','Cash · USDC'])expect(html).toContain(text);
 expect(html).not.toContain('0.001 sh');expect(html.match(/<input[^>]+>/)?.[0]).not.toContain('disabled');
});
test('cash-only close shows balances without sell or currency controls',()=>{
 const html=renderToStaticMarkup(createElement(ClosePositionsTable,{holding:{...holding,positions:[]},selected:new Set(),onChange:()=>{},crypto:true,headerControl:'Receive as',cashRows:[{asset:'USD',quantity:'2'},{asset:'USDC',quantity:'3'}]}));
 for(const text of ['Cash · USD','Cash · USDC','2.00','3.00','No assets need to be sold'])expect(html).toContain(text);
 for(const text of ['Receive as','checkbox','P&amp;L'])expect(html).not.toContain(text);
});
test('unchecked assets stay out of proceeds and a pending preview never shows stale proceeds',()=>{
 const html=renderToStaticMarkup(createElement(ClosePositionsTable,{holding,selected:new Set(),onChange:()=>{},estimatedProceeds:'0'}));
 expect(html).toContain('Keeping 20.00');expect(html).toContain('2.00');
 const pending=renderToStaticMarkup(createElement(ClosePositionsTable,{holding,selected:new Set(['BTC']),onChange:()=>{},estimatedProceeds:null}));
 expect(pending).not.toContain('22.00');expect(pending).toContain('—');
});
