import { randomUUID } from 'node:crypto';
import { WorkerDatabase } from '../../src/main/database-client';
import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../src/main/migrations';
import {syncActionNotifications} from '../../src/main/action-notifications';
import {actionProgress,type ActionChild} from '../../src/shared/action-notification';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ActionProgressCard} from '../../src/renderer/src/components/ActionProgressCard';
const child=(overrides:Partial<ActionChild>={}):ActionChild=>({id:'a',strategyId:'s',takeTitle:'Mixed test',kind:'withdrawal',at:new Date().toISOString(),venue:'coinbase',account:'Opentake',orders:[{id:'o',symbol:'BTC',side:'sell',state:'filled',amount:'2.75',currency:'USDC',venue:'coinbase',account:'Opentake'}],state:'completed',message:null,returned:[{currency:'USDC',amount:'2.7254'}],receiptIds:[],...overrides});
test('mixed action waits for all accounts; the card lists orders, not money back',()=>{
 const a=actionProgress('parent',[child(),child({id:'b',venue:'robinhood',account:'MCP',orders:[{id:'b',symbol:'AAPL',side:'sell',state:'waiting',amount:'1.25',currency:'USD',venue:'robinhood',account:'MCP'}],state:'waiting',message:'Waiting for shares to settle',returned:[]})]);
 expect(a.state).toBe('waiting');expect(a.filled).toBe(1);expect(a.total).toBe(2);
 const html=renderToStaticMarkup(createElement(ActionProgressCard,{action:a}));
 for(const text of ['BTC','AAPL','Waiting for shares to settle'])expect(html).toContain(text);
 // Money back is read on the row's own view, not repeated in the card.
 expect(html).not.toContain('Back to');
 expect(html).not.toContain('Withdrawal complete');
});
test('all orders filled is not completion before cash release; failures stay actionable',()=>{
 expect(actionProgress('a',[child({state:'pending',returned:[]})]).state).toBe('pending');
 expect(actionProgress('a',[child({state:'attention'})]).state).toBe('attention');
 expect(actionProgress('a',[child()]).state).toBe('completed');
});
test('projection runs against migrated disposable database without creating phantom actions',async()=>{
 const db=new PGlite();try{await migrate(db);await syncActionNotifications(db,Date.now());expect((await db.query("SELECT 1 FROM notifications WHERE payload->>'kind'='action_update'")).rows).toHaveLength(0);}finally{await db.close();}
});


test('action projection yields between atomic groups and preserves notification identity', async () => {
 const db=new WorkerDatabase();
 try {
  await migrate(db);
  const ids=Array.from({length:5},()=>randomUUID());
  const [connection,account,strategy,version,allocation]=ids;
  await db.query("INSERT INTO platform_connections(id,owner_id,venue,status) SELECT $1,id,'robinhood','connected' FROM local_owners",[connection]);
  await db.query("INSERT INTO linked_accounts(id,connection_id,external_ref,masked_number,agentic_allowed) VALUES($1,$2,'synthetic','fixture',true)",[account,connection]);
  await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{"title":"Synthetic"}','{}','{}','{}' FROM local_owners`,[version,strategy]);
  await db.query("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,accepted_version_id,currency,status,created_at,updated_at) VALUES($1,$2,$3,$4,$4,'USD','active',now(),now())",[allocation,account,strategy,version]);
  for(let i=1;i<=3;i++)await db.query("INSERT INTO strategy_allocation_transactions(id,allocation_id,sequence,kind,trigger,idempotency_key,request_hash,created_at) VALUES($1::uuid,$2,$3,'contribution','synthetic',$1::text,$1::text,now())",[randomUUID(),allocation,i]);
  let groups=0;
  const adapter={query:db.query.bind(db),transaction:async<T>(work:Parameters<typeof db.transaction<T>>[0])=>{
   const result=await db.transaction(work);
   groups++;
   // This read completes between action groups, not after the whole history.
   expect((await db.query<{count:number}>("SELECT count(*)::int AS count FROM notifications WHERE payload->>'kind'='action_update'")).rows[0].count).toBe(groups);
   return result;
  }};
  await syncActionNotifications(adapter,Date.now());
  expect(groups).toBe(3);
  const before=(await db.query("SELECT id,sequence FROM notifications WHERE payload->>'kind'='action_update' ORDER BY id")).rows;
  await syncActionNotifications(db,Date.now());
  expect((await db.query("SELECT id,sequence FROM notifications WHERE payload->>'kind'='action_update' ORDER BY id")).rows).toEqual(before);
 }finally{await db.close();}
});

test('approval action describes review instead of suggesting that trading started',()=>{
 const a=actionProgress('approval',[child({kind:'rebalance',state:'awaiting_confirmation',orders:[{id:'o',symbol:'BTC',side:'sell',state:'reserved',amount:'1.94',currency:'USDC',venue:'coinbase',account:'Fixture'}]})]);
 expect(a.state).toBe('waiting');expect(a.title).toBe('Rebalance · Awaiting approval');
 const html=renderToStaticMarkup(createElement(ActionProgressCard,{action:a,onView:()=>{}}));
 expect(html).toContain('Review</span>');expect(html).toContain('aria-label="Review Mixed test: Rebalance · Awaiting approval"');expect(html).toContain('absolute inset-0');expect(html).toContain('Orders have not been submitted. Review them before confirming.');expect(html).toContain('Not submitted');expect(html).not.toContain('0 of 1 filled');
 const running=actionProgress('running',[child({kind:'rebalance',state:'pending',orders:[{...a.orders[0],state:'accepted'}]})]);
 expect(running.title).toBe('Rebalancing · 0 of 1 filled');
});

test('rule approval is matched by typed request key and malformed links do not break projection',async()=>{
 const db=new PGlite();try{
  await migrate(db);
  const [connection,account,strategy,version,allocation,take,request]=Array.from({length:7},()=>randomUUID());
  await db.query("INSERT INTO platform_connections(id,owner_id,venue,status,external_account_ref) SELECT $1,id,'coinbase','connected',$2 FROM local_owners",[connection,randomUUID()]);
  await db.query("INSERT INTO linked_accounts(id,connection_id,external_ref,masked_number) VALUES($1,$2,'synthetic','fixture')",[account,connection]);
  await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{"title":"Synthetic"}','{}','{}','{}' FROM local_owners`,[version,strategy]);
  await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Fixture','{}',$2 FROM local_owners",[take,strategy]);
  await db.query('INSERT INTO coinbase_allocations(id,account_id,strategy_id,version_id,created_at) VALUES($1,$2,$3,$4,now())',[allocation,account,strategy,version]);
  await db.query("INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,1,$2,0,'{}')",[take,version]);
  await db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,1,$3,'k',now(),now(),'executed','{}','{"rule":{"policy":{"approval":"ask"}}}')`,[request,take,randomUUID()]);
  const review=async(ruleRequestId:string)=>{const id=randomUUID();
   await db.query("INSERT INTO coinbase_order_reviews(id,take_id,account_id,allocation_id,version_id,authority,claims_hash,payload,state,created_at,expires_at) VALUES($1,$2,$3,$4,$5,'fixture','fixture',$6,'confirmed',now(),now()+interval '1 hour')",[id,take,account,allocation,version,JSON.stringify({quote:'USD',orders:[{product:'BTC-USD',side:'buy',notional:'10'}],rebalance:{scheduledOn:'2026-10-21',trigger:'rule',ruleRequestId,quoteRevision:ruleRequestId===request?1:2}})]);
   await db.query("INSERT INTO coinbase_allocation_orders(id,allocation_id,account_id,cause,request_hash,client_ref,product,side,max_base,state,created_at) VALUES($1,$2,$3,$4,'h',$5,'BTC-USD','buy',1,'prepared',now())",[randomUUID(),allocation,account,`review:${id}:0`,randomUUID()]);
   return id;};
  const linked=await review(request),malformed=await review('not-a-uuid');
  await syncActionNotifications(db,Date.now());
  const state=async(id:string)=>(await db.query<{state:string}>("SELECT payload->'action'->'accounts'->0->>'state' AS state FROM notifications WHERE payload->>'kind'='action_update' AND payload->'source'->>'id'=$1",[`cb:${id}`])).rows[0]?.state;
  expect(await state(linked)).toBe('awaiting_confirmation');expect(await state(malformed)).not.toBe('awaiting_confirmation');
 }finally{await db.close();}
});
