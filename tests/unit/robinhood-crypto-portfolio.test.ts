import {expect,test,vi} from 'vitest';
import {robinhoodCryptoPortfolio} from '../../src/main/trading/robinhood-crypto-portfolio';
import {marketKey} from '../../src/shared/search';
const now=Date.parse('2026-10-15T15:00:00Z');
function fixture(){
 let stale=false,wrong=false;
 const read=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='get_crypto_positions'){expect(args.rhs_account_number).toBe('123');return {data:{results:[{currency_pair_id:'btc',currency:{code:'BTC',type:'cryptocurrency'},quantity:'0.002',quantity_transferable:'0.001',quantity_held_for_sell:'0.001'}]}};}
  if(name==='get_currency_pairs')return {data:{results:[{id:'btc',symbol:'BTC-USD',asset_currency:{code:'BTC'},quote_currency:{code:'USD'},tradability:'tradable',display_only:false,min_order_size:'0.00001',max_order_size:'100',min_order_quantity_increment:'0.00000001',min_order_price_increment:'0.01',min_order_quote_amount:'1',market_orders_only:false,halted:false},{id:'eth',symbol:'ETH-USD'}]}};
  expect(name).toBe('get_crypto_quotes');expect(args.rhs_account_number).toBe('123');
  return {data:{results:[{id:wrong?'other':'btc',symbol:'BTCUSD',mark_price:'50000',bid_price:'49999',ask_price:'50001',updated_at:new Date(now-(stale?61000:0)).toISOString()},{id:'eth',symbol:'ETHUSD',mark_price:'2000',bid_price:'1999',ask_price:'2001',updated_at:new Date(now).toISOString()}]}};
 });
 return {read,run:()=>robinhoodCryptoPortfolio(read,'123',['eth'],new AbortController().signal,now),stale:()=>{stale=true;},wrong:()=>{wrong=true;}};
}
test('crypto portfolio uses exact pair identities and preserves unheld target quotes without creating holdings',async()=>{
 const f=fixture(),rows=await f.run();
 expect(rows[0]).toMatchObject({instrumentRef:marketKey({identity:{venue:'robinhood',instance:'production',kind:'crypto',reference:'btc'}}),symbol:'BTC-USD',quantity:'0.002',heldQuantity:'0.001',marketValue:'100'});
 expect(rows[0].providerPayload).toEqual({cryptoSizing:{quantityIncrement:'0.00000001',minimumQuantity:'0.00001',maximumQuantity:'100',minimumNotional:'1'}});
 expect(rows[1]).toMatchObject({symbol:'ETH-USD',quantity:'0',marketValue:'0',markPrice:'2000'});
 expect(JSON.stringify(rows)).not.toContain('rhs_account_number');
});
test('stale crypto quotes remain unpriced and contradictory identities refuse the observation',async()=>{
 const f=fixture();f.stale();expect((await f.run())[0].markPrice).toBeNull();
 f.wrong();await expect(f.run()).rejects.toThrow('identity mismatch');
});

test('freshness is measured after network reads finish',async()=>{
 const f=fixture(),clock=vi.spyOn(Date,'now').mockReturnValue(now-100);
 try{
  const read=async(name:string,args:Record<string,unknown>)=>{
   const result=await f.read(name,args);
   if(name==='get_crypto_quotes')clock.mockReturnValue(now);
   return result;
  };
  const rows=await robinhoodCryptoPortfolio(read,'123',['eth'],new AbortController().signal);
  expect(rows[0]).toMatchObject({markPrice:'50000',marketValue:'100'});
 }finally{clock.mockRestore();}
});
