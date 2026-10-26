import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {websocketSourceConfig} from '../../../src/main/data-sources/websocket/adapter';
import {createSourceRepository} from '../../../src/main/data-sources/repository';
import {createObservationStorage} from '../../../src/main/data-sources/storage';
import {mapHttpSample} from '../../../src/main/data-sources/http-adapter';
import {applyDestination} from '../../../src/main/data-sources/destinations';
import type {DataObservation} from '../../../src/shared/data-sources';
const routedConfig=()=>websocketSourceConfig.parse({transport:'websocket',name:'Selected trades',collection:'automatic',
 connection:{endpoint:'wss://fixture.example/prices',auth:{mode:'none'},subscription:{body:{op:'subscribe'}},acknowledgement:{success:{path:['op'],equals:'ok'},failure:{path:['op'],equals:'error'}}},
 feeds:[{id:'prices',name:'Prices',unit:'USD',eventTimePath:['time'],mapping:{kind:'event',fields:{
 symbol:{path:['symbol'],type:'string'},price:{path:['price'],type:'string'},exchange:{path:['exchange'],type:'string'},volume:{path:['volume'],type:'number'}}},
 storage:{mode:'latest',fields:['symbol','price']},destination:{kind:'market-prices',market:{venue:'robinhood',instance:'production',kind:'equity'},symbolField:'symbol',priceField:'price',currency:'USD',policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true,
 conditions:[{field:'symbol',op:'in',values:['AAPL','MSFT','MISSING']},{field:'exchange',op:'equals',value:'NASDAQ'},{field:'volume',op:'gte',value:100}]}}]});
test('routed configuration rejects missing mapping fields, incompatible criteria and unbounded conditions',()=>{
 const config=routedConfig(),feed=config.feeds[0];
 for(const change of [{symbolField:'absent'},{priceField:'volume'},{conditions:[{field:'absent',op:'equals',value:1}]},{conditions:[{field:'symbol',op:'gt',value:1}]},{conditions:[{field:'volume',op:'equals',value:'100'}]},{conditions:Array.from({length:17},()=>({field:'volume',op:'gte',value:100}))},{allowSharedPriceWrites:false}]){
  expect(()=>websocketSourceConfig.parse({...config,feeds:[{...feed,destination:{...feed.destination,...change}}]})).toThrow();
 }
});
test('routed writes filter rows and isolate market ordering, throttling, preview and revision fences',async()=>{
 const db=new PGlite();await migrate(db);let now=Date.parse('2026-10-21T12:00:00Z');
 const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)},storage=createObservationStorage(database,{automatic:false,now:()=>now});
 try{
  const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
  const repo=createSourceRepository(database),config=routedConfig(),source=await repo.save(owner,config);
  await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
  for(const symbol of ['AAPL','MSFT','TSLA'])await db.query('INSERT INTO market_quotes(symbol,price,observed_at) VALUES($1,100,$2)',[symbol,new Date(now-120000)]);
  const observation=(symbol:string,price:string,time=now,extra:Record<string,unknown>={}):DataObservation=>({...mapHttpSample(config,'prices',{symbol,price,time,exchange:'NASDAQ',volume:100,...extra}),sourceId:source.id,feedId:'prices',configVersion:1,schemaVersion:1,epoch:1,unit:'USD',adapterId:'custom-websocket',adapterVersion:'1',receivedAt:now,timeBasis:'provider',clockSkewMs:0});
  const prices=async()=>(await db.query<{symbol:string;price:string}>('SELECT symbol,price::text FROM market_quotes ORDER BY symbol')).rows.map(r=>[r.symbol,Number(r.price)]);
  const preview=await db.transaction(tx=>applyDestination(tx,owner,config.feeds[0],observation('AAPL','120'),now,true));
  expect(preview).toMatchObject({target:'market_quotes:AAPL',outcome:'would-write'});expect(await prices()).toEqual([['AAPL',100],['MSFT',100],['TSLA',100]]);
  // Same receipt millisecond and interleaved provider times must still write both rows.
  for(const o of [observation('AAPL','120'),observation('MSFT','130',now-1000),observation('TSLA','999'),observation('AAPL','999',now,{exchange:'OTHER'}),observation('MSFT','999',now,{volume:99})])expect(storage.enqueue(owner,o)).toBe(true);
  await storage.flush();expect(await prices()).toEqual([['AAPL',120],['MSFT',130],['TSLA',100]]);
  now+=1000;storage.enqueue(owner,observation('AAPL','121'));await storage.flush();expect((await prices())[0]).toEqual(['AAPL',120]);
  now+=5000;storage.enqueue(owner,observation('AAPL','122'));storage.enqueue(owner,observation('MSFT','999',now-20000));await storage.flush();
  expect(await prices()).toEqual([['AAPL',122],['MSFT',130],['TSLA',100]]);
  for(const [o,outcome] of [[observation('AAPL','0'),'invalid'],[observation('MISSING','1'),'missing-market'],[observation('AAPL','1',now-61000),'stale'],[observation('AAPL','1',now,{exchange:'OTHER'}),'filtered']] as const){
   expect(await db.transaction(tx=>applyDestination(tx,owner,config.feeds[0],o,now,true))).toMatchObject({outcome});
  }
  now+=6000;storage.enqueue(owner,observation('AAPL','999'));await repo.save(owner,config,{id:source.id,revision:1});await storage.flush();expect((await prices())[0]).toEqual(['AAPL',122]);
 }finally{await storage.close();await db.close();}
});

test('routed numeric conditions use strict boundary comparisons without string coercion',async()=>{
 const db=new PGlite();await migrate(db);const now=Date.now();
 try{
  const feed=routedConfig().feeds[0];if(feed.destination?.kind!=='market-prices')throw Error();
  const o:DataObservation={sourceId:'11111111-1111-4111-8111-111111111111',feedId:'prices',configVersion:1,schemaVersion:1,epoch:1,unit:'USD',adapterId:'custom-websocket',adapterVersion:'1',receivedAt:now,eventTime:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{symbol:'AAPL',price:'120',volume:100}}};
  for(const [op,match] of [['gt',false],['gte',true],['lt',false],['lte',true]] as const){
   const configured={...feed,destination:{...feed.destination,conditions:[{field:'volume',op,value:100}]}};
   expect(await db.transaction(tx=>applyDestination(tx,'owner',configured,o,now,true))).toMatchObject({outcome:match?'missing-market':'filtered'});
  }
 }finally{await db.close();}
});

test('instrument and external IDs resolve exactly without symbol fallback or creating markets',async()=>{
 const db=new PGlite();await migrate(db);const now=Date.now();
 try{
  await db.query('INSERT INTO market_quotes(symbol,price,observed_at) VALUES($1,100,$2)',['AAPL',new Date(now-120000)]);
  const config=routedConfig(),feed=config.feeds[0];if(feed.destination?.kind!=='market-prices')throw Error();
  const id='11111111-1111-4111-8111-111111111111';
  const destination={...feed.destination,conditions:[],identifier:{kind:'instrument-id' as const,mappings:[{from:id,to:'AAPL'}]}};
  const parsed=websocketSourceConfig.parse({...config,feeds:[{...feed,destination}]});
  const configured=parsed.feeds[0];
  const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
  const source=await createSourceRepository({use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)}).save(owner,parsed);
  const observation=(value:string):DataObservation=>({sourceId:source.id,feedId:'prices',configVersion:1,schemaVersion:1,epoch:1,unit:'USD',adapterId:'custom-websocket',adapterVersion:'1',receivedAt:now,eventTime:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{symbol:value,price:'120'}}});
  const apply=(value:string,dry=true)=>db.transaction(tx=>applyDestination(tx,'owner',configured,observation(value),now,dry));
  expect(await apply(id)).toMatchObject({target:'market_quotes:AAPL',outcome:'would-write'});
  expect(await apply('AAPL')).toMatchObject({outcome:'missing-market'});
  expect(await apply(id+' ')).toMatchObject({outcome:'missing-market'});
  expect(await apply(id,false)).toMatchObject({outcome:'written'});
  expect(Number((await db.query<{price:string}>("SELECT price::text FROM market_quotes WHERE symbol='AAPL'")).rows[0].price)).toBe(120);
  for(const identifier of [{kind:'instrument-id',mappings:[{from:'AAPL',to:'AAPL'}]},{kind:'external-id',mappings:[{from:'42',to:'AAPL'},{from:'42',to:'MSFT'}]},{kind:'external-id',mappings:[]},{kind:'product-id'},{kind:'external-id',mappings:[{from:'42',to:'BTC-USD!'}]}]){
   expect(()=>websocketSourceConfig.parse({...config,feeds:[{...feed,destination:{...destination,identifier}}]})).toThrow();
  }
 }finally{await db.close();}
});
