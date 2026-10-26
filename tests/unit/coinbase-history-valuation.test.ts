import {expect,test,vi} from 'vitest';
import {reconstructCoinbaseDay} from '../../src/main/coinbase/history-valuation';
import type {CoinbaseHistory} from '../../src/main/coinbase/history';
const asOf=Date.parse('2026-10-09T12:00:00Z');
const event=(asset:string,amount:string,time:number,type='receive')=>({id:asset+amount+time,wallet:asset,asset,amount,type,status:'completed',occurredAt:new Date(time).toISOString()});
const history=(transactions:CoinbaseHistory['transactions']):CoinbaseHistory=>({state:'complete',reason:null,walletCount:2,completedWallets:2,transactions});
const position=(asset:string,quantity:string)=>({asset,quantity,instrumentRef:'coinbase:'+asset,marketValue:'100',availableValue:null,currency:'USD',isCash:asset==='USD'});
const candles=async()=>({candles:Array.from({length:25},(_,i)=>({start:(asOf-24*3600000+i*3600000)/1000,open:'100'}))});
test('reconstructs signed trades and transfers without counting a buy as new money',async()=>{
 const h=history([event('USD','200',asOf-30*3600000),event('USD','-100',asOf-12*3600000,'advanced_trade_fill'),event('BTC','1',asOf-12*3600000,'advanced_trade_fill'),event('USD','50',asOf-2*3600000,'fiat_deposit')]);
 const result=await reconstructCoinbaseDay(h,[position('USD','150'),position('BTC','1')],'USD',asOf,candles);
 expect(result.state).toBe('complete');expect(result.points).toHaveLength(25);expect(result.points[0].totalValue).toBe('200');expect(result.points[13].totalValue).toBe('200');expect(result.points.at(-1)?.totalValue).toBe('250');
});
test('never reconstructs from incomplete coverage, unresolved events or a ledger mismatch',async()=>{
 const read=vi.fn(candles),h=history([event('BTC','1',asOf-30*3600000)]);
 expect((await reconstructCoinbaseDay({...h,state:'partial'},[position('BTC','1')],'USD',asOf,read)).reason).toBe('coverage');
 expect((await reconstructCoinbaseDay(h,[position('BTC','2')],'USD',asOf,read)).reason).toBe('ledger_mismatch');
 expect((await reconstructCoinbaseDay(history([{...h.transactions[0],status:'pending'}]),[position('BTC','1')],'USD',asOf,read)).reason).toBe('unsettled');
 expect((await reconstructCoinbaseDay(history([{...h.transactions[0],type:'unknown_new_type',occurredAt:new Date(asOf-3600000).toISOString()}]),[position('BTC','1')],'USD',asOf,read)).reason).toBe('unsupported_event');
 expect(read).not.toHaveBeenCalled();
});
test('missing candles and stablecoin prices remain unknown, never assumed zero or one',async()=>{
 const h=history([event('USDC','100',asOf-30*3600000)]),read=vi.fn(async()=>({candles:[]}));
 const result=await reconstructCoinbaseDay(h,[position('USDC','100')],'USD',asOf,read);
 expect(result).toMatchObject({state:'unavailable',reason:'price_gap',points:[]});expect(read.mock.calls[0][0]).toBe('USDC-USD');
});


test('old event types do not block a recent window when the full signed ledger reconciles',async()=>{
 const h=history([event('USD','100',asOf-365*86400000,'legacy_transaction_type')]);
 expect((await reconstructCoinbaseDay(h,[position('USD','100')],'USD',asOf,candles)).state).toBe('complete');
 expect((await reconstructCoinbaseDay(h,[position('USD','101')],'USD',asOf,candles)).reason).toBe('ledger_mismatch');
});

test('reconciles exact wallet units and quote commissions without charging the base copy twice',async()=>{
 const h=history([event('USD','102',asOf-30*3600000),{...event('USD','-100',asOf-12*3600000,'advanced_trade_fill'),fee:{amount:'2',asset:'USD'}},{...event('BTC','1',asOf-12*3600000,'advanced_trade_fill'),fee:{amount:'2',asset:'USD'}}]);
 h.wallets=[{wallet:'USD',asset:'USD',balance:'0',available:'0',held:'0'},{wallet:'BTC',asset:'BTC',balance:'1',available:'1',held:'0'}];
 const result=await reconstructCoinbaseDay(h,[position('BTC','1')],'USD',asOf,candles);
 expect(result.state).toBe('complete');expect(result.points[0].totalValue).toBe('102');expect(result.points.at(-1)?.totalValue).toBe('100');
});
test('wallet evidence must cover every portfolio holding, including staked holdings',async()=>{
 const h=history([]);h.wallets=[{wallet:'ETH',asset:'ETH',available:'0',held:'0',balance:'0'}];
 expect((await reconstructCoinbaseDay(h,[position('ETH','0.1')],'USD',asOf,candles)).reason).toBe('ledger_mismatch');
});

test('v2 currency exponent allows only sub-unit rounding, preserving exact ledger quantities',async()=>{
 const h=history([event('ATOM','0.1234567',asOf-30*3600000)]);
 h.wallets=[{wallet:'ATOM',asset:'ATOM',available:null,held:null,balance:'0.123457',balancePrecision:6}];
 const result=await reconstructCoinbaseDay(h,[position('ATOM','0.123457')],'USD',asOf,candles);
 expect(result.state).toBe('complete');expect(result.points[0].totalValue).toBe('12.34567');
 h.wallets[0].balancePrecision=undefined;
 expect((await reconstructCoinbaseDay(h,[position('ATOM','0.123457')],'USD',asOf,candles)).reason).toBe('ledger_mismatch');
 h.wallets[0].balancePrecision=6;h.wallets[0].balance='0.123458';
 expect((await reconstructCoinbaseDay(h,[position('ATOM','0.123458')],'USD',asOf,candles)).reason).toBe('ledger_mismatch');
});

test('daily fallback preserves resolution and does not assume stablecoin parity',async()=>{
 const h=history([event('USDC','100',asOf-30*86400000)]);
 const spot=vi.fn(async()=> '0.99');
 const result=await reconstructCoinbaseDay(h,[position('USDC','100')],'USD',asOf,async()=>({candles:[]}),spot);
 expect(result.state).toBe('complete');expect(result.points).toHaveLength(8);
 expect(result.points.every(p=>p.resolution==='daily'&&p.totalValue==='99')).toBe(true);
 expect(spot).toHaveBeenCalledWith('USDC-USD','2026-10-08');
 expect((await reconstructCoinbaseDay(h,[position('USDC','100')],'USD',asOf,async()=>({candles:[]}))).reason).toBe('price_gap');
});

test('daily history rolls back credited interest without treating it as trading proceeds',async()=>{
 const h=history([event('USDC','100',asOf-30*86400000),event('USDC','2',asOf-3*86400000,'interest')]);
 const result=await reconstructCoinbaseDay(h,[position('USDC','102')],'USD',asOf,async()=>({candles:[]}),async()=> '1');
 expect(result.state).toBe('complete');expect(result.points[0].totalValue).toBe('100');expect(result.points.at(-1)?.totalValue).toBe('102');
});
