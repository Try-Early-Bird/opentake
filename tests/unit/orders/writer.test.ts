import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createOrderWriter,OrderConflictError,PlacementUnknownError,placedOrderRef} from '../../../src/main/orders/service';
import {equityOrderSchema} from '../../../src/main/orders/contract';
import {createAccountSync} from '../../../src/main/account-sync/service';

// A fake broker: every review and placement is recorded; placement answers are scripted.
async function fixture(options:{enabled?:boolean}={}){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=Date.parse('2026-10-05T15:00:00Z');
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1000',cash:'500',buying_power:'500'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:'2',mark_price:'250'}]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 const sent:{stage:string;input:unknown;refId?:string}[]=[];
 let placement:()=>unknown=()=>({isError:false,errorCategory:null,data:{order:{id:'rh-order-1'}}});
 const placed:string[]=[];
 const writer=createOrderWriter(database,{equityOrder:async(stage,input,_account,refId)=>{
  sent.push({stage,input,refId});
  return stage==='review'?{tradability:{tradable:true},review:{quote:'250'}}:placement();
 }},{enabled:()=>options.enabled??true,afterPlacement:()=>placed.push('sync')},()=>now);
 const buy={symbol:'VTI',side:'buy',type:'market',dollar_amount:'1.00'};
 return {db,database,account,clock:()=>now,writer,sent,placed,buy,sync,setPlacement:(fn:()=>unknown)=>{placement=fn;},later:(ms:number)=>{now+=ms;},close:async()=>{sync.cancel();await db.close();}};
}

test('trading is off unless enabled: nothing reaches the broker',async()=>{
 const f=await fixture({enabled:false});try{
  await expect(f.writer.review({accountId:f.account,order:f.buy})).rejects.toThrow('Trading is not enabled');
  expect(f.sent).toEqual([]);
 }finally{await f.close();}
});

test('review then confirm places once with its ref_id; a repeated confirm does not resend',async()=>{
 const f=await fixture();try{
  const {intent,review}=await f.writer.review({accountId:f.account,order:f.buy});
  expect(intent).toMatchObject({status:'reviewed',orderRequest:f.buy});
  expect(review).toEqual({tradability:{tradable:true},review:{quote:'250'}});
  const placed=await f.writer.confirm(intent.id);
  expect(placed).toMatchObject({status:'placed',providerOrderRef:'rh-order-1'});
  expect(f.sent.filter(s=>s.stage==='place')).toEqual([{stage:'place',input:f.buy,refId:intent.refId}]);
  expect(f.placed).toEqual(['sync']);
  expect(await f.writer.confirm(intent.id)).toMatchObject({status:'placed'});
  expect(f.sent.filter(s=>s.stage==='place')).toHaveLength(1);
 }finally{await f.close();}
});

test('an expired review is never placed',async()=>{
 const f=await fixture();try{
  const {intent}=await f.writer.review({accountId:f.account,order:f.buy});
  f.later(2*60_000+1);
  await expect(f.writer.confirm(intent.id)).rejects.toBeInstanceOf(OrderConflictError);
  expect((await f.writer.list(f.account))[0]!.status).toBe('expired');
  expect(f.sent.some(s=>s.stage==='place')).toBe(false);
 }finally{await f.close();}
});

test('two confirms racing place one order',async()=>{
 const f=await fixture();try{
  const {intent}=await f.writer.review({accountId:f.account,order:f.buy});
  let release=()=>{};const gate=new Promise<void>(r=>{release=r;});
  f.setPlacement(()=>gate.then(()=>({isError:false,errorCategory:null,data:{order:{id:'rh-order-1'}}})));
  const first=f.writer.confirm(intent.id);
  await new Promise(r=>setTimeout(r,20));
  await expect(f.writer.confirm(intent.id)).rejects.toBeInstanceOf(OrderConflictError);
  release();await first;
  expect(f.sent.filter(s=>s.stage==='place')).toHaveLength(1);
 }finally{await f.close();}
});

test('a lost connection leaves the outcome unknown, never resent, until a synced order with its ref_id resolves it',async()=>{
 const f=await fixture();try{
  const {intent}=await f.writer.review({accountId:f.account,order:f.buy});
  f.setPlacement(()=>{throw new Error('socket hang up');});
  await expect(f.writer.confirm(intent.id)).rejects.toBeInstanceOf(PlacementUnknownError);
  await expect(f.writer.confirm(intent.id)).rejects.toBeInstanceOf(OrderConflictError);
  expect(f.sent.filter(s=>s.stage==='place')).toHaveLength(1);
  expect(await f.writer.reconcile(f.account)).toBe(0);
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','rh-order-9','equity','filled',true,$2,now(),now())`,[f.account,JSON.stringify({clientRef:intent.refId})]);
  expect(await f.writer.reconcile(f.account)).toBe(1);
  expect((await f.writer.list(f.account))[0]).toMatchObject({status:'placed',providerOrderRef:'rh-order-9'});
 }finally{await f.close();}
});

test('Robinhood refusing the request rejects the intent; any other error stays unknown',async()=>{
 const f=await fixture();try{
  const a=(await f.writer.review({accountId:f.account,order:f.buy})).intent;
  f.setPlacement(()=>({isError:true,errorCategory:'invalid_request',data:[{text:'Order below minimum'}]}));
  await expect(f.writer.confirm(a.id)).rejects.toThrow('nothing was placed');
  const b=(await f.writer.review({accountId:f.account,order:f.buy})).intent;
  f.setPlacement(()=>({isError:true,errorCategory:'server_error',data:[]}));
  await expect(f.writer.confirm(b.id)).rejects.toBeInstanceOf(PlacementUnknownError);
  const states=Object.fromEntries((await f.writer.list(f.account)).map(i=>[i.id,i.status]));
  expect(states).toEqual({[a.id]:'rejected',[b.id]:'placement_unknown'});
 }finally{await f.close();}
});

test('an allocation order needs an active, reviewed allocation, and its fill links back to it',async()=>{
 const f=await fixture();try{
  const strategy=randomUUID(),version=randomUUID();
  await f.db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{"schemaVersion":1,"kind":"basket","target":{"weights":[{"instrument":{"venue":"robinhood","symbol":"VTI"},"bps":10000}],"cashBps":0},"rebalance":{"schedule":"never","driftBandPoints":null,"driftBandRelative":null}}','{}','{}' FROM local_owners`,[version,strategy]);
  await f.db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
  const r=await createAllocationCore(f.database,f.clock).invest({allocationId:randomUUID(),accountId:f.account,strategyId:strategy,versionId:version,amount:'10',cause:randomUUID()});
  const {intent}=await f.writer.review({accountId:f.account,order:f.buy,...r});
  await f.writer.confirm(intent.id);
  expect(await f.writer.link({accountId:f.account,provider:'robinhood',orderRef:'rh-order-1'})).toEqual({instruction:{...r,accountId:f.account,provider:'robinhood',orderRef:'rh-order-1'}});
  expect(await f.writer.link({accountId:f.account,provider:'robinhood',orderRef:'someone-else'})).toBeUndefined();
  await f.db.query(`UPDATE strategy_allocations SET status='paused' WHERE id=$1`,[r.allocationId]);
  await expect(f.writer.review({accountId:f.account,order:f.buy,...r})).rejects.toThrow('The allocation cannot trade');
 }finally{await f.close();}
});

test('the order contract refuses what Robinhood would, before it is sent',()=>{
 const ok=(o:object)=>equityOrderSchema.safeParse(o).success;
 expect(ok({symbol:'VTI',side:'buy',type:'market',dollar_amount:'1.00'})).toBe(true);
 expect(ok({symbol:'VTI',side:'sell',type:'market',quantity:'0.5'})).toBe(true);
 expect(ok({symbol:'VTI',side:'buy',type:'market',dollar_amount:'0.50'})).toBe(false);
 expect(ok({symbol:'VTI',side:'buy',type:'limit',dollar_amount:'5'})).toBe(false);
 expect(ok({symbol:'VTI',side:'buy',type:'market',dollar_amount:'5',quantity:'1'})).toBe(false);
 expect(ok({symbol:'VTI',side:'buy',type:'market',quantity:'1',tax_lots:[{open_lot_id:'a',quantity:'1'}]})).toBe(false);
 expect(ok({symbol:'VTI',side:'buy',type:'market',dollar_amount:'5',account_number:'123'})).toBe(false);
 expect(placedOrderRef({data:{order:{id:'abc'}}})).toBe('abc');
 expect(placedOrderRef({nothing:true})).toBeNull();
});

test('your own order of unknown outcome can be cleared after checking Robinhood, and is still matched if it appears',async()=>{
 const f=await fixture();try{
  f.setPlacement(()=>{throw new Error('network dropped');});
  const {intent}=await f.writer.review({accountId:f.account,order:f.buy});
  await expect(f.writer.confirm(intent.id)).rejects.toThrow('may have reached Robinhood');
  expect((await f.writer.abandon(intent.id)).status).toBe('abandoned');
  await expect(f.writer.abandon(intent.id)).rejects.toThrow('Only an order of unknown outcome');
  // Never resent, and a later sync showing it still matches it.
  expect(f.sent.filter(s=>s.stage==='place')).toHaveLength(1);
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','rh-late','equity','filled',true,$2,now(),now())`,[f.account,JSON.stringify({clientRef:intent.refId})]);
  expect(await f.writer.reconcile(f.account)).toBe(1);
  expect((await f.writer.list(f.account))[0]).toMatchObject({status:'placed',providerOrderRef:'rh-late'});
 }finally{await f.close();}
});

test('your own order’s fill is yours: no case, and one deferred before this fix resolves its case',async()=>{
 const f=await fixture();try{
  const {createAllocationCore}=await import('../../../src/main/allocations/service');
  const {createAttributionSweep}=await import('../../../src/main/allocations/attribution-sweep');
  // A strategy holding VTI shares the account with the member's own VTI.
  const strategy=randomUUID(),version=randomUUID();
  await f.db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{"schemaVersion":1,"kind":"basket","target":{"weights":[{"instrument":{"venue":"robinhood","symbol":"VTI"},"bps":10000}],"cashBps":0},"rebalance":{"schedule":"never","driftBandPoints":null,"driftBandRelative":null}}','{}','{}' FROM local_owners`,[version,strategy]);
  await f.db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
  const core=createAllocationCore(f.database,f.clock);
  const r=await core.invest({allocationId:randomUUID(),accountId:f.account,strategyId:strategy,versionId:version,amount:'10',cause:randomUUID()});
  await f.db.query(`UPDATE strategy_allocations SET status='active' WHERE id=$1`,[r.allocationId]);
  // The member sells $1 of VTI from Settings > Trading; it fills.
  const {intent}=await f.writer.review({accountId:f.account,order:{symbol:'VTI',side:'sell',type:'market',dollar_amount:'1.00'}});
  const placed=await f.writer.confirm(intent.id);
  expect(await f.writer.link({accountId:f.account,provider:'robinhood',orderRef:placed.providerOrderRef!})).toEqual({memberDirected:true});
  const at=new Date(f.clock()).toISOString();
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood',$2,'equity','filled',true,'{}',$3,$3)`,[f.account,placed.providerOrderRef,at]);
  await f.db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood','exec-own',$2,'equity',$3,$4)`,
   [f.account,placed.providerOrderRef,JSON.stringify({quantity:'0.004',price:'250',feeAmount:null,notionalAmount:null,side:'sell',instrumentRef:'VTI',symbol:'VTI',origin:'agentic',orderCreatedAt:at,occurredAt:at}),at]);
  // Before the fix: no link, so it was deferred as an unexplained agentic order and held the strategy.
  expect(await core.attribute({accountId:f.account,provider:'robinhood',executionRef:'exec-own'})).toBe('deferred');
  expect((await f.db.query(`SELECT status FROM strategy_allocations WHERE id=$1`,[r.allocationId])).rows).toEqual([{status:'diverged'}]);
  // The sweep retries it with the link: completed, case resolved, strategy back to active.
  const sweep=createAttributionSweep(f.database,core,fill=>f.writer.link(fill));
  expect(await sweep.run(f.account)).toMatchObject({completed:1,failed:0});
  expect((await f.db.query(`SELECT attribution_state FROM account_executions WHERE provider_ref='exec-own'`)).rows).toEqual([{attribution_state:'completed'}]);
  expect((await f.db.query(`SELECT count(*)::int AS open FROM strategy_reconciliation_cases WHERE resolved_at IS NULL`)).rows).toEqual([{open:0}]);
  expect((await f.db.query(`SELECT status FROM strategy_allocations WHERE id=$1`,[r.allocationId])).rows).toEqual([{status:'active'}]);
 }finally{await f.close();}
});

test('personal ownership is checked again at confirmation, including expiry during the check',async()=>{
 const f=await fixture();try{
 let allowed=true,slow=false,placed=0;
 const writer=createOrderWriter(f.database,{equityOrder:async(stage)=>{if(stage==='place')placed++;return {isError:false,data:{order:{id:'synthetic'}}};}},{enabled:()=>true,guardSelfDirected:async()=>{if(!allowed)throw new Error('Cash now belongs to a take');if(slow)f.later(3*60_000);}},f.clock);
 const {intent}=await writer.review({accountId:f.account,order:f.buy});allowed=false;
 await expect(writer.confirm(intent.id)).rejects.toThrow('Cash now belongs');expect(placed).toBe(0);
 allowed=true;slow=true;await expect(writer.confirm(intent.id)).rejects.toThrow();expect(placed).toBe(0);
 }finally{await f.close();}
});
test('ambiguous recovery evidence leaves a Robinhood intent unknown instead of choosing an order',async()=>{
 const f=await fixture();try{
  const {intent}=await f.writer.review({accountId:f.account,order:f.buy});f.setPlacement(()=>{throw Error('Lost');});
  await expect(f.writer.confirm(intent.id)).rejects.toBeInstanceOf(PlacementUnknownError);
  for(const id of ['one','two'])await f.db.query("INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood',$2,'equity','open',false,$3,now(),now())",[f.account,id,JSON.stringify({clientRef:intent.refId})]);
  expect(await f.writer.reconcile(f.account)).toBe(0);expect((await f.writer.list(f.account))[0]).toMatchObject({status:'placement_unknown',execution:{state:'unknown'}});
  expect(f.sent.filter(s=>s.stage==='place')).toHaveLength(1);
 }finally{await f.close();}
});
test('a delayed submission error cannot overwrite a concurrently recovered acceptance',async()=>{
 const f=await fixture();try{
  const {intent}=await f.writer.review({accountId:f.account,order:f.buy});
  f.setPlacement(async()=>{
   await f.db.query("UPDATE order_intents SET status='placed',provider_order_ref='recovered',placed_at=now() WHERE id=$1",[intent.id]);
   return {isError:true,errorCategory:'server_error',data:[]};
  });
  await expect(f.writer.confirm(intent.id)).rejects.toBeInstanceOf(PlacementUnknownError);
  expect((await f.writer.list(f.account))[0]).toMatchObject({status:'placed',providerOrderRef:'recovered',execution:{state:'accepted'}});
 }finally{await f.close();}
});
test('common order status reflects synced fills while preserving the durable placement status',async()=>{
 const f=await fixture();try{
  const {intent}=await f.writer.review({accountId:f.account,order:f.buy});await f.writer.confirm(intent.id);
  await f.db.query("INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','rh-order-1','equity','filled',true,'{}',now(),now())",[f.account]);
  expect(await f.writer.get(intent.id)).toMatchObject({status:'placed',execution:{state:'filled'}});
  expect((await f.writer.list(f.account))[0].execution.state).toBe('filled');
 }finally{await f.close();}
});
