import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {readRuleActionPolicies} from '../../../src/main/strategies/rule-action-policy';
import {dataSourceThresholdPreset,type StrategyRule} from '../../../src/shared/strategy-rules';
async function fixture(){
 const db=new PGlite();await migrate(db);const take=randomUUID(),server=randomUUID();
 await db.query("INSERT INTO takes(id,owner_id,title,selection,permission_mode) SELECT $1,id,'Policy fixture','{}','auto' FROM local_owners",[take]);
 await db.query("INSERT INTO mcp_servers(id,config,enabled,policy) VALUES($1,'{}',true,'allowed')",[server]);
 await db.query("INSERT INTO mcp_tools(server_id,name,definition,fingerprint,policy) VALUES($1,'example_read','{}','fixture','allowed')",[server]);
 const rule=(action:StrategyRule['action'])=>({...dataSourceThresholdPreset(randomUUID(),'price','10',action),policy:{cooldownMs:1000,holdMs:0,maxRuns:1,expiresAfterMs:10000,approval:'within_existing_policy' as const}});
 const read=(rules:StrategyRule[],enabled=true)=>db.transaction(tx=>readRuleActionPolicies(tx,take,rules,enabled));
 return {db,take,server,rule,read};
}
test('chat Auto never overrides trading confirmation, stricter rules, or trading availability',async()=>{
 const f=await fixture();try{
  const rule=f.rule({kind:'rebalance_to_target',scope:{accountId:randomUUID()}});
  expect((await f.read([rule]))[0]).toMatchObject({approval:'not_required',execution:'preview_only',reason:'existing_trading_policy'});
  await f.db.query('INSERT INTO trading_preferences(owner_id,confirm_trades,updated_at) SELECT id,true,now() FROM local_owners ON CONFLICT(owner_id) DO UPDATE SET confirm_trades=true');
  expect((await f.read([rule]))[0]).toMatchObject({approval:'required',reason:'confirm_every_trade'});
  await f.db.query('UPDATE trading_preferences SET confirm_trades=false');
  await f.db.query("UPDATE takes SET permission_mode='ask' WHERE id=$1",[f.take]);
  expect((await f.read([rule]))[0].approval).toBe('not_required');
  expect((await f.read([{...rule,policy:{...rule.policy,approval:'ask'}}]))[0]).toMatchObject({approval:'required',reason:'rule_requires_confirmation'});
  expect((await f.read([rule],false))[0]).toMatchObject({approval:'blocked',reason:'trading_disabled'});
  // Trade actions no venue executes yet say so, rather than describing an approval path.
  // Deploy cash is a rule trade like a rebalance (preview only until this account is granted).
  expect((await f.read([f.rule({kind:'deploy_cash',scope:{accountId:randomUUID()},amount:{value:'10',currency:'USD'}} as never)]))[0]).toMatchObject({execution:'preview_only'});
  // An exit suggests a new target for the member to accept.
  expect((await f.read([f.rule({kind:'exit',scope:{accountId:randomUUID()}} as never)]))[0]).toMatchObject({approval:'required',reason:'target_change_suggestion',execution:'preview_only'});
 }finally{await f.db.close();}
});
test('agent tool policy reuses most-restrictive server/tool/Take settings and resolves changes on every read',async()=>{
 const f=await fixture();try{
  const rule=f.rule({kind:'agent',instructions:{format:'prompt',text:'Assess'},capabilities:{tools:['example_read'],accountIds:[],actions:['notify']},budget:{maxDurationMs:1000,maxToolCalls:1,maxCostUsd:'1'}});
  expect((await f.read([rule]))[0]).toMatchObject({approval:'not_required',execution:'preview_only'});
  await f.db.query("UPDATE takes SET permission_mode='ask' WHERE id=$1",[f.take]);expect((await f.read([rule]))[0].approval).toBe('required');
  await f.db.query("UPDATE takes SET permission_mode='auto' WHERE id=$1",[f.take]);
  await f.db.query("INSERT INTO take_tool_permissions(take_id,server_id,tool_name,policy) VALUES($1,$2,'','blocked')",[f.take,f.server]);
  expect((await f.read([rule]))[0].approval).toBe('blocked');
  await f.db.query('DELETE FROM take_tool_permissions');await f.db.query("UPDATE mcp_tools SET policy='ask'");expect((await f.read([rule]))[0].approval).toBe('required');
  await f.db.query('UPDATE mcp_servers SET enabled=false');expect((await f.read([rule]))[0].approval).toBe('blocked');
  await f.db.query("UPDATE mcp_servers SET enabled=true,policy='blocked'");expect((await f.read([rule]))[0].approval).toBe('blocked');
 }finally{await f.db.close();}
});
test('Take changes and generic review do not inherit tool Auto, and reads never dispatch or write',async()=>{
 const f=await fixture();try{
  const rules=[f.rule({kind:'pause_self'}),f.rule({kind:'request_review',message:'Review'}),f.rule({kind:'notify',message:'Reminder'})];
  expect((await f.read(rules)).map(r=>[r.approval,r.reason])).toEqual([['required','take_change_requires_acceptance'],['blocked','concrete_proposal_required'],['blocked','notifications_disabled']]);
  expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(0);expect((await f.db.query('SELECT id FROM take_runs')).rows).toHaveLength(0);expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  await f.db.query('UPDATE takes SET archived_at=now()');expect((await f.read(rules)).every(r=>r.reason==='take_archived')).toBe(true);
  await expect(f.db.transaction(tx=>readRuleActionPolicies(tx,randomUUID(),rules))).rejects.toThrow('Take unavailable');
 }finally{await f.db.close();}
});

// A Take with a committed strategy, an accepted and granted rebalance rule, and one account.
async function tradingFixture(venue:'coinbase'|'robinhood'){
 const db=new PGlite();await migrate(db);
 const take=randomUUID(),strategy=randomUUID(),version=randomUUID(),allocation=randomUUID();
 const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,$1,'connected','fixture' FROM local_owners RETURNING id",[venue])).rows[0].id;
 const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed) VALUES($1,'x','fixture',true) RETURNING id",[connection])).rows[0].id;
 await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
 await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
 await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id,permission_mode) SELECT $1,id,'Trading fixture','{}',$2,'auto' FROM local_owners",[take,strategy]);
 const rule={...dataSourceThresholdPreset(randomUUID(),'price','10',{kind:'rebalance_to_target',scope:{accountId:account}}),policy:{cooldownMs:1000,holdMs:0,maxRuns:1,expiresAfterMs:10000,approval:'within_existing_policy' as const}};
 await db.query("INSERT INTO take_input_revisions(take_id,revision,accepted_version,config) VALUES($1,1,$2,'{\"inputs\":[],\"maxSkewMs\":5000}')",[take,version]);
 await db.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,1,$2,1,$3)',[take,version,JSON.stringify({schemaVersion:1,rules:[rule]})]);
 await db.query('INSERT INTO strategy_rule_accepted(take_id,revision,trading_enabled,trading_rule_ids,disabled_rule_ids) VALUES($1,1,true,$2,$3)',[take,[rule.id],[]]);
 await db.query('INSERT INTO strategy_rule_shadow(take_id,draft_revision,enabled,notifications_enabled) VALUES($1,1,true,true)',[take]);
 const route=async()=>{await db.query('INSERT INTO strategy_account_plans(strategy_id,revision) VALUES($1,$2) ON CONFLICT DO NOTHING',[strategy,randomUUID()]);await db.query('INSERT INTO strategy_account_routes(strategy_id,venue,account_id) VALUES($1,$2,$3)',[strategy,venue,account]);};
 const allocate=()=>db.query("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,created_at,updated_at) VALUES($1,$2,$3,$4,'USD','active',now(),now())",[allocation,account,strategy,version]);
 const execution=async()=>(await db.transaction(tx=>readRuleActionPolicies(tx,take,[rule],true)))[0].execution;
 return {db,take,account,allocation,rule,route,allocate,execution};
}

test('a granted Robinhood rule reads as trading exactly when its engine would trade: an available account holding the active allocation',async()=>{
 const f=await tradingFixture('robinhood');try{
  expect(await f.execution()).toBe('preview_only');
  // A route alone is not what the Robinhood engine trades on.
  await f.route();expect(await f.execution()).toBe('preview_only');
  await f.allocate();expect(await f.execution()).toBe('trading');
  await f.db.query("UPDATE strategy_allocations SET status='paused' WHERE id=$1",[f.allocation]);expect(await f.execution()).toBe('preview_only');
  await f.db.query("UPDATE strategy_allocations SET status='active',restore_required=true WHERE id=$1",[f.allocation]);expect(await f.execution()).toBe('preview_only');
  await f.db.query('UPDATE strategy_allocations SET restore_required=false WHERE id=$1',[f.allocation]);
  await f.db.query('UPDATE linked_accounts SET available=false WHERE id=$1',[f.account]);expect(await f.execution()).toBe('preview_only');
  await f.db.query('UPDATE linked_accounts SET available=true WHERE id=$1',[f.account]);expect(await f.execution()).toBe('trading');
  await f.db.query('UPDATE strategy_rule_accepted SET trading_rule_ids=$2 WHERE take_id=$1',[f.take,[]]);expect(await f.execution()).toBe('preview_only');
  await f.db.query('UPDATE strategy_rule_accepted SET trading_rule_ids=$2 WHERE take_id=$1',[f.take,[f.rule.id]]);
  await f.db.query('UPDATE strategy_rule_shadow SET enabled=false WHERE take_id=$1',[f.take]);expect(await f.execution()).toBe('preview_only');
 }finally{await f.db.close();}
});

test('Coinbase is unchanged: its route makes a granted rule trading, and an allocation-style row alone does not',async()=>{
 const f=await tradingFixture('coinbase');try{
  expect(await f.execution()).toBe('preview_only');
  await f.allocate();expect(await f.execution()).toBe('preview_only');
  await f.route();expect(await f.execution()).toBe('trading');
 }finally{await f.db.close();}
});
