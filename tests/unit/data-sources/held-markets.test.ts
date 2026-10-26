import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {expect,test} from 'vitest';
import {migrate} from '../../../src/main/migrations';
import {heldEquityMarket} from '../../../src/main/data-sources/held-markets';
import {createSourceRepository} from '../../../src/main/data-sources/repository';
import {applyDestination} from '../../../src/main/data-sources/destinations';
import {websocketSourceConfig} from '../../../src/main/data-sources/websocket/adapter';
import type {DataObservation} from '../../../src/shared/data-sources';
async function fixture(){
 const db=new PGlite();await migrate(db);const now=Date.parse('2026-10-21T12:00:00Z');
 const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id,connection=randomUUID(),a=randomUUID(),b=randomUUID();
 await db.query("INSERT INTO platform_connections(id,owner_id,venue,status) VALUES($1,$2,'robinhood','connected')",[connection,owner]);
 for(const id of [a,b])await db.query("INSERT INTO linked_accounts(id,connection_id,external_ref,masked_number,agentic_allowed) VALUES($1,$2,$1::uuid::text,'fixture',true)",[id,connection]);
 async function snapshot(account:string,data:unknown,at=now){
  const run=randomUUID(),id=randomUUID();
  await db.query("INSERT INTO account_sync_runs(id,account_id,resource,state,started_at,finished_at) VALUES($1,$2,'equity_positions','completed',$3,$3)",[run,account,new Date(at)]);
  await db.query("INSERT INTO position_snapshots(id,account_id,asset_class,payload_hash,data) VALUES($1,$2,'equity',$1::uuid::text,$3)",[id,account,JSON.stringify(data)]);
  await db.query("INSERT INTO account_observations(id,run_id,account_id,resource,observed_at,position_snapshot_id) VALUES($1,$2,$3,'equity_positions',$4,$5)",[randomUUID(),run,account,new Date(at),id]);
  await db.query("INSERT INTO account_sync_checkpoints(account_id,resource,watermark,discovery_complete) VALUES($1,'equity_positions',$2,true) ON CONFLICT(account_id,resource) DO UPDATE SET watermark=excluded.watermark",[account,new Date(at)]);
 }
 const selection={accountIds:[a],maxAgeMs:900000};
 return {db,owner,connection,a,b,now,selection,snapshot,read:(symbol:string,time=now,selected=selection)=>heldEquityMarket(db,owner,selected,symbol,time)};
}
test('holdings selection follows exact selected accounts, zero/short quantities and latest empty positions',async()=>{
 const f=await fixture();try{
  expect(await f.read('AAPL')).toBe('unavailable');
  await f.snapshot(f.a,[{symbol:'AAPL',quantity:'0.001'},{symbol:'MSFT',quantity:'0.000'},{symbol:'NVDA',quantity:'-2'}]);
  await f.snapshot(f.b,[{symbol:'TSLA',quantity:'1'}]);
  expect(await f.read('AAPL')).toBe('held');expect(await f.read('MSFT')).toBe('not-held');expect(await f.read('NVDA')).toBe('held');expect(await f.read('TSLA')).toBe('not-held');
  expect(await f.read('TSLA',f.now,{...f.selection,accountIds:[f.a,f.b]})).toBe('held');
  await f.snapshot(f.a,[],f.now+1);expect(await f.read('AAPL',f.now+1)).toBe('not-held');
 }finally{await f.db.close();}
});
test('holdings selection rejects stale, future, malformed, inaccessible and foreign account evidence',async()=>{
 const f=await fixture();try{
  await f.snapshot(f.a,[{symbol:'AAPL',quantity:'1'}]);
  expect(await f.read('AAPL',f.now+900001)).toBe('unavailable');expect(await f.read('AAPL',f.now-1)).toBe('unavailable');
  expect(await heldEquityMarket(f.db,randomUUID(),f.selection,'AAPL',f.now)).toBe('unavailable');
  expect(await f.read('AAPL',f.now,{...f.selection,accountIds:[f.a,f.b]})).toBe('unavailable');
  await f.db.query('UPDATE linked_accounts SET available=false WHERE id=$1',[f.a]);expect(await f.read('AAPL')).toBe('unavailable');
  await f.db.query('UPDATE linked_accounts SET available=true,agentic_allowed=false WHERE id=$1',[f.a]);expect(await f.read('AAPL')).toBe('unavailable');
  await f.db.query('UPDATE linked_accounts SET agentic_allowed=true WHERE id=$1',[f.a]);
  await f.db.query("UPDATE platform_connections SET status='disconnected' WHERE id=$1",[f.connection]);expect(await f.read('AAPL')).toBe('unavailable');
  await f.db.query("UPDATE platform_connections SET status='connected' WHERE id=$1",[f.connection]);
  await f.snapshot(f.a,[{symbol:'AAPL',quantity:'not-a-number'}],f.now+1);expect(await f.read('AAPL',f.now+1)).toBe('unavailable');
 }finally{await f.db.close();}
});
test('routed destination previews and writes use holdings selection and source admission rejects unknown accounts',async()=>{
 const f=await fixture();try{
  const config=websocketSourceConfig.parse({transport:'websocket',name:'Held stocks',collection:'automatic',connection:{endpoint:'wss://fixture.example/prices',auth:{mode:'none'},subscription:{body:{op:'subscribe'}},acknowledgement:{success:{path:['op'],equals:'ok'},failure:{path:['op'],equals:'error'}}},feeds:[{id:'price',name:'Prices',unit:'USD',eventTimePath:['time'],mapping:{kind:'event',fields:{symbol:{path:['symbol'],type:'string'},price:{path:['price'],type:'string'}}},storage:{mode:'latest',fields:['symbol','price']},destination:{kind:'market-prices',market:{venue:'robinhood',instance:'production',kind:'equity'},symbolField:'symbol',priceField:'price',currency:'USD',policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true,holdings:f.selection}}]});
  const repository=createSourceRepository({use:work=>work(f.db)}),source=await repository.save(f.owner,config),feed=config.feeds[0];
  if(feed.destination?.kind!=='market-prices')throw Error();
  await expect(repository.save(f.owner,{...config,feeds:[{...feed,destination:{...feed.destination,holdings:{...f.selection,accountIds:[randomUUID()]}}}]})).rejects.toThrow('unavailable');
  await f.db.query("INSERT INTO market_quotes(symbol,price,observed_at) VALUES('AAPL',100,$1)",[new Date(f.now-120000)]);
  const o:DataObservation={sourceId:source.id,feedId:'price',configVersion:1,schemaVersion:1,epoch:1,unit:'USD',adapterId:'custom-websocket',adapterVersion:'1',receivedAt:f.now,eventTime:f.now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{symbol:'AAPL',price:'120'}}};
  const apply=(dry=false)=>f.db.transaction(tx=>applyDestination(tx,f.owner,feed,o,f.now,dry));
  expect(await apply()).toMatchObject({outcome:'holdings-unavailable'});
  await f.snapshot(f.a,[]);expect(await apply()).toMatchObject({outcome:'filtered'});
  await f.snapshot(f.a,[{symbol:'AAPL',quantity:'1'}],f.now+1);o.eventTime=o.receivedAt=++f.now;
  expect(await apply(true)).toMatchObject({outcome:'would-write'});
  expect(Number((await f.db.query<{price:string}>('SELECT price FROM market_quotes')).rows[0].price)).toBe(100);
  expect(await apply()).toMatchObject({outcome:'written'});
  expect(Number((await f.db.query<{price:string}>('SELECT price FROM market_quotes')).rows[0].price)).toBe(120);
 }finally{await f.db.close();}
});

test('crypto selectors use exact selected Coinbase accounts and reject stale or inaccessible holdings',async()=>{
 const {heldCryptoMarket}=await import('../../../src/main/data-sources/held-markets');
 const f=await fixture();try{
  await f.db.query("UPDATE platform_connections SET venue='coinbase',external_account_ref='fixture' WHERE id=$1",[f.connection]);
  const save=(id:string,positions:unknown,at=f.now)=>f.db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)',[id,new Date(at),JSON.stringify({spotPositions:positions})]);
  const position=(asset:string,quantity='1',isCash=false)=>({asset,quantity,isCash,currency:'USD'});
  const read=(product:string,now=f.now)=>heldCryptoMarket(f.db,f.owner,f.selection,product,now);
  expect(await read('BTC-USD')).toBe('unavailable');
  await save(f.a,[position('BTC','0.01'),position('ZEC','0'),position('USDC','10',true)]);await save(f.b,[position('ETH')]);
  expect(await read('BTC-USD')).toBe('held');expect(await read('BTC-EUR')).toBe('not-held');expect(await read('ETH-USD')).toBe('not-held');expect(await read('ZEC-USD')).toBe('not-held');expect(await read('USDC-USD')).toBe('not-held');
  expect(await read('BTC-USD',f.now+900001)).toBe('unavailable');expect(await read('BTC-USD',f.now-1)).toBe('unavailable');
  expect(await heldCryptoMarket(f.db,randomUUID(),f.selection,'BTC-USD',f.now)).toBe('unavailable');
  await f.db.query('UPDATE linked_accounts SET agentic_allowed=false WHERE id=$1',[f.a]);expect(await read('BTC-USD')).toBe('unavailable');
  await f.db.query('UPDATE linked_accounts SET agentic_allowed=true WHERE id=$1',[f.a]);
  await save(f.a,[],f.now+1);expect(await read('BTC-USD',f.now+1)).toBe('not-held');
 }finally{await f.db.close();}
});
