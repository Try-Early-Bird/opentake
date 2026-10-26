import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createPriceStore,newestSettledTradingDay,quoteInterval} from '../../../src/main/market-series/price-store';
import {ConnectionFailure} from '../../../src/main/connection-errors';

// Friday 2026-10-02, 18:00 Eastern: that session has settled.
const evening=Date.parse('2026-10-02T22:00:00Z');

async function fixture(options:{busy?:boolean;connected?:boolean;failure?:boolean;listed?:string[]}={}){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=evening;
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const accountId=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const calls:{name:string;args:Record<string,unknown>}[]=[];
 const status=async()=>({status:'connected',checkedAt:null,accounts:[{id:accountId,selected:true,agenticAllowed:true,maskedNumber:'fixture',nickname:null,accountType:'cash'}]});
 const readTool=async(name:string,args:Record<string,unknown>)=>{
  if(name==='get_portfolio')return {total_value:'100',cash:'10',buying_power:'10'};
  if(name==='get_equity_positions')return {results:[{instrument_id:'aapl',symbol:'AAPL',quantity:'1'}]};
  if(name==='get_equity_quotes'){calls.push({name,args});if(options.busy)throw new ConnectionFailure('busy');if(options.failure)throw new ConnectionFailure('reauth_required');return {results:(args.symbols as string[]).map(symbol=>({symbol,last_trade_price:'101',previous_close:'100'}))};}
  if(name==='get_equity_historicals'){calls.push({name,args});
   const days=['2026-09-30','2026-10-01','2026-10-02','2026-10-05'];
   return {results:(args.symbols as string[]).map(symbol=>({symbol,bars:days.map((d,i)=>({begins_at:`${d}T13:30:00Z`,open_price:'1',high_price:'1',low_price:'1',close_price:String(100+i),volume:'1',session:'reg'}))}))};}
  return {results:[]};
 };
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{status,readTool} as never,()=>now);
 await sync.synchronize();
 // A committed strategy targeting MSFT.
 const strategy='77777777-7777-4777-8777-777777777777',version='88888888-8888-4888-8888-888888888888';
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
  SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,[version,strategy,JSON.stringify({target:{weights:[{instrument:{venue:'robinhood',symbol:'MSFT'},bps:10000}],cashBps:0}})]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 calls.length=0;
 const storeStatus=async()=>({...await status(),status:options.connected===false?'disconnected':'connected'});
 const store=createPriceStore(database,{status:storeStatus,readTool} as never,()=>now,undefined,()=>options.listed??[]);
 return {db,store,calls,later:(ms:number)=>{now+=ms;},close:async()=>{sync.cancel();await db.close();}};
}

test('watches held, targeted and benchmark symbols; stores quotes and settled daily closes',async()=>{
 const f=await fixture();try{
  expect(await f.store.watched()).toEqual(['AAPL','MSFT','SPY']);
  await f.store.tick();
  expect(f.calls.map(c=>c.name)).toEqual(['get_equity_quotes','get_equity_historicals']);
  expect(f.calls[1]!.args).toMatchObject({symbols:['AAPL','MSFT','SPY'],interval:'day',bounds:'regular',adjustment_type:'split'});
  expect((await f.db.query(`SELECT symbol,price::text,previous_close::text FROM market_quotes ORDER BY symbol`)).rows).toHaveLength(3);
  // Monday's bar is after the newest settled session (Friday) and is not stored.
  const closes=await f.store.closes(['AAPL'],null);
  expect(closes.get('AAPL')).toEqual([{day:'2026-09-30',close:'100'},{day:'2026-10-01',close:'101'},{day:'2026-10-02',close:'102'}]);
  expect(await f.store.covers(['AAPL'],'2026-09-30')).toBe(true);
  expect(await f.store.covers(['AAPL','QQQ'],'2026-09-30')).toBe(false);
  expect(await f.store.covers(['AAPL'],'2025-01-01')).toBe(false);
 }finally{await f.close();}
});

test('polls only what is due and tops up closes incrementally',async()=>{
 const f=await fixture();try{
  await f.store.tick();f.calls.length=0;
  // Ten minutes later, after hours: quotes are hourly when not watched; closes are current.
  f.later(10*60_000);await f.store.tick();
  expect(f.calls).toEqual([]);
  // Next settled session: closes are behind and re-read from a week before the last stored day.
  f.later(3*86_400_000);await f.store.tick();
  const history=f.calls.find(c=>c.name==='get_equity_historicals');
  expect(history?.args.start_time).toBe('2026-09-25T00:00:00.000Z');
 }finally{await f.close();}
});

test('a busy or disconnected connection skips the tick without error',async()=>{
 const busy=await fixture({busy:true});try{await expect(busy.store.tick()).resolves.toBeUndefined();}finally{await busy.close();}
 const offline=await fixture({connected:false});try{await offline.store.tick();expect(offline.calls).toEqual([]);}finally{await offline.close();}
});

test('cadence follows the session and settled days skip weekends',()=>{
 expect(newestSettledTradingDay(Date.parse('2026-10-05T15:00:00Z'))).toBe('2026-10-02');
 expect(newestSettledTradingDay(Date.parse('2026-10-05T21:00:00Z'))).toBe('2026-10-05');
 expect(quoteInterval(Date.parse('2026-10-05T15:00:00Z'),true)).toBe(60_000);
 expect(quoteInterval(Date.parse('2026-10-05T15:00:00Z'),false)).toBe(300_000);
 expect(quoteInterval(Date.parse('2026-10-04T15:00:00Z'),true)).toBe(3_600_000);
});

test('chart series persist in the store and the poller keeps today’s held series warm',async()=>{
 const f=await fixture();try{
  const series={symbol:'AAPL',interval:'5minute' as const,bounds:'24_5' as const,baseline:null,price:'101',extendedPrice:null,extendedSession:null,change:null,extendedChange:null,points:[]};
  await f.store.seriesCache.save('1d',[{symbol:'AAPL',at:evening,series}]);
  // A fresh store over the same database (as after a restart) reads it back.
  const again=createPriceStore({use:fn=>fn(f.db)},{status:async()=>({status:'connected',accounts:[]}),readTool:async()=>({})} as never,()=>evening);
  expect((await again.seriesCache.load('1d',['AAPL','MSFT'])).get('AAPL')).toEqual({at:evening,series});
  expect((await again.seriesCache.load('1w',['AAPL'])).size).toBe(0);
  const warmed:string[][]=[];
  const warming=createPriceStore({use:fn=>fn(f.db)},{status:async()=>({status:'connected',accounts:[{selected:true,agenticAllowed:true}]}),readTool:async()=>({results:[]})} as never,()=>evening,async held=>{warmed.push(held);});
  await warming.tick();
  expect(warmed).toEqual([['AAPL']]);
 }finally{await f.close();}
});

test('active targets after the old 200-symbol boundary remain watched and quoted',async()=>{
 const f=await fixture();try{
 const symbols=Array.from({length:205},(_,i)=>'A'+String.fromCharCode(65+Math.floor(i/26))+String.fromCharCode(65+i%26));
 const next='99999999-9999-4999-8999-999999999999';
 await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
 SELECT $1,strategy_id,owner_id,2,schema_version,metadata,jsonb_set(spec,'{target,weights}',$2),provenance,verification FROM strategy_versions LIMIT 1`,[next,JSON.stringify(symbols.map(symbol=>({instrument:{venue:'robinhood',symbol},bps:1})))]);
 await f.db.query('UPDATE strategies SET current_version_id=$1',[next]);
 const watched=await f.store.watched();expect(watched).toContain(symbols.at(-1));expect(watched.length).toBeGreaterThan(200);
 await f.store.tick();expect(f.calls.filter(c=>c.name==='get_equity_quotes').flatMap(c=>c.args.symbols)).toContain(symbols.at(-1));
 }finally{await f.close();}
});

test('price failures identify the venue, operation, symbols and safe connection error',async()=>{
 const f=await fixture({failure:true});try{await expect(f.store.tick()).rejects.toMatchObject({details:{venue:'robinhood',operation:'quotes',symbols:['AAPL','MSFT','SPY'],errorCode:'reauth_required'}});}finally{await f.close();}
});
test('equity price watchlist excludes Coinbase strategy symbols',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE strategies SET current_version_id=NULL,status='draft'");
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
   SELECT '99999999-9999-4999-8999-999999999999',id,owner_id,2,1,'{}',$1,'{}','{}' FROM strategies`,[JSON.stringify({target:{weights:[{instrument:{venue:'coinbase',symbol:'ZEC'},bps:10000}],cashBps:0}})]);
  await f.db.query("UPDATE strategies SET current_version_id='99999999-9999-4999-8999-999999999999',status='committed'");
  expect(await f.store.watched()).toEqual(['AAPL','SPY']);
 }finally{await f.close();}
});

test('broker refresh resets custom price provenance when it replaces a quote', async () => {
 const f=await fixture();try{
  await f.store.tick();
  await f.db.query("UPDATE market_quotes SET price_provider='custom-http',price_source_revision=1,price_source_feed='fixture' WHERE symbol='AAPL'");
  f.later(3600001);await f.store.tick();
  expect((await f.db.query("SELECT price_provider,price_source_id,price_source_revision,price_source_feed FROM market_quotes WHERE symbol='AAPL'")).rows[0]).toEqual({price_provider:'robinhood',price_source_id:null,price_source_revision:null,price_source_feed:null});
 }finally{await f.close();}
});

test('equities on lists the member viewed are quoted but never pull daily-close history',async()=>{
 const f=await fixture({listed:['TSLA','AAPL','bad ticker']});try{
  expect(await f.store.watched()).toEqual(['AAPL','MSFT','SPY']);
  await f.store.tick();
  expect(f.calls.map(c=>[c.name,c.args.symbols])).toEqual([['get_equity_quotes',['AAPL','MSFT','SPY','TSLA']],['get_equity_historicals',['AAPL','MSFT','SPY']]]);
  expect((await f.db.query(`SELECT symbol FROM market_quotes ORDER BY symbol`)).rows.map(r=>(r as {symbol:string}).symbol)).toEqual(['AAPL','MSFT','SPY','TSLA']);
 }finally{await f.close();}
});
