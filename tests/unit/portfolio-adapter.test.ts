import { expect, test, vi } from 'vitest';
import { assetActivity, portfolioActivity, portfolioPoints, portfolioHoldings, positionSeries, rangePoints } from '../../src/renderer/src/portfolio/local-adapter';
import type { PortfolioView } from '../../src/shared/portfolio';
const view: PortfolioView = { account: null, accounts: [], resources: [], portfolio: null, history: [], positionHistory: [], positions: [], orders: [], executions: [], gaps: [] };
test('position details preserve missing values and separate option contracts sharing a symbol', () => {
 const now = new Date().toISOString();
 const input: PortfolioView = {...view, positions: ['call','put'].map(instrumentRef=>({instrumentRef,symbol:'VTI',quantity:'1',markPrice:'2',marketValue:null,currency:'USD',assetClass:'option',averageCost:'1'})),positionHistory:[{instrumentRef:'call',assetClass:'option',observedAt:now,markPrice:'2',currency:'USD'}]};
 expect(portfolioHoldings(input).map(p=>p.marketRef)).toEqual(['option:call','option:put']);
 expect(portfolioHoldings(input)[0]).toMatchObject({averageEntryPrice:'1',unrealizedPnl:null,positionValue:null});
 const series = positionSeries(input,'1y');
 expect(series.has('option:call')).toBe(true); expect(series.has('option:put')).toBe(false);
 expect(series.get('option:call')?.change).toBeNull();
});
test('activity maps known order details without inventing option notionals or app attribution', () => {
 const input: PortfolioView = {...view, orders:[{providerOrderRef:'o',symbol:'VTI',side:'buy',state:'filled',quantity:'1',sourceCreatedAt:'2026-10-02T15:00:00Z',assetClass:'option',orderType:'limit',timeInForce:'gfd'}],executions:[{providerExecutionRef:'e',orderRef:'o',symbol:'VTI',side:'buy',quantity:'1',price:'2',occurredAt:'2026-10-02T15:01:00Z',assetClass:'option'}]};
 expect(portfolioActivity(input)[0]).toMatchObject({orderType:'limit',timeInForce:'gfd',orderState:'filled',notional:null,source:'external'});
 input.executions[0].notionalAmount='200'; expect(portfolioActivity(input)[0].notional).toBe('200');
});
test('selected history window excludes older and future observations', () => {
 const now=Date.parse('2026-10-02T15:00:00Z');
 expect(rangePoints([{observedAt:'2026-09-01T15:00:00Z'},{observedAt:'2026-10-01T15:00:00Z'},{observedAt:'2026-10-03T15:00:00Z'}],'1w',now)).toEqual([{observedAt:'2026-10-01T15:00:00Z'}]);
});

test('Coinbase history spans the last 24 hours across midnight and never mixes currencies', () => {
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-09T12:00:00Z'));
 try {
  const input:PortfolioView={...view,account:{id:'synthetic',venue:'coinbase',label:'Synthetic',available:true,selected:false},portfolio:{totalValue:'20',currency:'USD',cash:null,buyingPower:null},history:[
   {observedAt:'2026-10-08T13:00:00Z',totalValue:'10',currency:'USD'},
   {observedAt:'2026-10-09T11:00:00Z',totalValue:'18',currency:'EUR'},
   {observedAt:'2026-10-09T12:00:00Z',totalValue:'20',currency:'USD'},
   {observedAt:'2026-10-10T12:00:00Z',totalValue:'30',currency:'USD'},
  ]};
  expect(portfolioPoints(input,'1d').map(p=>p.totalAssetValue)).toEqual(['10','20']);
 } finally { clock.mockRestore(); }
});

test('daily Coinbase estimates never enter the hourly 1D chart',()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-09T12:00:00Z'));
 try {
  const input:PortfolioView={...view,account:{id:'synthetic',venue:'coinbase',label:'Synthetic',available:true,selected:false},portfolio:{totalValue:'20',currency:'USD',cash:null,buyingPower:null},history:[
   {observedAt:'2026-10-09T00:00:00Z',totalValue:'10',currency:'USD',reconstructed:true,resolution:'daily'},
   {observedAt:'2026-10-09T12:00:00Z',totalValue:'20',currency:'USD'},
  ]};
  expect(portfolioPoints(input,'1d').map(p=>p.totalAssetValue)).toEqual(['20']);
  expect(portfolioPoints(input,'1w').map(p=>p.totalAssetValue)).toEqual(['10','20']);
 } finally {clock.mockRestore();}
});

test('Coinbase activity maps allocation actions with exact currency rather than invented trade values',()=>{
 const input:PortfolioView={...view,account:{id:'a',venue:'coinbase',label:'Coinbase',selected:false,available:true},capitalActivity:[
  {id:'one',occurredAt:'2026-10-10T12:00:00Z',kind:'assign',asset:'USDC',quantity:'0.123456789123456789',takeId:'take',takeTitle:'My Take'},
  {id:'two',occurredAt:'2026-10-10T13:00:00Z',kind:'release',asset:'USD',quantity:'10',takeId:'take',takeTitle:'My Take'},
 ]};
 const items=portfolioActivity(input);expect(items.map(i=>i.id)).toEqual(['capital:two','capital:one']);
 expect(items[1]).toMatchObject({source:'app',side:null,notional:null,capital:{kind:'assign',asset:'USDC',quantity:'0.123456789123456789'}});
});

test('order updates appear without inventing fill quantities or notionals',()=>{
 const order={id:'event',orderId:'order',venue:'coinbase' as const,accountId:'account',connectionId:'connection',accountLabel:'Portfolio',strategyId:null,takeId:null,takeTitle:null,reviewId:null,providerRef:null,symbol:'BTC-USDC',side:'buy',execution:{state:'unknown' as const,cancelState:'none' as const},observedAt:'2026-10-10T12:00:00Z'};
 const items=portfolioActivity({...view,account:{id:'account',venue:'coinbase',label:'Portfolio',selected:false,available:true},orderActivity:[order]});
 expect(items).toHaveLength(1);expect(items[0]).toMatchObject({orderEvent:order,notional:null,orderState:'unknown',source:'app'});
});

test('Coinbase Activity backfills fills and wallet movements without double-counting matching trade legs',()=>{
 const input:PortfolioView={...view,account:{id:'a',venue:'coinbase',label:'A',available:true,selected:false},executions:[{providerExecutionRef:'fill',orderRef:'order',symbol:'BTC',side:'buy',quantity:'0.1',price:'500',currency:'USDC',notionalAmount:'50',occurredAt:'2026-10-01T12:00:00Z',assetClass:'crypto'}],accountTransactions:[
  {id:'transfer',asset:'BTC',amount:'-0.01',type:'send',status:'completed',occurredAt:'2026-10-02T12:00:00Z'},
  {id:'base',asset:'BTC',amount:'0.1',type:'advanced_trade_fill',status:'completed',orderRef:'order',occurredAt:'2026-10-01T12:00:00Z'},
  {id:'quote',asset:'USDC',amount:'-50',type:'advanced_trade_fill',status:'completed',orderRef:'order',occurredAt:'2026-10-01T12:00:00Z'},
  {id:'older',asset:'ETH',amount:'1',type:'advanced_trade_fill',status:'completed',orderRef:'older-order',occurredAt:'2026-09-01T12:00:00Z'},
 ]};
 const result=portfolioActivity(input);expect(result.map(row=>row.id)).toEqual(['transaction:transfer','fill:fill','transaction:older']);
 expect(result[1]).toMatchObject({currency:'USDC',notional:'50',source:'external',strategy:null});
 expect(result[0].transaction).toMatchObject({amount:'-0.01',type:'send'});
});

test('asset activity filters the selected account snapshot by crypto base or exact equity symbol', () => {
 const input: PortfolioView = {...view,account:{id:'cb',venue:'coinbase',label:'Test',available:true,selected:false},executions:['BTC-USDC','BTC-USD','ZEC-USDC'].map((symbol,i)=>({providerExecutionRef:String(i),orderRef:String(i),symbol,side:'buy',quantity:'1',price:'2',currency:symbol.split('-')[1],occurredAt:'2026-10-02T15:01:00Z',assetClass:'crypto'}))};
 expect(assetActivity(input,'BTC').map(e=>e.symbol)).toEqual(['BTC-USD','BTC-USDC']);
 expect(assetActivity(null,'BTC')).toEqual([]);
 expect(assetActivity({...input,account:{...input.account!,venue:'robinhood'}},'BTC')).toEqual([]);
});
