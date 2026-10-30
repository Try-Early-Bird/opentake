// The shared action core, venue registry and capabilities with a
// fake venue. Synthetic database and broker only.
import {expect,test} from 'vitest';
import {actionAdapterConformance,admissionConformance,dispatchConformance} from './action-conformance';
import {fakeHarness,fakeProfile} from './fake-venue';
import {createVenueRegistry,coinbaseProfile,robinhoodProfile} from '../../../src/main/venues/registry';
import {actionCapability} from '../../../src/main/execution/capabilities';
import {prepareRestoredDatabase} from '../../../src/main/migrations';
import {ruleTradeOutcome} from '../../../src/main/venues/coinbase';

actionAdapterConformance('fake venue',()=>fakeHarness());
admissionConformance('fake venue',()=>fakeHarness());
dispatchConformance('fake venue',()=>fakeHarness());

test('an unsupported action is recorded as blocked with its reason and never reaches an adapter',async()=>{
 const h=await fakeHarness();try{
  const job=await h.jobs.enqueue({kind:'buy',origin:'rule',originId:crypto.randomUUID(),idempotencyKey:'ro',accountId:h.account,venue:'fake',input:{amount:10},capability:{supported:false,reason:'read_only_key'}});
  expect(job).toMatchObject({state:'blocked',reason:'read_only_key'});
  await h.jobs.tick();expect(h.broker.sent()).toBe(0);expect(h.ledger.reserved.size).toBe(0);
  expect((await h.jobs.history(job.id)).map(e=>e.state)).toEqual(['blocked']);
 }finally{await h.close();}
});

test('a kind with no adapter on its venue is blocked; an unknown venue is refused',async()=>{
 const h=await fakeHarness();try{
  const job=await h.jobs.enqueue({kind:'trim',origin:'rule',originId:crypto.randomUUID(),idempotencyKey:'trim',accountId:h.account,venue:'fake'});
  await h.jobs.tick();expect(await h.jobs.get(job.id)).toMatchObject({state:'blocked',reason:'action_unsupported'});
  await expect(h.jobs.enqueue({kind:'buy',origin:'rule',originId:crypto.randomUUID(),idempotencyKey:'x',accountId:h.account,venue:'nowhere'})).rejects.toThrow('Unknown venue');
  await expect(h.jobs.enqueue({kind:'exit',origin:'rule',originId:crypto.randomUUID(),idempotencyKey:'trim',accountId:h.account,venue:'fake'})).rejects.toThrow('Idempotency key');
 }finally{await h.close();}
});

test('terminal jobs never move again and every transition is recorded',async()=>{
 const h=await fakeHarness();try{
  const job=await h.enqueue();await h.jobs.tick();await h.jobs.tick();await h.broker.fill('all');await h.jobs.tick();
  expect((await h.jobs.get(job.id))!.state).toBe('succeeded');
  await h.db.query("UPDATE action_jobs SET next_run_at=now()-interval '1 minute' WHERE id=$1",[job.id]);
  expect((await h.jobs.cancel(job.id))!.state).toBe('succeeded');
  expect((await h.jobs.history(job.id)).map(e=>e.state)).toEqual(['queued','running','succeeded']);
 }finally{await h.close();}
});

test('repeated adapter errors back off, then ask for attention instead of retrying forever',async()=>{
 const h=await fakeHarness();try{
  const job=await h.enqueue();
  for(let i=0;i<5;i++){
   await h.db.query("UPDATE action_jobs SET next_run_at=now()-interval '1 minute',input='{\"amount\":-1}' WHERE id=$1",[job.id]);
   await h.jobs.tick();
  }
  expect(await h.jobs.get(job.id)).toMatchObject({state:'needs_attention',reason:'adapter_error',attempts:5});
  expect(h.broker.sent()).toBe(0);
 }finally{await h.close();}
});

test('a restored backup never resumes an open action on its own',async()=>{
 const h=await fakeHarness();try{
  const job=await h.enqueue();await prepareRestoredDatabase(h.db as never);
  expect(await h.jobs.get(job.id)).toMatchObject({state:'cancelled',reason:'restored_backup'});
 }finally{await h.close();}
});

test('the registry rejects duplicate or mismatched modules and exposes profiles',()=>{
 const registry=createVenueRegistry([{profile:coinbaseProfile,adapters:{}},{profile:robinhoodProfile,adapters:{}}]);
 expect(registry.list().map(p=>p.id)).toEqual(['coinbase','robinhood']);
 expect(registry.profile('robinhood').session('equity').calendar).toBe('us-equity-regular');
 expect(registry.profile('coinbase').session('crypto').calendar).toBe('continuous');
 expect(()=>createVenueRegistry([{profile:coinbaseProfile,adapters:{}},{profile:coinbaseProfile,adapters:{}}])).toThrow('twice');
 expect(()=>createVenueRegistry([{profile:{...fakeProfile,id:'Bad Id'},adapters:{}}])).toThrow('Invalid venue');
 expect(()=>createVenueRegistry([{profile:fakeProfile,adapters:{buy:{kind:'trim',parse:x=>x,advance:async()=>({state:'running'})}}}])).toThrow('declares');
});

test('capabilities come from the profile, the adapters and the account, with a reason for every refusal',()=>{
 const buy={kind:'buy' as const,parse:(x:unknown)=>x,advance:async()=>({state:'running' as const})};
 const registry=createVenueRegistry([{profile:coinbaseProfile,adapters:{buy}},{profile:robinhoodProfile,adapters:{}}]);
 const ok={kind:'buy' as const,venue:'coinbase',account:{available:true,canTrade:true},tradingEnabled:true};
 expect(actionCapability(registry,ok)).toEqual({supported:true});
 expect(actionCapability(registry,{...ok,tradingEnabled:false})).toEqual({supported:false,reason:'trading_disabled'});
 expect(actionCapability(registry,{...ok,venue:'kraken'})).toEqual({supported:false,reason:'venue_unsupported'});
 expect(actionCapability(registry,{...ok,venue:'robinhood'})).toEqual({supported:false,reason:'action_unsupported'});
 expect(actionCapability(registry,{...ok,kind:'exit'})).toEqual({supported:false,reason:'action_unsupported'});
 expect(actionCapability(registry,{...ok,assetClasses:['equity']})).toEqual({supported:false,reason:'asset_unsupported'});
 expect(actionCapability(registry,{...ok,account:{available:false,canTrade:true}})).toEqual({supported:false,reason:'account_unavailable'});
 expect(actionCapability(registry,{...ok,account:{available:true,canTrade:false}})).toEqual({supported:false,reason:'read_only_key'});
 expect(actionCapability(registry,{kind:'agent_run',venue:null,account:null,tradingEnabled:false,takeId:'t'})).toEqual({supported:true});
 expect(actionCapability(registry,{kind:'take_change',venue:null,account:null,tradingEnabled:true,takeId:null})).toEqual({supported:false,reason:'take_required'});
});

test('a Coinbase rule trade reads as an action job: attention keeps being re-checked unless it is a partial rebalance',()=>{
 const row=(over:object)=>({state:'working',reason:null,phase:'initial' as const,review_id:'r',approval_pending:false,...over});
 expect(ruleTradeOutcome(row({state:'completed',reason:'filled'}))).toEqual({state:'succeeded',reason:'filled'});
 expect(ruleTradeOutcome(row({state:'blocked',reason:'request_expired'}))).toEqual({state:'blocked',reason:'request_expired'});
 expect(ruleTradeOutcome(row({state:'attention',reason:'partial_rebalance'}))).toEqual({state:'needs_attention',reason:'partial_rebalance'});
 expect(ruleTradeOutcome(row({state:'attention',reason:'order_needs_attention'}))).toMatchObject({state:'waiting',waitingFor:'account',reason:'order_needs_attention'});
 expect(ruleTradeOutcome(row({approval_pending:true}))).toMatchObject({state:'waiting',waitingFor:'approval'});
 expect(ruleTradeOutcome(row({phase:'buy',review_id:null}))).toEqual({state:'running',retryInMs:0});
 expect(ruleTradeOutcome(row({}))).toMatchObject({state:'running'});
 expect(ruleTradeOutcome(row({state:'blocked',reason:'Not A Reason'}))).toEqual({state:'blocked',reason:'unknown'});
 expect(ruleTradeOutcome(null)).toEqual({state:'failed',reason:'rule_trade_missing'});
});
