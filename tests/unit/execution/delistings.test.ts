import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {deriveAllocationPnl} from '../../../src/main/allocations/allocation-pnl';
import {DELISTING_MISSING_DAYS,delistedMarks,observeDelistings} from '../../../src/main/execution/delistings';
import {parseRead} from '../../../src/main/opentake-mcp/catalog';
import {computeModelValuations} from '../../../src/main/strategies/model-valuation';

// Delistings on synthetic data: an allocation bought 5 XYZ
// on Sep 28; XYZ stops closing after Sep 29 while SPY keeps closing.
const now='2026-10-05T14:00:00.000Z';
const closes=(days:string[],price='10')=>days.map(day=>({day,close:price}));
const current=closes(['2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02'],'500');

async function fixture(){
 const db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const clock=()=>Date.parse('2026-09-28T15:00:00Z');
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'xyz',symbol:'XYZ',quantity:'5',mark_price:'10'}]}:{results:[]},
 } as never,clock);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,
  [version,strategy,JSON.stringify({schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'XYZ'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}})]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const core=createAllocationCore(database,clock);
 const invested=await core.invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'50',cause:randomUUID()});
 const at='2026-09-28T15:00:00.000Z';
 await db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','fill-1','equity','filled',true,'{}',$2,$2)`,[account,at]);
 await db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood','fill-1','fill-1','equity',$2,$3)`,
  [account,JSON.stringify({quantity:'5',price:'10',feeAmount:null,notionalAmount:null,side:'buy',instrumentRef:'xyz',symbol:'XYZ',origin:'agentic',orderCreatedAt:at,occurredAt:at}),at]);
 await core.attribute({accountId:account,provider:'robinhood',executionRef:'fill-1'},{instruction:{...invested,accountId:account,provider:'robinhood',orderRef:'fill-1'}});
 const asked:string[][]=[];
 let tradable:unknown='untradable';
 const readTool=async(name:string,args:Record<string,unknown>)=>{
  parseRead(name,args,true);
  asked.push(args.symbols as string[]);
  return {results:(args.symbols as string[]).map(symbol=>({symbol,tradability:tradable,state:tradable==='untradable'?'inactive':'active'}))};
 };
 const entries=async()=>(await db.query<{sequence:number;entry_type:string;symbol:string|null;quantity_delta:string|null;cash_delta:string|null}>(
  `SELECT sequence,entry_type,symbol,quantity_delta::text,cash_delta::text FROM strategy_attribution_entries WHERE allocation_id=$1 ORDER BY sequence`,[invested.allocationId])).rows;
 return {db,database,readTool,asked,setTradable:(v:unknown)=>{tradable=v;},entries,allocationId:invested.allocationId,close:async()=>{sync.cancel();await db.close();}};
}

test('three trading days without a close and a not-tradable verdict release the strategy’s shares with no trade',async()=>{
 const f=await fixture();try{
  const xyz=closes(['2026-09-28','2026-09-29']);
  // Two days behind: counted, not asked about.
  expect(await observeDelistings(f.database,f.readTool,{closesBySymbol:new Map([['XYZ',xyz],['SPY',current.slice(0,4)]]),expectedThrough:'2026-10-01',now})).toEqual([]);
  expect(f.asked).toEqual([]);
  // Three days behind (Sep 30, Oct 1, Oct 2): asked, and marked at its last close.
  expect(DELISTING_MISSING_DAYS).toBe(3);
  expect(await observeDelistings(f.database,f.readTool,{closesBySymbol:new Map([['XYZ',xyz],['SPY',current]]),expectedThrough:'2026-10-02',now})).toEqual([{symbol:'XYZ',day:'2026-10-02',lastClose:'10'}]);
  expect(f.asked).toEqual([['XYZ']]);
  const marks=await f.database.use(db=>delistedMarks(db));
  expect(marks.get('XYZ')?.day).toBe('2026-10-02');
  expect(Number(marks.get('XYZ')?.lastClose)).toBe(10);
  const rows=await f.entries();
  expect(Number(rows.filter(r=>r.symbol==='XYZ').reduce((n,r)=>n+Number(r.quantity_delta),0))).toBe(0);
  expect(rows.at(-1)).toMatchObject({entry_type:'detachment',symbol:'XYZ'});
  // The release takes the cost with it: nothing is realized as a loss.
  const pnl=deriveAllocationPnl(rows.map(r=>({sequence:r.sequence,entryType:r.entry_type,symbol:r.symbol,quantityDelta:r.quantity_delta,cashDelta:r.cash_delta})));
  expect(pnl.bySymbol.get('XYZ')).toMatchObject({quantity:'0',costBasis:'0',realized:'0'});
  expect((await f.db.query(`SELECT kind FROM strategy_allocation_transactions WHERE allocation_id=$1 ORDER BY sequence DESC LIMIT 1`,[f.allocationId])).rows).toEqual([{kind:'attribution_release'}]);
  // Marked once: a later check does not ask or release again.
  expect(await observeDelistings(f.database,f.readTool,{closesBySymbol:new Map([['XYZ',xyz],['SPY',current]]),expectedThrough:'2026-10-02',now})).toEqual([]);
  expect(f.asked.length).toBe(1);
 }finally{await f.close();}
});

test('a lagging symbol Robinhood still trades is not delisted, and a close clears the count',async()=>{
 const f=await fixture();try{
  f.setTradable('tradable');
  const xyz=closes(['2026-09-28','2026-09-29']);
  expect(await observeDelistings(f.database,f.readTool,{closesBySymbol:new Map([['XYZ',xyz],['SPY',current]]),expectedThrough:'2026-10-02',now})).toEqual([]);
  expect((await f.db.query(`SELECT to_char(no_close_since,'YYYY-MM-DD') AS since,delisted_on FROM symbol_delistings`)).rows).toEqual([{since:'2026-09-30',delisted_on:null}]);
  await observeDelistings(f.database,f.readTool,{closesBySymbol:new Map([['XYZ',current],['SPY',current]]),expectedThrough:'2026-10-02',now});
  expect((await f.db.query(`SELECT no_close_since FROM symbol_delistings`)).rows).toEqual([{no_close_since:null}]);
  expect(Number((await f.entries()).reduce((n,r)=>n+Number(r.quantity_delta??0),0))).toBe(5);
 }finally{await f.close();}
});

test('nothing is counted when no symbol is current: the gap is the data’s, not the market’s',async()=>{
 const f=await fixture();try{
  expect(await observeDelistings(f.database,f.readTool,{closesBySymbol:new Map([['XYZ',closes(['2026-09-28'])],['SPY',closes(['2026-09-28'])]]),expectedThrough:'2026-10-02',now})).toEqual([]);
  expect((await f.db.query(`SELECT * FROM symbol_delistings`)).rows).toEqual([]);
 }finally{await f.close();}
});

test('the model closes a delisted sleeve to cash at its last close',()=>{
 const rows=computeModelValuations({allocations:[{id:'v1',sequence:1,weights:[{symbol:'XYZ',weightPercent:50},{symbol:'SPY',weightPercent:50}],cashPercent:0,effectiveOn:'2026-09-28'}],
  closesBySymbol:new Map([['XYZ',closes(['2026-09-28','2026-09-29'])],['SPY',current]]),days:current.map(c=>c.day),rebalanceDays:new Set(),driftBands:{driftBandPoints:null,driftBandRelative:null},
  delisted:new Map([['XYZ',{day:'2026-09-30',lastClose:'10'}]])});
 const last=rows.at(-1)!;
 expect(last.units.XYZ).toBeUndefined();
 expect(Number(last.cash)).toBeGreaterThan(0);
});
