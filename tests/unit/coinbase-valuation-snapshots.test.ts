import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../src/main/migrations';
import {createCoinbaseSourceSettings} from '../../src/main/data-sources/coinbase-stream/source-settings';
import {sampleCoinbaseValuation,createCoinbaseValuationSnapshots} from '../../src/main/coinbase/valuation-snapshots';
const saved={portfolio:{totalValue:'210',currency:'USD',cash:'10',buyingPower:null},warnings:[],spotPositions:[{instrumentRef:'coinbase:BTC',asset:'BTC',quantity:'2',marketValue:'200',availableValue:'200',currency:'USD',isCash:false},{instrumentRef:'coinbase:USD',asset:'USD',quantity:'10',marketValue:'10',availableValue:'10',currency:'USD',isCash:true}]};
test('sampled valuations require fresh holdings, full price coverage and supported cash',()=>{
 const time=1000000,quotes=[{product:'BTC-USD',price:'110',eventTime:time}];
 expect(sampleCoinbaseValuation(saved,time,time,quotes)).toMatchObject({quality:'complete',totalValue:'230',prices:quotes});
 expect(saved.portfolio.totalValue).toBe('210');
 expect(sampleCoinbaseValuation(saved,time-900001,time,quotes)).toMatchObject({quality:'incomplete',reason:'stale_holdings',totalValue:null});
 expect(sampleCoinbaseValuation(saved,time,time,[])).toMatchObject({reason:'missing_price'});
 expect(sampleCoinbaseValuation(saved,time,time,[{...quotes[0],eventTime:time-15001}])).toMatchObject({reason:'missing_price'});
 expect(sampleCoinbaseValuation({...saved,warnings:['futures']},time,time,quotes)).toMatchObject({reason:'unsupported_holdings'});
 expect(sampleCoinbaseValuation({...saved,portfolio:{...saved.portfolio,totalValue:'999'}},time,time,quotes)).toMatchObject({reason:'holdings_coverage'});
 expect(sampleCoinbaseValuation({...saved,spotPositions:[saved.spotPositions[0],{...saved.spotPositions[1],asset:'USDC'}]},time,time,quotes)).toMatchObject({reason:'unsupported_cash'});
});
test('minute snapshots are separate, revision fenced, deduplicated, retained and stopped safely',async()=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:any)=>Promise<T>)=>fn(db)};
 const source=await createCoinbaseSourceSettings(database).load();let now=Date.now(),allowed=true,quotes=[{product:'BTC-USD',price:'110',eventTime:now}];const errors=vi.fn();
 let writer=createCoinbaseValuationSnapshots(database,()=>({revision:source.revision,quotes}),()=>allowed,()=>now,errors);
 try{
  const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic' FROM local_owners RETURNING id")).rows[0].id;
  const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'fixture','fixture') RETURNING id",[connection])).rows[0].id;
  await db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)',[account,new Date(now),JSON.stringify(saved)]);
  await db.query("INSERT INTO coinbase_portfolio_sync(account_id,state,attempted_at) VALUES($1,'completed',$2)",[account,new Date(now)]);
  await writer.tick();await writer.tick();
  expect((await db.query('SELECT quality,total_value,source_revision FROM coinbase_valuation_snapshots')).rows).toEqual([{quality:'complete',total_value:'230',source_revision:source.revision}]);
  await writer.close();writer=createCoinbaseValuationSnapshots(database,()=>({revision:source.revision,quotes}),()=>allowed,()=>now,errors);await writer.tick();
  expect((await db.query('SELECT * FROM coinbase_valuation_snapshots')).rows).toHaveLength(1);
  now+=60000;quotes=[];await writer.tick();expect((await db.query('SELECT quality,total_value FROM coinbase_valuation_snapshots ORDER BY bucket')).rows[1]).toEqual({quality:'incomplete',total_value:null});
  allowed=false;now+=60000;await writer.tick();expect((await db.query('SELECT * FROM coinbase_valuation_snapshots')).rows).toHaveLength(2);
  allowed=true;await db.query('UPDATE data_sources SET enabled=false WHERE id=$1',[source.id]);await writer.tick();expect((await db.query('SELECT * FROM coinbase_valuation_snapshots')).rows).toHaveLength(2);
  await db.query('UPDATE data_sources SET enabled=true WHERE id=$1',[source.id]);
  now+=31*86400000;await writer.tick();expect((await db.query("SELECT total_value FROM coinbase_valuation_snapshots WHERE quality='complete'")).rows).toEqual([{total_value:'230'}]);
  now+=367*86400000;await writer.tick();expect((await db.query('SELECT quality,reason FROM coinbase_valuation_snapshots')).rows).toEqual([{quality:'incomplete',reason:'stale_holdings'}]);
  expect((await db.query<{data:unknown}>('SELECT data FROM coinbase_portfolio_observations')).rows).toEqual([{data:saved}]);
  expect((await db.query("SELECT * FROM public_price_cache WHERE kind='candles'")).rows).toHaveLength(0);
  await writer.close();now+=60000;await writer.tick();expect((await db.query('SELECT * FROM coinbase_valuation_snapshots')).rows).toHaveLength(1);expect(errors).not.toHaveBeenCalled();
 }finally{await writer.close();await db.close();}
});
