import {expect,test,vi} from 'vitest';
import {createCoinbaseTradingProduct} from '../../src/main/coinbase/trading-product';
import {productSchema} from '../../src/main/coinbase/order-planner';
const product={product_id:'BTC-USDC',base_currency_id:'BTC',quote_currency_id:'USDC',product_type:'SPOT',price:'100',base_increment:'0.001',quote_increment:'0.01',price_increment:'0.01',base_min_size:'0.001',base_max_size:'1000',quote_min_size:'1',quote_max_size:'100000',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,view_only:false,status:'online'};
const scope={accountRef:'synthetic',authority:'synthetic',label:'Synthetic'} as never;
test('concurrent product refreshes share reads but submission-time repeats fetch again',async()=>{
 let finish!:(value:unknown)=>void;
 const pending=new Promise<unknown>(resolve=>{finish=resolve;});
 const read=vi.fn(()=>pending),rules=vi.fn(async()=>product);
 const get=createCoinbaseTradingProduct({read,rules});
 const a=get(scope,'BTC-USDC'),b=get(scope,'BTC-USDC');
 finish(product);expect(await a).toEqual(product);expect(await b).toEqual(product);
 expect(read).toHaveBeenCalledTimes(1);
 await get(scope,'BTC-USDC');expect(read).toHaveBeenCalledTimes(2);
});
test('authority changes cannot borrow another product refresh and failure has no cached fallback',async()=>{
 const read=vi.fn(async()=>product),rules=vi.fn(async()=>product),get=createCoinbaseTradingProduct({read,rules});
 await Promise.all([get(scope,'BTC-USDC'),get({accountRef:'synthetic',authority:'changed',label:'Synthetic'},'BTC-USDC')]);
 expect(read).toHaveBeenCalledTimes(2);
 read.mockRejectedValueOnce(Error('Provider unavailable'));
 await expect(get(scope,'BTC-USDC')).rejects.toThrow('Provider unavailable');
});
test('supplements the abbreviated MCP product through the authenticated adapter',async()=>{
 const short={...product} as Record<string,unknown>;for(const key of ['price_increment','is_disabled','trading_disabled','cancel_only','post_only','auction_mode','view_only'])delete short[key];
 const rules=vi.fn(async()=>product),read=vi.fn(async()=>short);
 const result=await createCoinbaseTradingProduct({read,rules})(scope,'BTC-USDC');
 expect(productSchema.parse(result)).toEqual(product);expect(rules).toHaveBeenCalledWith(scope,'BTC-USDC');
});
test('complete MCP responses do not request REST or bypass trading restrictions',async()=>{
 const rules=vi.fn(async()=>product);
 const result=await createCoinbaseTradingProduct({read:async()=>({...product,trading_disabled:true}),rules})(scope,'BTC-USDC');
 expect(rules).not.toHaveBeenCalled();expect(()=>productSchema.parse(result)).toThrow();
});

test('supplementation preserves every primary restriction, including limit-only',async()=>{
 for(const flag of ['limit_only','is_disabled','trading_disabled','cancel_only','post_only','auction_mode','view_only']){
  const short={...product,[flag]:true} as Record<string,unknown>;delete short.price_increment;
  const result=await createCoinbaseTradingProduct({read:async()=>short,rules:async()=>product})(scope,'BTC-USDC');
  expect(result).toMatchObject({[flag]:true});
  expect(productSchema.safeParse(result).success).toBe(flag==='limit_only');
 }
 const short={...product,status:'offline'} as Record<string,unknown>;delete short.price_increment;
 const result=await createCoinbaseTradingProduct({read:async()=>short,rules:async()=>product})(scope,'BTC-USDC');
 expect(productSchema.safeParse(result).success).toBe(false);
});

test('fallback restrictions cannot be overridden by permissive primary flags',async()=>{
 const short={...product} as Record<string,unknown>;delete short.price_increment;
 for(const field of ['is_disabled','trading_disabled','cancel_only','post_only','auction_mode','view_only']){
  await expect(createCoinbaseTradingProduct({read:async()=>short,rules:async()=>({...product,[field]:true})})(scope,'BTC-USDC')).rejects.toThrow();
 }
 const result=await createCoinbaseTradingProduct({read:async()=>short,rules:async()=>({...product,limit_only:true})})(scope,'BTC-USDC');
 expect(result).toMatchObject({limit_only:true});
});

test('malformed primary evidence cannot be repaired into eligibility',async()=>{
 for(const invalid of [null,[],{...product,trading_disabled:'false'},{...product,base_increment:'0'},{product_id:'BTC-USDC',trading_disabled:null}]){
  const rules=vi.fn(async()=>product);
  await expect(createCoinbaseTradingProduct({read:async()=>invalid,rules})(scope,'BTC-USDC')).rejects.toThrow();
  expect(rules).not.toHaveBeenCalled();
 }
});

test('primary and supplemental market identities must match the requested product',async()=>{
 await expect(createCoinbaseTradingProduct({read:async()=>({...product,product_id:'ETH-USDC'}),rules:async()=>product})(scope,'BTC-USDC')).rejects.toThrow('identity');
 for(const change of [{product_id:'ETH-USDC'},{base_currency_id:'ETH'},{quote_currency_id:'USD'}]){
  const short={...product} as Record<string,unknown>;delete short.price_increment;
  await expect(createCoinbaseTradingProduct({read:async()=>short,rules:async()=>({...product,...change})})(scope,'BTC-USDC')).rejects.toThrow('identity');
 }
});
