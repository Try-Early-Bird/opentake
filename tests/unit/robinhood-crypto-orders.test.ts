import {expect,test,vi} from 'vitest';
import {robinhoodCryptoOrders} from '../../src/main/trading/robinhood-crypto-orders';
const account={rhsAccountNumber:'123',cryptoAccountNumber:'synthetic'};
const order={id:'external',currency_pair_id:'pair',side:'buy',type:'limit',state:'confirmed',time_in_force:'gtc',quantity:'0.01',cumulative_quantity:'0',created_at:'2026-10-01T10:00:00Z',updated_at:'2026-10-15T10:00:00Z'};
const signal=new AbortController().signal;
test('discovers outside orders, reads missing previously-open IDs, and keeps fills out of equity attribution',async()=>{
 const read=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='get_currency_pairs')return {data:{results:[{id:'pair',symbol:'BTC-USD'}]}};
  expect(args.rhs_account_number).toBe('123');
  return {data:{rhs_account_number:'123',crypto_account_number:'synthetic',results:args.state_group?[order]:args.order_id?[{...order,id:'old',state:'filled',cumulative_quantity:'0.01'}]:[]}};
 });
 const result=await robinhoodCryptoOrders(read,account,'2026-10-14T00:00:00Z',['old'],signal);
 expect(result).toMatchObject([{providerOrderRef:'external',symbol:'BTC-USD',state:'confirmed',executions:[]},{providerOrderRef:'old',state:'filled',executions:[]}]);
 expect(read.mock.calls.some(([,args])=>args.order_id==='old')).toBe(true);
 expect(JSON.stringify(result)).not.toContain('rhsAccountNumber');
});
test('refuses wrong-account, missing-open and contradictory evidence',async()=>{
 const make=(mode:string)=>async(name:string,args:Record<string,unknown>)=>name==='get_currency_pairs'?{data:{results:[{id:'pair',symbol:'BTC-USD'}]}}:
  {data:{rhs_account_number:mode==='account'?'other':'123',results:mode==='missing'?[]:[mode==='conflict'&&args.updated_at_gte?{...order,side:'sell'}:order]}};
 await expect(robinhoodCryptoOrders(make('account'),account,'2026-10-14T00:00:00Z',[],signal)).rejects.toThrow('account mismatch');
 await expect(robinhoodCryptoOrders(make('missing'),account,'2026-10-14T00:00:00Z',['old'],signal)).rejects.toThrow('Missing open');
 await expect(robinhoodCryptoOrders(make('conflict'),account,'2026-10-14T00:00:00Z',[],signal)).rejects.toThrow('identity');
});
