import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {websocketSourceConfig} from '../../../src/main/data-sources/websocket/adapter';
import {createSourceRepository} from '../../../src/main/data-sources/repository';
import {createObservationStorage} from '../../../src/main/data-sources/storage';
import {applyDestination} from '../../../src/main/data-sources/destinations';
import {readStoredMarketPrice} from '../../../src/main/data-sources/market-price-reader';
import {createCoinbaseSourceSettings} from '../../../src/main/data-sources/coinbase-stream/source-settings';
import {createCoinbaseStreamPriceWriter} from '../../../src/main/coinbase/stream-price-store';
import type {DataObservation} from '../../../src/shared/data-sources';
async function fixture(){
 const db=new PGlite();await migrate(db);let now=Date.parse('2026-10-21T12:00:00Z');
 const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)},repo=createSourceRepository(database),storage=createObservationStorage(database,{automatic:false,now:()=>now});
 const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
 const config=websocketSourceConfig.parse({transport:'websocket',name:'Crypto prices',collection:'automatic',connection:{endpoint:'wss://fixture.example/prices',auth:{mode:'none'},subscription:{body:{op:'subscribe'}},acknowledgement:{success:{path:['op'],equals:'ok'},failure:{path:['op'],equals:'error'}}},feeds:[{id:'prices',name:'Prices',unit:'USD',eventTimePath:['time'],mapping:{kind:'event',fields:{symbol:{path:['symbol'],type:'string'},price:{path:['price'],type:'string'}}},storage:{mode:'latest',fields:['symbol','price']},destination:{kind:'market-prices',market:{venue:'coinbase',instance:'production',kind:'crypto'},symbolField:'symbol',priceField:'price',currency:'USD',policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true}}]});
 const source=await repo.save(owner,config);await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
 async function product(id='BTC-USD',price:string|null='100',at=now-120000){await db.query(`INSERT INTO public_price_cache VALUES('coinbase',$1,'product',0,0,$2,$3,NULL) ON CONFLICT(provider,pair,kind,interval_seconds,bucket) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at`,[id,JSON.stringify({id,venue:'coinbase',base:id.split('-')[0],quote:'USD',price,name:'Unchanged metadata'}),new Date(at)]);}
 await product();
 const observation=(symbol='BTC-USD',price='120'):DataObservation=>({sourceId:source.id,feedId:'prices',configVersion:1,schemaVersion:1,epoch:1,unit:'USD',adapterId:'custom-websocket',adapterVersion:'1',receivedAt:now,eventTime:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{symbol,price}}});
 const read=()=>readStoredMarketPrice(db,{venue:'coinbase',instance:'production',kind:'crypto',reference:'BTC-USD'},now);
 return {db,database,owner,repo,storage,config,source,observation,read,product,time:()=>now,advance:(ms:number)=>{now+=ms;},apply:(o=observation(),dry=false)=>db.transaction(tx=>applyDestination(tx,owner,config.feeds[0],o,now,dry)),close:async()=>{await storage.close();await db.close();}};
}
test('custom crypto destination previews and stores exact prices without changing product metadata',async()=>{
 const f=await fixture();try{
  const before=(await f.db.query("SELECT data,fetched_at FROM public_price_cache WHERE kind='product'")).rows;
  expect(await f.apply(f.observation(),true)).toMatchObject({outcome:'would-write'});
  expect((await f.db.query("SELECT * FROM public_price_cache WHERE kind='custom-price'")).rows).toHaveLength(0);
  f.storage.enqueue(f.owner,f.observation('BTC-USD','120.123456789123456789'));await f.storage.flush();
  expect(await f.read()).toMatchObject({quality:'fresh',quote:{payload:{price:'120.123456789123456789'},provider:'custom-websocket',sourceId:f.source.id,revision:1,feedId:'prices'}});
  expect((await f.db.query("SELECT data,fetched_at FROM public_price_cache WHERE kind='product'")).rows).toEqual(before);
  await f.repo.enable(f.owner,f.source.id,1,false);expect(await f.read()).toMatchObject({quality:'stale',quote:{provider:'coinbase',payload:{price:'100'}}});
  await f.repo.enable(f.owner,f.source.id,1,true);await f.repo.save(f.owner,f.config,{id:f.source.id,revision:1});
  expect(await f.read()).toMatchObject({quality:'stale',quote:{provider:'coinbase'}});
  f.advance(86400001);await f.storage.flush();
  expect((await f.db.query("SELECT * FROM public_price_cache WHERE kind='custom-price'")).rows).toHaveLength(0);
  expect((await f.db.query("SELECT data,fetched_at FROM public_price_cache WHERE kind='product'")).rows).toEqual(before);
 }finally{await f.close();}
});
test('fresh Coinbase HTTP and stream prices take precedence over custom crypto values',async()=>{
 const f=await fixture();try{
  await f.product('BTC-USD','101',f.time());expect(await f.apply()).toMatchObject({outcome:'preserved'});
  f.advance(61000);expect(await f.apply()).toMatchObject({outcome:'written'});
  await f.product('BTC-USD','102',f.time());expect(await f.read()).toMatchObject({quote:{provider:'coinbase',payload:{price:'102'}}});
  f.advance(61000);
  const source=await createCoinbaseSourceSettings(f.database).load();
  const writer=createCoinbaseStreamPriceWriter(f.database,()=>({revision:source.revision,quotes:[{product:'BTC-USD',price:'103',eventTime:f.time()}]}),f.time);
  try{await writer.tick();expect(await f.apply()).toMatchObject({outcome:'preserved'});expect(await f.read()).toMatchObject({quote:{provider:'coinbase-websocket',payload:{price:'103'}}});}finally{await writer.close();}
 }finally{await f.close();}
});
test('crypto routes reject unknown products, wrong quotes, invalid and stale prices and preserve timestamp ties',async()=>{
 const f=await fixture();try{
  for(const [symbol,price,outcome] of [['ETH-USD','1','missing-market'],['BTC-USDC','1','invalid'],['BTC','1','invalid'],['BTC-USD','0','invalid'],['BTC-USD','1e4','invalid']] as const)expect(await f.apply(f.observation(symbol,price))).toMatchObject({outcome});
  expect(await f.apply({...f.observation(),eventTime:f.time()-60001})).toMatchObject({outcome:'stale'});
  expect(await f.apply()).toMatchObject({outcome:'written'});
  expect(await f.apply(f.observation('BTC-USD','999'))).toMatchObject({outcome:'preserved'});
  f.advance(61000);expect(await f.read()).toMatchObject({quality:'stale',quote:{provider:'coinbase'}});
  const feed=f.config.feeds[0];if(feed.destination?.kind!=='market-prices')throw Error();
  // Coinbase holdings selectors are valid config; account access is checked at save (see selector admission below).
  expect(websocketSourceConfig.parse({...f.config,feeds:[{...feed,destination:{...feed.destination,holdings:{accountIds:[f.source.id]}}}]}).feeds[0].destination).toMatchObject({holdings:{accountIds:[f.source.id]}});
 }finally{await f.close();}
});

test('external IDs map to exact Coinbase products and unmapped IDs never fall back',async()=>{
 const f=await fixture();try{
  const feed=f.config.feeds[0];if(feed.destination?.kind!=='market-prices')throw Error();
  feed.destination.identifier={kind:'external-id',mappings:[{from:'vendor:42',to:'BTC-USD'},{from:'vendor:99',to:'ETH-USD'}]};
  expect(await f.apply(f.observation('vendor:42'),true)).toMatchObject({outcome:'would-write'});
  expect(await f.apply(f.observation('BTC-USD'))).toMatchObject({outcome:'missing-market'});
  expect(await f.apply(f.observation('vendor:99'))).toMatchObject({outcome:'missing-market'});
  expect(await f.apply(f.observation('vendor:42'))).toMatchObject({outcome:'written'});
 }finally{await f.close();}
});

test('Coinbase holdings selector admission and routed price writes respect selected account positions',async()=>{
 const {randomUUID}=await import('node:crypto');const f=await fixture();
 try{
  const connection=randomUUID(),account=randomUUID();
  await f.db.query("INSERT INTO platform_connections(id,owner_id,venue,status,external_account_ref) VALUES($1,$2,'coinbase','connected','fixture')",[connection,f.owner]);
  await f.db.query("INSERT INTO linked_accounts(id,connection_id,external_ref,masked_number,agentic_allowed) VALUES($1,$2,'fixture','fixture',true)",[account,connection]);
  const original=f.config.feeds[0];if(original.destination?.kind!=='market-prices')throw Error();
  const feed={...original,destination:{...original.destination,holdings:{accountIds:[account],maxAgeMs:60000}}};
  const edited=await f.repo.save(f.owner,{...f.config,feeds:[feed]},{id:f.source.id,revision:1});
  await f.repo.validate(f.owner,edited.id,2);await f.repo.enable(f.owner,edited.id,2,true);
  await expect(f.repo.save(f.owner,{...f.config,feeds:[{...feed,destination:{...feed.destination,holdings:{accountIds:[randomUUID()],maxAgeMs:60000}}}]})).rejects.toThrow('unavailable');
  const apply=()=>f.db.transaction(tx=>applyDestination(tx,f.owner,feed,{...f.observation(),configVersion:2},f.time()));
  expect(await apply()).toMatchObject({outcome:'holdings-unavailable'});
  await f.db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)',[account,new Date(f.time()),JSON.stringify({spotPositions:[{asset:'ETH',quantity:'1',isCash:false,currency:'USD'}]})]);
  expect(await apply()).toMatchObject({outcome:'filtered'});f.advance(1);
  await f.db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)',[account,new Date(f.time()),JSON.stringify({spotPositions:[{asset:'BTC',quantity:'0.01',isCash:false,currency:'USD'}]})]);
  expect(await apply()).toMatchObject({outcome:'written'});
  expect((await f.db.query("SELECT data FROM public_price_cache WHERE kind='custom-price'")).rows).toHaveLength(1);
 }finally{await f.close();}
});
