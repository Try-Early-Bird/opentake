import { afterEach, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/main/migrations';
import { createTakeAccountPlans } from '../../src/main/strategies/account-plans';
import { createStrategies } from '../../src/main/strategies/service';
import { createTakes } from '../../src/main/takes';
import type { BasketSpec, ProposalInput } from '../../src/shared/strategies';
import type { TakeAccountPlan } from '../../src/shared/strategy-account-plan';
const databases:PGlite[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.close();});
const mixed:BasketSpec={schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:4000},{instrument:{venue:'robinhood',symbol:'VTI'},bps:6000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
const request=(plan:TakeAccountPlan,routes:{venue:'coinbase'|'robinhood';accountId:string}[])=>({takeId:plan.takeId,draftRevision:plan.draftRevision,revision:plan.revision,routes});
async function fixture(){
 const db=new PGlite();databases.push(db);await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const takes=createTakes(database,async()=>{},async()=>({ok:true,source:'runtime',models:[]}));
 const strategies=createStrategies(database,{active:()=>false,ensure:async()=>{},verify:async()=>({policy:'personal_basket',version:1,checkedAt:new Date().toISOString(),accountRef:null,results:[]})});
 const service=createTakeAccountPlans(database);
 async function account(venue:'robinhood'|'coinbase',label:string){
  const c=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,$1,'connected',$2 FROM local_owners RETURNING id",[venue,randomUUID()])).rows[0].id;
  if(venue==='coinbase')await db.query('INSERT INTO coinbase_connection_details(connection_id,label,portfolio_name,can_trade) VALUES($1,$2,$2,true)',[c,label]);
  return (await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,nickname,selected,agentic_allowed) VALUES($1,$2,'synthetic',$3,false,true) RETURNING id",[c,randomUUID(),label])).rows[0].id;
 }
 async function take(title='Synthetic mixed Take',spec=mixed){
  const id=await takes.create();const input:ProposalInput={targetTakeId:id,expectedRevision:null,expectedVersion:null,operationId:randomUUID(),metadata:{title,description:'',rationale:'Synthetic',holdings:[]},spec,unsupportedRequests:[]};
  const result=await strategies.propose(input);if(!result.ok)throw Error(result.message);
  return {id,view:result.view,plan:await service.read(id)};
 }
 return {db,service,strategies,takes,take,account};
}
test('one Coinbase portfolio participates in many Takes; a mixed Take appears per account with only that platform’s weights',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Shared crypto'),rh=await f.account('robinhood','Stocks'),other=await f.account('coinbase','Other crypto');
 const a=await f.take('First idea'),b=await f.take('Second idea');
 await f.service.save(request(a.plan,[{venue:'coinbase',accountId:cb},{venue:'robinhood',accountId:rh}]));
 await f.service.save(request(b.plan,[{venue:'coinbase',accountId:cb}]));
 expect((await f.service.forAccount(cb)).map(t=>t.title).sort()).toEqual(['First idea','Second idea']);
 expect((await f.service.forAccount(cb))[0].assets).toEqual([{symbol:'BTC',bps:4000}]);
 expect(await f.service.forAccount(rh)).toMatchObject([{takeId:a.id,assets:[{symbol:'VTI',bps:6000}]}]);
 expect(await f.service.forAccount(other)).toEqual([]);
 expect((await f.db.query('SELECT * FROM strategy_allocations')).rows).toEqual([]);
 expect((await f.db.query('SELECT * FROM strategy_attribution_entries')).rows).toEqual([]);
 expect((await f.db.query('SELECT * FROM linked_accounts WHERE selected')).rows).toEqual([]);
});
test('account plans reject wrong venues, missing accounts, duplicates and platforms absent from the basket',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Crypto'),rh=await f.account('robinhood','Stocks'),t=await f.take();
 await expect(f.service.save(request(t.plan,[{venue:'coinbase',accountId:rh}]))).rejects.toThrow('matching platform');
 await expect(f.service.save(request(t.plan,[{venue:'coinbase',accountId:randomUUID()}]))).rejects.toThrow('matching platform');
 expect(()=>f.service.save(request(t.plan,[{venue:'coinbase',accountId:cb},{venue:'coinbase',accountId:cb}]))).toThrow('one account per platform');
 const only=await f.take('Crypto only',{...mixed,target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:10000}],cashBps:0}});
 await expect(f.service.save(request(only.plan,[{venue:'robinhood',accountId:rh}]))).rejects.toThrow('not in this Take');
});
test('concurrent editors cannot overwrite account choices, and clearing one Take leaves other plans intact',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Crypto'),a=await f.take('A'),b=await f.take('B');
 const saved=await f.service.save(request(a.plan,[{venue:'coinbase',accountId:cb}]));
 await expect(f.service.save(request(a.plan,[]))).rejects.toThrow('choices changed');
 await f.service.save(request(b.plan,[{venue:'coinbase',accountId:cb}]));
 await f.service.save(request(saved,[]));
 expect((await f.service.forAccount(cb)).map(t=>t.takeId)).toEqual([b.id]);
});
test('changed drafts reject stale saves and no longer list removed platform sleeves',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Crypto'),t=await f.take();
 const saved=await f.service.save(request(t.plan,[{venue:'coinbase',accountId:cb}]));
 const result=await f.strategies.propose({targetTakeId:t.id,expectedRevision:t.view.draft.id,expectedVersion:null,operationId:randomUUID(),metadata:t.view.draft.metadata,spec:{...mixed,target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0}},unsupportedRequests:[]});
 expect(result.ok).toBe(true);
 await expect(f.service.save(request(saved,[]))).rejects.toThrow();
 expect(await f.service.forAccount(cb)).toEqual([]);
 expect((await f.service.read(t.id)).editable).toBe(false);
});
test('disconnect preserves existing choices but prevents newly assigning unavailable accounts',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Crypto'),a=await f.take(),b=await f.take();
 await f.service.save(request(a.plan,[{venue:'coinbase',accountId:cb}]));
 await f.db.query('UPDATE linked_accounts SET available=false WHERE id=$1',[cb]);
 const old=await f.service.read(a.id);expect(old.accounts[0].available).toBe(false);expect(old.routes.find(r=>r.venue==='coinbase')?.accountId).toBe(cb);
 await expect(f.service.save(request(b.plan,[{venue:'coinbase',accountId:cb}]))).rejects.toThrow('connected');
 await f.service.save(request(old,[]));
 expect(await f.service.forAccount(cb)).toEqual([]);
});
test('archived and funded Takes cannot repoint their accounts',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Crypto'),t=await f.take();
 await f.db.query('UPDATE takes SET archived_at=now() WHERE id=$1',[t.id]);
 await expect(f.service.save(request(t.plan,[{venue:'coinbase',accountId:cb}]))).rejects.toThrow('Restore');
 const active=await f.take();
 const committed=await f.strategies.commit({targetTakeId:active.id,expectedRevision:active.view.draft.id,expectedVersion:null,operationId:randomUUID()});
 if(!committed.ok)throw Error(committed.message);
 await f.db.query("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,created_at,updated_at) VALUES($1,$2,$3,$4,'USD','paused',now(),now())",[randomUUID(),cb,active.view.strategyId,committed.committedVersion]);
 expect((await f.service.read(active.id)).editable).toBe(false);
 await expect(f.service.save(request(active.plan,[{venue:'coinbase',accountId:cb}]))).rejects.toThrow('Funded');
});
test('durable Coinbase allocations freeze the account plan',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Crypto'),t=await f.take();
 const plan=await f.service.save(request(t.plan,[{venue:'coinbase',accountId:cb}]));
 const committed=await f.strategies.commit({targetTakeId:t.id,expectedRevision:t.view.draft.id,expectedVersion:null,operationId:randomUUID()});
 if(!committed.ok)throw Error(committed.message);
 await f.db.query('INSERT INTO coinbase_allocations(id,account_id,strategy_id,version_id,created_at) VALUES($1,$2,$3,$4,now())',[randomUUID(),cb,plan.strategyId,committed.view.currentVersion]);
 expect((await f.service.read(t.id)).editable).toBe(false);
 await expect(f.service.save(request(plan,[]))).rejects.toThrow('Funded Takes');
});

test('account cards exclude non-agentic Robinhood, count other Takes and reject read-only keys',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Trading'),readOnly=await f.account('coinbase','Read only'),rh=await f.account('robinhood','Personal');
 await f.db.query('UPDATE linked_accounts SET agentic_allowed=false WHERE id=$1',[rh]);
 await f.db.query('UPDATE coinbase_connection_details SET can_trade=false WHERE connection_id=(SELECT connection_id FROM linked_accounts WHERE id=$1)',[readOnly]);
 const a=await f.take('A'),b=await f.take('B');
 await f.service.save(request(a.plan,[{venue:'coinbase',accountId:cb}]));
 const view=await f.service.read(b.id);
 expect(view.accounts.some(account=>account.id===rh)).toBe(false);
 expect(view.accounts.find(account=>account.id===cb)).toMatchObject({otherTakeCount:1,disabledReason:null,balances:[]});
 expect((await f.service.read(a.id)).accounts.find(account=>account.id===cb)?.otherTakeCount).toBe(0);
 expect(view.accounts.find(account=>account.id===readOnly)?.disabledReason).toContain('read-only');
 await expect(f.service.save(request(view,[{venue:'coinbase',accountId:readOnly}]))).rejects.toThrow('read-only');
});

test('Coinbase account cards show USD and USDC buying power excluding holds',async()=>{
 const f=await fixture(),cb=await f.account('coinbase','Crypto'),t=await f.take();
 await f.db.query("INSERT INTO coinbase_transaction_history(account_id,checked_at,state,data) VALUES($1,now(),'complete',$2)",[cb,JSON.stringify({state:'complete',wallets:[
  {wallet:'usd',asset:'USD',available:'12.34',held:'5'},
  {wallet:'usdc',asset:'USDC',balance:'100.123456',available:'80.123456',held:'20'},
  {wallet:'btc',asset:'BTC',balance:'1',available:'1',held:'0'},
 ]})]);
 expect((await f.service.read(t.id)).accounts.find(a=>a.id===cb)?.balances).toEqual([{asset:'USD',amount:'12.34'},{asset:'USDC',amount:'80.123456'}]);
});

test('funded Robinhood account display comes from its allocation without a saved choice',async()=>{
 const f=await fixture(),rh=await f.account('robinhood','Original');
 const other=(await f.db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,nickname,agentic_allowed) SELECT connection_id,'other','other','Other',true FROM linked_accounts WHERE id=$1 RETURNING id",[rh])).rows[0].id;
 const t=await f.take('Stocks',{...mixed,target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0}});
 const committed=await f.strategies.commit({targetTakeId:t.id,expectedRevision:t.view.draft.id,expectedVersion:null,operationId:randomUUID()});
 if(!committed.ok)throw Error(committed.message);
 await f.db.query("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,created_at,updated_at) VALUES($1,$2,$3,$4,'USD','active',now(),now())",[randomUUID(),rh,t.view.strategyId,committed.committedVersion]);
 // Even if eligibility changes, show where the existing investment lives.
 await f.db.query('UPDATE linked_accounts SET agentic_allowed=false WHERE id=$1',[rh]);
 const plan=await f.service.read(t.id);
 expect(plan.editable).toBe(false);
 expect(plan.routes).toMatchObject([{venue:'robinhood',accountId:rh}]);
 expect(plan.accounts.find(a=>a.id===rh)?.label).toBe('Original');
 await expect(f.service.save(request(plan,[{venue:'robinhood',accountId:other}]))).rejects.toThrow('Funded');
});
