import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createCryptoModel} from '../../../src/main/assets/crypto-model';
import {createCryptoPriceHistory} from '../../../src/main/assets/crypto-price-history';
import {basketSchema,instrumentKey} from '../../../src/shared/strategies';
import {computeModelValuations} from '../../../src/main/strategies/model-valuation';
import {createStrategyPerformance} from '../../../src/main/strategies/performance';
async function fixture(schedule:'never'|'daily'='never'){
 const db=new PGlite();await migrate(db);
 const database={use:async<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic','test',true,true) RETURNING id`,[connection])).rows[0].id;
 const spec=basketSchema.parse({schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'BTC-USD',market:{venue:'robinhood',instance:'production',kind:'crypto',reference:'btc'}},bps:5000}],cashBps:5000},rebalance:{schedule,driftBandPoints:null,driftBandRelative:null}});
 const strategy=randomUUID(),id=randomUUID();
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,[id,strategy,JSON.stringify(spec)]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,id]);
 let now=Date.parse('2026-10-15T15:00:00Z');const clock=()=>now;
 const model=createCryptoModel(database,clock),cache=createCryptoPriceHistory(database,clock),version={id,sequence:1,spec};
 const quote=async(day:string,price:string,routing='route-a',previousClose:string|null=null)=>{now=Date.parse(day+'T15:00:00Z');await cache.record(account,[{pairId:'btc',symbol:'BTC-USD',routing,mark:price,previousClose,observedAt:new Date(now).toISOString()}]);};
 return {db,database,account,strategy,version,model,quote,clock};
}
test('sync seeds durable exact-identity units; buy and hold resumes across gaps without resetting',async()=>{
 const f=await fixture();try{
  await f.model.refresh(f.account);expect(await f.model.read(f.db,f.account,f.version)).toEqual({ready:false,reason:'baseline_pending'});
  await f.quote('2026-10-15','100');await f.model.refresh(f.account);
  await f.quote('2026-10-19','200');await f.model.refresh(f.account);
  const restarted=createCryptoModel(f.database,f.clock),result=await restarted.read(f.db,f.account,f.version);
  expect(result.ready).toBe(true);if(!result.ready)throw Error('missing model');
  expect(result.current.units[instrumentKey(f.version.spec.target.weights[0].instrument)]).toBe('0.5');
  expect(result.current.unitValue).toBe('150');expect(result.rows).toHaveLength(1);
  expect(await restarted.read(f.db,randomUUID(),f.version)).toEqual({ready:false,reason:'baseline_pending'});
  const performance=createStrategyPerformance(f.database,async()=>{throw Error('no equity calls');},async()=>new Map(),async()=>f.account,f.clock,async()=>null,undefined,restarted.read);
  const view=await performance.performance(f.strategy,'all','model');
  expect(view?.points.at(-1)?.unitValue).toBe('150');expect(view?.stats[0].allTimeReturnPercent).toBe('50.00');expect(view?.stats[0].startedAt).toBe('2026-10-15T15:00:00.000Z');
  await f.quote('2026-10-20','200','route-b');expect(await restarted.read(f.db,f.account,f.version)).toEqual({ready:false,reason:'routing_changed'});
 }finally{await f.db.close();}
});
test('daily models require every intervening rebalance close and replay without repeated rebalancing',async()=>{
 const f=await fixture('daily');try{
  await f.quote('2026-10-15','100');await f.model.refresh(f.account);
  await f.quote('2026-10-17','200','route-a','150');
  const first=await f.model.read(f.db,f.account,f.version);
  expect(first.ready).toBe(true);if(!first.ready)throw Error('missing model');
  expect(Number(first.current.unitValue)).toBeCloseTo(145.833333,5);
  expect(await f.model.read(f.db,f.account,f.version)).toEqual(first);
  await f.quote('2026-10-19','200','route-a','200');
  expect(await f.model.read(f.db,f.account,f.version)).toEqual({ready:false,reason:'history_gap'});
 }finally{await f.db.close();}
});
test('unknown routing cannot seed a model and strict closes never carry through a missing crypto day',async()=>{
 const f=await fixture();try{
  await f.quote('2026-10-15','100','unknown');await f.model.refresh(f.account);
  expect(await f.model.read(f.db,f.account,f.version)).toEqual({ready:false,reason:'baseline_pending'});
  const rows=computeModelValuations({allocations:[{id:'a',sequence:1,effectiveOn:'2026-10-15',weights:[{symbol:'pair',weightPercent:100}],cashPercent:0}],days:['2026-10-15','2026-10-16'],closesBySymbol:new Map([['pair',[{day:'2026-10-15',close:'100'}]]]),exactCloseSymbols:new Set(['pair'])});
  expect(rows.map(r=>r.valuedOn)).toEqual(['2026-10-15']);
 }finally{await f.db.close();}
});

test('drift models refuse missing days even with no scheduled rebalance',async()=>{
 const f=await fixture();try{
  f.version.spec.rebalance.driftBandPoints=5;
  await f.quote('2026-10-15','100');await f.model.seed(f.db,f.account,f.version);
  await f.quote('2026-10-18','200','route-a','200');
  expect(await f.model.read(f.db,f.account,f.version)).toEqual({ready:false,reason:'history_gap'});
 }finally{await f.db.close();}
});

test('mixed model keeps same-ticker equity and crypto units separate and requires both price sources',async()=>{
 const f=await fixture();try{
  const version={...f.version,id:randomUUID(),sequence:2,spec:basketSchema.parse({...f.version.spec,target:{weights:[f.version.spec.target.weights[0],{instrument:{venue:'robinhood',symbol:'BTC'},bps:5000}],cashBps:0}})};
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,2,1,'{}',$3,'{}','{}' FROM local_owners`,[version.id,f.strategy,JSON.stringify(version.spec)]);
  const model=createCryptoModel(f.database,f.clock,async()=>new Map());
  await f.quote('2026-10-15','100');
  await model.seed(f.db,f.account,version);
  expect(await model.read(f.db,f.account,version)).toMatchObject({ready:false,reason:'baseline_pending'});
  await f.db.query(`INSERT INTO market_quotes(symbol,price,observed_at) VALUES('BTC',10,$1)`,[new Date(f.clock()).toISOString()]);
  await model.seed(f.db,f.account,version);
  await f.quote('2026-10-16','200');
  expect(await model.read(f.db,f.account,version)).toMatchObject({ready:false,reason:'quotes_unavailable'});
  await f.db.query(`UPDATE market_quotes SET price=20,observed_at=$1 WHERE symbol='BTC'`,[new Date(f.clock()).toISOString()]);
  const result=await model.read(f.db,f.account,version);
  expect(result.ready).toBe(true);if(!result.ready)throw Error('model unavailable');
  expect(result.current.units.BTC).toBe('5');expect(result.current.units[instrumentKey(version.spec.target.weights[0].instrument)]).toBe('0.5');
  expect(result.current.unitValue).toBe('200');
 }finally{await f.db.close();}
});
