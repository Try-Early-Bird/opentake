import { createAllocationCore } from '../../src/main/allocations/service';
import { afterEach, expect, test, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../src/main/migrations';
import { createCoinbaseActivityReader, type ActivityPage } from '../../src/main/coinbase/activity';
import { createCoinbaseActivitySync } from '../../src/main/coinbase/activity-sync';
const portfolio='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const key={name:'organizations/synthetic/apiKeys/synthetic',privateKey:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'sec1',format:'pem'}).toString()};
const at='2026-10-09T12:00:00.000Z';
const order={order_id:'order-1',client_order_id:'client-1',retail_portfolio_id:portfolio,product_id:'BTC-USDC',product_type:'SPOT',side:'BUY',status:'FILLED',created_time:'2026-10-08T12:00:00Z',filled_size:'0.002',total_fees:'0.1'};
const fill={entry_id:'entry-1',trade_id:'trade-1',order_id:order.order_id,retail_portfolio_id:portfolio,product_id:'BTC-USDC',side:'BUY',trade_type:'FILL',trade_time:'2026-10-08T12:00:01Z',sequence_timestamp:'2026-10-08T12:00:02Z',size:'100',size_in_quote:true,price:'50000',commission:'0.1',user_id:'discard'};
const response=(data:unknown)=>new Response(JSON.stringify(data));
async function normalize() {
 const fetcher=vi.fn().mockResolvedValueOnce(response({orders:[order],has_next:false})).mockResolvedValueOnce(response({fills:[fill],cursor:''}));
 const read=createCoinbaseActivityReader(fetcher),signal=new AbortController().signal;
 return {orders:(await read(key,portfolio,signal,{resource:'spot_orders',until:at})).orders,fills:(await read(key,portfolio,signal,{resource:'spot_fills',until:at})).fills,cursor:null};
}
test('direct activity reads preserve quote/base units, fee currency, stable fill ID and causal order reference',async()=>{
 const page=await normalize();
 expect(page.fills[0]).toMatchObject({providerExecutionRef:'entry-1',tradeRef:'trade-1',orderRef:'order-1',quantity:'0.002',notionalAmount:'100',feeAmount:'0.1',currency:'USDC',feeCurrency:'USDC',sourceSize:'100',sizeInQuote:true,origin:'unknown',instrumentRef:'coinbase:BTC'});
 expect(JSON.stringify(page)).not.toContain('discard');
 const fetcher=vi.fn().mockResolvedValue(response({fills:[{...fill,size:'0.00000001',size_in_quote:false}],cursor:''}));
 const base=await createCoinbaseActivityReader(fetcher)(key,portfolio,new AbortController().signal,{resource:'spot_fills',since:at,until:at});
 expect(base.fills[0]).toMatchObject({quantity:'0.00000001',notionalAmount:'0.0005'});
 const url=new URL(fetcher.mock.calls[0][0]);expect(url.searchParams.get('start_sequence_timestamp')).toBe(at);expect(url.searchParams.get('product_types')).toBe('SPOT');
});
test('rejects wrong portfolios, missing denomination, unexpected order identity and proof requirements',async()=>{
 for(const value of [{...fill,retail_portfolio_id:other},{...fill,size_in_quote:undefined},{...fill,trade_type:'REVERSAL'}]) {
  const read=createCoinbaseActivityReader(vi.fn().mockResolvedValue(response({fills:[value],cursor:''})));
  await expect(read(key,portfolio,new AbortController().signal,{resource:'spot_fills',until:at})).rejects.toThrow();
 }
 const read=createCoinbaseActivityReader(vi.fn().mockResolvedValue(response({order})));
 await expect(read(key,portfolio,new AbortController().signal,{resource:'order',orderId:'different'})).rejects.toMatchObject({code:'scope'});
 const proof=createCoinbaseActivityReader(vi.fn().mockResolvedValue(response({fills:[],cursor:'',proof_token_required:true})));
 await expect(proof(key,portfolio,new AbortController().signal,{resource:'spot_fills',until:at})).rejects.toMatchObject({code:'permissions'});
});
const close:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const run of close.splice(0))await run();});
async function fixture() {
 const db=new PGlite();close.push(()=>db.close());await migrate(db);
 const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic' FROM local_owners RETURNING id")).rows[0].id;
 const ids=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'a','A'),($1,'b','B') RETURNING id",[connection])).rows.map(r=>r.id);
 const page=await normalize(),assert=vi.fn(async()=>{});
 const read=vi.fn(async(_scope:any,args:any):Promise<ActivityPage>=>args.resource==='spot_fills'?{orders:[],fills:page.fills,cursor:null}:{orders:page.orders,fills:[],cursor:null});
 const service=createCoinbaseActivitySync({use:work=>work(db)},read,assert,()=>Date.parse(at));
 const scope=(id=ids[0])=>({accountRef:id,authority:'fixture',label:'Fixture'});
 return {db,ids,page,read,assert,service,scope};
}
test('sync is account-scoped and idempotent, preserves evidence on failed reads and never allocates by symbol',async()=>{
 const f=await fixture();await f.service.refresh(f.scope());await f.service.refresh(f.scope());await f.service.refresh(f.scope(f.ids[1]));
 const rows=(await f.db.query<{attribution_state:string}>('SELECT * FROM account_executions')).rows;
 expect(rows).toHaveLength(2);expect(rows.every(r=>r.attribution_state==='deferred')).toBe(true);
 expect((await f.db.query('SELECT * FROM strategy_attribution_entries')).rows).toHaveLength(0);
 f.read.mockRejectedValue(new Error('unavailable'));await f.service.refresh(f.scope());
 expect((await f.db.query('SELECT * FROM account_executions')).rows).toHaveLength(2);
 expect((await f.db.query("SELECT state FROM coinbase_activity_sync WHERE account_id=$1",[f.ids[0]])).rows).toEqual([{state:'failed'},{state:'failed'}]);
 expect((await f.db.query("SELECT state FROM coinbase_activity_sync WHERE account_id=$1",[f.ids[1]])).rows).toEqual([{state:'completed'},{state:'completed'}]);
});
test('bounded history resumes its exact window across refresh, then uses overlap and refetches old open orders',async()=>{
 const f=await fixture();let page=0;
 f.read.mockImplementation(async(_scope,args)=>{
  if(args.resource==='spot_orders')return {orders:f.page.orders.map(o=>({...o,state:'open',terminal:false})),fills:[],cursor:++page<=8?String(page):null};
  if(args.resource==='order')return {orders:f.page.orders,fills:[],cursor:null};
  return {orders:[],fills:[],cursor:null};
 });
 await f.service.refresh(f.scope());
 expect((await f.db.query("SELECT state,cursor,completed_at FROM coinbase_activity_sync WHERE resource='spot_orders'")).rows).toEqual([{state:'partial',cursor:'8',completed_at:null}]);
 await f.service.refresh(f.scope());
 expect(f.read.mock.calls.find(([,args])=>args.cursor==='8')?.[1]).toMatchObject({until:at});
 expect(f.read.mock.calls.some(([,args])=>args.resource==='order'&&args.orderId==='order-1')).toBe(true);
 await f.service.refresh(f.scope());
 expect(f.read.mock.calls.at(-3)?.[1].since).toBe('2026-10-02T12:00:00.000Z');
});
test('changed fills and repeated cursors cannot advance completion or overwrite financial evidence',async()=>{
 const f=await fixture();await f.service.refresh(f.scope());
 f.read.mockImplementation(async(_scope,args)=>args.resource==='spot_fills'?{orders:[],fills:f.page.fills.map(x=>({...x,quantity:'2'})),cursor:null}:{orders:f.page.orders,fills:[],cursor:'repeat'});
 await f.service.refresh(f.scope());
 expect((await f.db.query<{data:any}>('SELECT data FROM account_executions')).rows[0].data.quantity).toBe('0.002');
 expect((await f.db.query('SELECT state FROM coinbase_activity_sync')).rows.every((r:any)=>r.state==='failed')).toBe(true);
});
test('fills fetch missing orders and revoked authority prevents persistence',async()=>{
 const f=await fixture();
 f.read.mockImplementation(async(_scope,args)=>args.resource==='spot_orders'?{orders:[],fills:[],cursor:null}:args.resource==='order'?{orders:f.page.orders,fills:[],cursor:null}:{orders:[],fills:f.page.fills,cursor:null});
 await f.service.refresh(f.scope());expect(f.read.mock.calls.some(([,args])=>args.resource==='order')).toBe(true);
 f.assert.mockRejectedValue(new Error('revoked'));await expect(f.service.refresh(f.scope(f.ids[1]))).rejects.toThrow('revoked');
 expect((await f.db.query('SELECT * FROM account_executions WHERE account_id=$1',[f.ids[1]])).rows).toHaveLength(0);
});


test('Coinbase evidence cannot enter the Robinhood allocation calculation',async()=>{
 const f=await fixture();await f.service.refresh(f.scope());
 const core=createAllocationCore({use:work=>work(f.db)});
 await expect(core.attribute({accountId:f.ids[0],provider:'coinbase',executionRef:'entry-1'})).rejects.toThrow('Coinbase allocation attribution is not enabled');
 expect((await f.db.query('SELECT * FROM strategy_attribution_entries')).rows).toHaveLength(0);
});


test('sync persists immutable native currency legs once per account and backfills cached fills',async()=>{
 const f=await fixture();
 const old=f.page.fills[0];
 await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'coinbase',$2,'crypto','filled',true,$3,$4,$4)`,[f.ids[0],old.orderRef,JSON.stringify(f.page.orders[0]),at]);
 await f.db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at,attribution_state)
  VALUES($1,'coinbase',$2,$3,'crypto',$4,$5,'deferred')`,[f.ids[0],old.providerExecutionRef,old.orderRef,JSON.stringify(old),old.occurredAt]);
 f.read.mockImplementation(async()=>({orders:[],fills:[],cursor:null}));
 await f.service.refresh(f.scope());await f.service.refresh(f.scope());
 const legs=(await f.db.query<{asset:string;quantity:string;exact:boolean}>('SELECT asset,quantity::text,exact FROM coinbase_execution_movements WHERE account_id=$1 ORDER BY kind',[f.ids[0]])).rows;
 expect(legs.map(x=>[x.asset,Number(x.quantity),x.exact])).toEqual([['BTC',0.002,true],['USDC',-0.1,true],['USDC',-100,true]]);
 expect((await f.db.query('SELECT * FROM coinbase_execution_movements WHERE account_id=$1',[f.ids[1]])).rows).toHaveLength(0);
 await expect(f.db.query("UPDATE coinbase_execution_movements SET quantity=0")).rejects.toThrow('append-only');
 expect((await f.db.query('SELECT * FROM strategy_attribution_entries')).rows).toHaveLength(0);
});
