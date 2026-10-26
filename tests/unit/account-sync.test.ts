import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabaseLifecycle } from '../../src/main/database';
import { createAccountSync } from '../../src/main/account-sync/service';
import { createMaintenance } from '../../src/main/maintenance';
import { createConnections } from '../../src/main/connections';
import { prepareRestoredDatabase } from '../../src/main/migrations';
import { accountSyncInterval } from '../../src/main/account-sync/cadence';
import { callOpentakeTool } from '../../src/main/opentake-mcp/server';
import type { SecretStore } from '../../src/main/secret-store';

const oldOrder = (filled=false) => ({id:'old-order',state:filled?'filled':'confirmed',symbol:'VTI',instrument_id:'VTI',side:'buy',quantity:'1',created_at:'2026-09-01T12:00:00Z',placed_agent:'user',account_number:'DO-NOT-PERSIST',executions:filled?[{id:'fill-1',quantity:'1',price:'200.123456789012345678',timestamp:'2026-10-02T15:00:00Z',access_token:'DO-NOT-PERSIST'}]:[]});
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'opentake-account-sync-'));
 const db=createDatabaseLifecycle(join(root,'database'));await db.start();
 let now=Date.parse('2026-10-02T15:00:00Z');
 const connection=(await db.use(d=>d.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status,credential_ref,maintenance_enabled,checked_at) SELECT id,'robinhood','connected','synthetic',true,now() FROM local_owners RETURNING id`))).rows[0].id;
 const id=(await db.use(d=>d.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic-account','••••1234',true,true) RETURNING id`,[connection]))).rows[0].id;
 const calls:{name:string;args:Record<string,unknown>}[]=[];
 let filled=false,empty=false,broken=false;
 const status=async()=>({status:'connected' as const,checkedAt:null,accounts:[{id,maskedNumber:'••••1234',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]});
 const provider={status,readTool:async(name:string,args:Record<string,unknown>)=>{
  calls.push({name,args});
  if(name==='get_portfolio')return {total_value:'1000.00',cash:'800.00',buying_power:'800.00',account_number:'DO-NOT-PERSIST'};
  if(name==='get_equity_positions'){
   if(broken)return {results:[{symbol:'PARTIAL',quantity:'5'}],next_cursor:'same-cursor'};
   return {results:empty?[]:[{symbol:'VTI',instrument_id:'VTI',quantity:'1',mark_price:'200.123456789012345678'}]};
  }
  if(name==='get_option_positions'||name==='get_option_orders')return {results:[]};
  if(args.order_id)return {results:[oldOrder(filled)]};
  return {results:args.created_at_gte?[]:[oldOrder(filled)]};
 }};
 const service=createAccountSync(db,provider,()=>now);
 return {db,service,id,calls,provider,advance:(ms:number)=>{now+=ms;},clock:()=>now,setFilled:()=>{filled=true;},setEmpty:()=>{empty=true;},setBroken:()=>{broken=true;},close:async()=>{service.cancel();await db.close();await rm(root,{recursive:true,force:true});}};
}
test('unchanged and empty positions retain evidence and acquire fresh complete observations',async()=>{
 const f=await fixture();try{
  await f.service.synchronize();f.advance(20*60_000);
  expect((await f.service.snapshot()).resources.find(r=>r.resource==='equity_positions')?.stale).toBe(true);
  await f.service.synchronize();
  const view=await f.service.snapshot();expect(view.resources.every(r=>!r.stale)).toBe(true);
  expect(view.account?.maskedNumber).toBe('••••1234');
  expect(view.positions[0].markPrice).toBe('200.123456789012345678');
  expect((await f.db.use(d=>d.query('SELECT id FROM position_snapshots'))).rows).toHaveLength(2);
  expect((await f.db.use(d=>d.query('SELECT id FROM account_observations'))).rows).toHaveLength(6);
  f.setEmpty();f.advance(60_000);await f.service.synchronize();
  expect((await f.service.snapshot()).positions).toEqual([]);
  expect((await f.db.use(d=>d.query('SELECT id FROM position_snapshots'))).rows).toHaveLength(3);
 }finally{await f.close();}
});
test('old open orders are fetched by ID and late fills are immutable and idempotent',async()=>{
 const f=await fixture();try{
  await f.service.synchronize();f.setFilled();f.advance(21*86_400_000);await f.service.synchronize();await f.service.synchronize();
  expect(f.calls.some(c=>c.args.order_id==='old-order')).toBe(true);
  const view=await f.service.snapshot();expect(view.executions).toHaveLength(1);expect(view.executions[0].price).toBe('200.123456789012345678');
  expect(view.orders[0].state).toBe('filled');expect(view.gaps.length).toBeGreaterThan(0);
  const persisted=await f.db.use(async d=>({orders:(await d.query('SELECT data FROM account_orders')).rows,fills:(await d.query('SELECT data FROM account_executions')).rows}));
  expect(JSON.stringify(persisted)).not.toContain('DO-NOT-PERSIST');
  expect((await f.db.use(d=>d.query('SELECT attribution_state FROM account_executions'))).rows).toEqual([{attribution_state:'pending'}]);
 }finally{await f.close();}
});
test('partial or repeated-cursor capture cannot replace complete positions or advance their watermark',async()=>{
 const f=await fixture();try{
  await f.service.synchronize();const before=(await f.service.snapshot()).resources.find(r=>r.resource==='equity_positions');
  f.setBroken();f.advance(60_000);await expect(f.service.synchronize()).rejects.toThrow();
  const view=await f.service.snapshot();expect(view.positions[0].symbol).toBe('VTI');expect(view.resources.find(r=>r.resource==='equity_positions')).toMatchObject({observedAt:before?.observedAt,state:'failed'});
 }finally{await f.close();}
});
// Includes disk-backed schema initialization, capture, and the full restore
// preparation pass. Windows CI can exceed the ordinary 30-second test budget.
test('restart recovery and restore retain observations but force discovery and freshness to be re-established',{timeout:60_000},async()=>{
 const f=await fixture();try{
  await f.service.synchronize();
  await f.db.use(d=>d.query(`INSERT INTO account_sync_runs(id,account_id,resource,state,started_at) VALUES(gen_random_uuid(),$1,'portfolio','running',now())`,[f.id]));
  await f.service.start();expect((await f.db.use(d=>d.query("SELECT state FROM account_sync_runs WHERE error_code='host_restarted'"))).rows).toEqual([{state:'interrupted'}]);
  await f.db.use(prepareRestoredDatabase);
  const view=await f.service.snapshot(f.id);expect(view.portfolio?.cash).toBe('800.00');expect(view.resources.every(r=>r.stale)).toBe(true);
  expect((await f.db.use(d=>d.query('SELECT * FROM account_sync_checkpoints'))).rows).toEqual([]);
 }finally{await f.close();}
});
test('maintenance queues portfolio reads, deduplicates requests, and completes both kinds',async()=>{
 const f=await fixture();const maintenance=createMaintenance(f.db,{busy:()=>false,cancel:()=>{},refresh:f.provider.status},()=>false,f.clock,()=>0.5,{...f.service,engaged:()=>true});
 try{
  await maintenance.start();await Promise.all([maintenance.request(),maintenance.request()]);
  expect((await maintenance.list()).filter(j=>j.state==='pending')).toHaveLength(2);
  await f.db.use(d=>d.query('UPDATE background_jobs SET next_run_at=to_timestamp($1/1000.0)',[f.clock()]));
  await maintenance.tick();await maintenance.tick();
  expect((await maintenance.list()).filter(j=>j.state==='completed').map(j=>j.kind).sort()).toEqual(['account_sync','portfolio_sync']);
  expect((await f.service.snapshot()).positions).toHaveLength(1);
 }finally{await maintenance.stop();await f.close();}
});
test('disconnect and rediscovery preserve account identity and stored observations',async()=>{
 const f=await fixture();
 const secrets:SecretStore={available:()=>true,get:async()=>null,set:async()=>{},has:async()=>true,delete:async()=>{}};
 let present=true;
 const connection=createConnections(f.db,secrets,async()=>{},async()=>({authorize:async()=>{},accounts:async()=>present?[{externalRef:'synthetic-account',maskedNumber:'••••1234',nickname:null,accountType:'cash',agenticAllowed:true}]:[]}));
 try{
  await f.service.synchronize();present=false;await connection.refresh();expect((await connection.status()).accounts).toEqual([]);
  expect((await f.service.snapshot(f.id)).positions).toHaveLength(1);
  present=true;expect((await connection.refresh()).accounts[0].id).toBe(f.id);
  await connection.disconnect();expect((await f.service.snapshot(f.id)).account?.available).toBe(false);
  expect((await connection.connect()).accounts[0].id).toBe(f.id);
 }finally{await connection.close();await f.close();}
});
test('stored-portfolio tool validates account references and remains read only',async()=>{
 const f=await fixture();try{
  await f.service.synchronize();
  const services={status:f.provider.status,read:async()=>{throw new Error('Unexpected live read');},stored:async()=>f.service.snapshot(f.id)};
  const result=await callOpentakeTool(services,'opentake_get_stored_portfolio',{accountRef:f.id});expect(result.isError).not.toBe(true);
  expect((await callOpentakeTool(services,'opentake_get_stored_portfolio',{account_number:'secret'})).isError).toBe(true);
 }finally{await f.close();}
});
test('cadence uses Eastern session times, engaged versus idle polling, and watches a just-sent order closely',()=>{
 expect(accountSyncInterval(Date.parse('2026-10-02T15:00:00Z'),true)).toBe(60_000);
 expect(accountSyncInterval(Date.parse('2026-10-02T15:00:00Z'),false)).toBe(900_000);
 expect(accountSyncInterval(Date.parse('2026-10-03T15:00:00Z'),false)).toBe(21_600_000);
 // An order just sent is watched every few seconds, whatever the hour, until its fill is read.
 expect(accountSyncInterval(Date.parse('2026-10-03T15:00:00Z'),false,true)).toBe(5_000);
});

test('cancelled provider read preserves the last observation and restart leaves it retryable',async()=>{
 const f=await fixture();let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;});
 try{
  await f.service.synchronize();const before=await f.service.snapshot();f.advance(60_000);
  const blocked=createAccountSync(f.db,{status:f.provider.status,readTool:async(_name,_args,_ref,signal)=>{
   start();await new Promise<void>((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(new Error('synthetic cancel')),{once:true});});return {};
  }},f.clock);
  const sync=blocked.synchronize();const rejection=expect(sync).rejects.toThrow();await started;blocked.cancel();await rejection;
  expect((await f.service.snapshot()).positions).toEqual(before.positions);
  expect((await f.db.use(d=>d.query("SELECT state FROM account_sync_runs WHERE error_code='cancelled'"))).rows).toEqual([{state:'interrupted'}]);
  await f.service.start();await f.service.synchronize();expect((await f.service.snapshot()).resources.every(r=>!r.stale)).toBe(true);
 }finally{await f.close();}
});

test('malformed initial order discovery cannot claim a complete checkpoint',async()=>{
 const f=await fixture();try{
  const service=createAccountSync(f.db,{status:f.provider.status,readTool:async(name,args)=>name.endsWith('_orders')?{error:'synthetic-provider-failure'}:f.provider.readTool(name,args)},f.clock);
  await expect(service.synchronize()).rejects.toThrow();
  expect((await f.db.use(d=>d.query("SELECT resource FROM account_sync_checkpoints WHERE resource LIKE '%orders'"))).rows).toEqual([]);
  expect((await service.snapshot()).resources.filter(r=>r.resource.endsWith('_orders')).every(r=>r.stale&&r.state==='failed')).toBe(true);
 }finally{await f.close();}
});

test('balances and positions are visible while order history is still loading', async () => {
 const f = await fixture();
 let release!: () => void;
 let entered!: () => void;
 const waiting = new Promise<void>(resolve => { entered = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 const read = f.provider.readTool;
 f.provider.readTool = async (name, args) => {
  if (name === 'get_equity_orders') { entered(); await gate; }
  return read(name, args);
 };
 const sync = f.service.synchronize();
 try {
  await waiting;
  const view = await f.service.snapshot();
  expect(view.portfolio?.totalValue).toBe('1000.00');
  expect(view.positions[0].symbol).toBe('VTI');
  expect(view.resources.find(r => r.resource === 'equity_orders')?.state).toBe('running');
  expect(view.history).toEqual([{ observedAt: '2026-10-02T15:00:00.000Z', totalValue: '1000.00', currency: 'USD' }]);
 } finally { release(); await sync; await f.close(); }
});

test('history retains unchanged observations by hour and is scoped to the viewed account', async () => {
 const f = await fixture();
 try {
  await f.service.synchronize(); f.advance(60000); await f.service.synchronize();
  expect((await f.service.snapshot()).history).toHaveLength(1);
  f.advance(3600000); await f.service.synchronize();
  expect((await f.service.snapshot()).history).toHaveLength(2);
  expect((await f.service.snapshot()).positionHistory).toHaveLength(2);
  expect((await f.service.snapshot()).positionHistory[0]).toMatchObject({assetClass:'equity',instrumentRef:'VTI',markPrice:'200.123456789012345678'});
  const other = (await f.db.use(d => d.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected)
    SELECT connection_id,'other-account','••••5678',true,false FROM linked_accounts WHERE id=$1 RETURNING id`, [f.id]))).rows[0].id;
  expect((await f.service.snapshot(other)).history).toEqual([]);
  expect((await f.service.snapshot(other)).positionHistory).toEqual([]);
 } finally { await f.close(); }
});

test('a reread cannot replace the immutable provider notional used by attribution',async()=>{
 const f=await fixture();try{
  f.setFilled();await f.service.synchronize();f.advance(60000);
  const service=createAccountSync(f.db,{status:f.provider.status,readTool:async(name,args)=>{
   if(name==='get_equity_orders'){
    const order=oldOrder(true);
    return {results:[{...order,executions:order.executions.map(e=>({...e,notional_amount:'199.99'}))}]};
   }
   return f.provider.readTool(name,args);
  }},f.clock);
  await expect(service.synchronize()).rejects.toThrow();
  expect((await f.db.use(d=>d.query<{data:{notionalAmount:string|null}}>('SELECT data FROM account_executions'))).rows[0].data.notionalAmount).toBeNull();
 }finally{await f.close();}
});
test('after a sleep longer than the 7-day re-read, order discovery reaches back to the last checkpoint and records the gap',async()=>{
 const f=await fixture();try{
  await f.service.synchronize();await f.service.synchronize();
  const lastSync=f.clock();f.calls.length=0;
  // Ten days asleep: orders created and filled meanwhile are never open, so only discovery can find them.
  f.advance(10*86_400_000);await f.service.synchronize();
  const discovery=f.calls.filter(c=>c.name==='get_equity_orders'&&typeof c.args.created_at_gte==='string');
  expect(discovery.length).toBeGreaterThan(0);
  for(const call of discovery)expect(Date.parse(call.args.created_at_gte as string)).toBeLessThanOrEqual(lastSync);
  const gaps=(await f.db.use(d=>d.query<{resource:string;reason:string}>(`SELECT resource,reason FROM account_sync_gaps`))).rows;
  expect(gaps.some(g=>g.resource==='equity_orders'&&g.reason==='watcher_offline')).toBe(true);
 }finally{await f.close();}
});

test('ordinary closed-window reads do not create gaps, but an outage does',async()=>{
 const f=await fixture();try{
 await f.service.synchronize();f.advance(15*60_000+1000);await f.service.synchronize();
 expect((await f.db.use(db=>db.query('SELECT * FROM account_sync_gaps'))).rows).toHaveLength(0);
 f.advance(20*60_000);await f.service.synchronize();
 expect((await f.db.use(db=>db.query('SELECT * FROM account_sync_gaps'))).rows).toHaveLength(5);
 }finally{await f.close();}
});
test('the hourly wait after the 4 pm close is not recorded as an outage',async()=>{
 const f=await fixture();try{
 f.advance(4*3_600_000+45*60_000);await f.service.synchronize(); // 15:45 ET, last 15-minute read of the session
 f.advance(60*60_000);await f.service.synchronize(); // 16:45 ET, next read on the hourly after-hours cadence
 expect((await f.db.use(db=>db.query('SELECT * FROM account_sync_gaps'))).rows).toHaveLength(0);
 }finally{await f.close();}
});

test('portfolio selector balances are cached per account and never borrowed from the selected account', async () => {
 const f=await fixture();try{
  await f.service.synchronize(); const count=f.calls.length;
  const other=(await f.db.use(d=>d.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) SELECT connection_id,'other-synthetic','••••9999',true,false FROM linked_accounts WHERE id=$1 RETURNING id",[f.id]))).rows[0].id;
  const view=await f.service.snapshot(other);
  expect(view.account?.id).toBe(other);expect(view.portfolio).toBeNull();
  expect(view.accounts.find(a=>a.id===other)?.balance).toBeNull();
  expect(view.accounts.find(a=>a.id===f.id)?.balance).toMatchObject({totalValue:'1000.00',currency:'USD'});
  expect(Date.parse(view.accounts.find(a=>a.id===f.id)!.balance!.observedAt)).toBe(f.clock());
  expect(f.calls).toHaveLength(count);
 }finally{await f.close();}
});


test('portfolio accounts exclude non-agentic Robinhood accounts without deleting the connection', async () => {
 const f = await fixture(); try {
  const personal = (await f.db.use(d => d.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected)
   SELECT connection_id,'personal-synthetic','••••9999',false,false FROM linked_accounts WHERE id=$1 RETURNING id`, [f.id]))).rows[0].id;
  const view = await f.service.snapshot();
  expect(view.accounts.map(a => a.id)).toEqual([f.id]);
  expect(view.account?.id).toBe(f.id);
  await expect(f.service.snapshot(personal)).rejects.toThrow('Unknown account');
  expect((await f.db.use(d => d.query('SELECT id FROM linked_accounts WHERE id=$1',[personal]))).rows).toHaveLength(1);
 } finally { await f.close(); }
});
