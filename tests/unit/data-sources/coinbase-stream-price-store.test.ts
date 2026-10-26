import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {createCoinbaseSourceSettings} from '../../../src/main/data-sources/coinbase-stream/source-settings';
import {createCoinbaseStreamPriceWriter,readCoinbaseStreamPrice} from '../../../src/main/coinbase/stream-price-store';
import {readStoredMarketPrice} from '../../../src/main/data-sources/market-price-reader';
import {createCoinbasePriceCache} from '../../../src/main/coinbase/price-cache';
import {createCoinbaseMarkets} from '../../../src/main/coinbase/markets';
const market={venue:'coinbase',instance:'production',kind:'crypto',reference:'BTC-USD'};
test('stream prices persist precisely, beat HTTP prices, deduplicate and fall back when stale or disabled',async()=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:any)=>Promise<T>)=>fn(db)};
 const settings=createCoinbaseSourceSettings(database);let source=await settings.load(),now=Date.now();
 let quotes=[{product:'BTC-USD',price:'123.000000000000000001',eventTime:now}];
 const errors=vi.fn();const writer=createCoinbaseStreamPriceWriter(database,()=>({revision:source.revision,quotes}),()=>now,errors);
 try{
  const product={id:'BTC-USD',venue:'coinbase',base:'BTC',quote:'USD',name:'Bitcoin',price:'100',description:'Keep metadata'};
  await db.query("INSERT INTO public_price_cache VALUES('coinbase','BTC-USD','product',0,0,$1,$2,NULL)",[JSON.stringify(product),new Date(now)]);
  await writer.tick();expect(errors).not.toHaveBeenCalled();
  expect(await readStoredMarketPrice(db,market,now)).toMatchObject({quality:'fresh',quote:{payload:{price:quotes[0].price},provider:'coinbase-websocket',eventTime:now,revision:source.revision}});
  const fetcher=vi.fn();const markets=createCoinbaseMarkets(createCoinbasePriceCache(database,fetcher,()=>now),()=>now);
  expect((await markets.detail('BTC-USD')).market).toMatchObject({price:quotes[0].price,description:'Keep metadata'});expect(fetcher).not.toHaveBeenCalled();
  const received=(await readCoinbaseStreamPrice(db,'BTC-USD',now))!.receivedAt;
  now+=1000;await writer.tick();expect((await readCoinbaseStreamPrice(db,'BTC-USD',now))!.receivedAt).toBe(received);
  quotes=[{...quotes[0],eventTime:now-2000,price:'999'}];await writer.tick();expect((await readCoinbaseStreamPrice(db,'BTC-USD',now))!.price).toBe('123.000000000000000001');
  now+=15001;await writer.tick();expect(await readCoinbaseStreamPrice(db,'BTC-USD',now)).toBeNull();expect((await readStoredMarketPrice(db,market,now)).quote?.payload).toMatchObject({price:'100'});
  quotes=[{product:'BTC-USD',price:'124',eventTime:now}];await writer.tick();expect((await readCoinbaseStreamPrice(db,'BTC-USD',now))!.price).toBe('124');
  source=await settings.save({revision:source.revision,config:{...source.config,collection:'off'}});
  await writer.tick();expect(await readCoinbaseStreamPrice(db,'BTC-USD',now)).toBeNull();expect((await readStoredMarketPrice(db,market,now)).quote?.payload).toMatchObject({price:'100'});
  const stored=(await db.query<{data:unknown}>("SELECT data FROM public_price_cache WHERE kind='product'")).rows[0].data;expect(stored).toEqual(product);
  expect((await db.query("SELECT * FROM public_price_cache WHERE kind='stream-price'")).rows).toHaveLength(1);
 }finally{await writer.close();await db.close();}
});
test('invalid, future and stale trades never become stored prices',async()=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:any)=>Promise<T>)=>fn(db)};
 const source=await createCoinbaseSourceSettings(database).load(),now=Date.now();
 const writer=createCoinbaseStreamPriceWriter(database,()=>({revision:source.revision,quotes:[{product:'BTC-USD',price:'0',eventTime:now},{product:'ETH-USD',price:'10',eventTime:now-15001},{product:'SOL-USD',price:'20',eventTime:now+2001},{product:'BAD-EUR',price:'30',eventTime:now}]}),()=>now);
 try{await writer.tick();expect((await db.query("SELECT * FROM public_price_cache WHERE kind='stream-price'")).rows).toHaveLength(0);}finally{await writer.close();await db.close();}
});

test('equal timestamps keep the first committed price, settle retries, and recover after write failure or restart',async()=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:any)=>Promise<T>)=>fn(db)};
 const settings=createCoinbaseSourceSettings(database);let source=await settings.load(),now=Date.now();
 let quotes=[{product:'BTC-USD',price:'10',eventTime:now}];const errors=vi.fn(),query=vi.spyOn(db,'query');
 let writer=createCoinbaseStreamPriceWriter(database,()=>({revision:source.revision,quotes}),()=>now,errors);
 try{
  await writer.tick();const original=await readCoinbaseStreamPrice(db,'BTC-USD',now);
  now+=1000;quotes=[{...quotes[0],price:'11'}];await writer.tick();query.mockClear();
  await writer.tick();expect(query).not.toHaveBeenCalled();expect(await readCoinbaseStreamPrice(db,'BTC-USD',now)).toEqual(original);
  await writer.close();writer=createCoinbaseStreamPriceWriter(database,()=>({revision:source.revision,quotes}),()=>now,errors);
  await writer.tick();query.mockClear();await writer.tick();expect(query).not.toHaveBeenCalled();
  quotes=[{...quotes[0],eventTime:now-2000}];await writer.tick();query.mockClear();await writer.tick();expect(query).not.toHaveBeenCalled();
  quotes=[{...quotes[0],eventTime:now,price:'12'}];query.mockRejectedValueOnce(Error('synthetic write failure'));await writer.tick();expect(errors).toHaveBeenCalledTimes(1);
  await writer.tick();expect((await readCoinbaseStreamPrice(db,'BTC-USD',now))?.price).toBe('12');
  source=await settings.save({revision:source.revision,config:{...source.config,name:'Renamed stream'}});
  quotes=[{...quotes[0],price:'13'}];await writer.tick();expect((await readCoinbaseStreamPrice(db,'BTC-USD',now))?.price).toBe('13');
 }finally{await writer.close();query.mockRestore();await db.close();}
});
