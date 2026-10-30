// The venue-neutral admission check over a real schema: a firing, its accepted and
// granted rule, trading on, and a venue that can do the action. Synthetic database only.
import {afterEach,expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {ruleTradeAdmission} from '../../../src/main/execution/admission';
import {createVenueRegistry,robinhoodProfile} from '../../../src/main/venues/registry';
import {dataSourceThresholdPreset} from '../../../src/shared/strategy-rules';
import type {ActionJob} from '../../../src/main/venues/types';
const dbs:PGlite[]=[];afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});

async function fixture(){
 const db=new PGlite();dbs.push(db);await migrate(db);const database={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const strategy=randomUUID(),version=randomUUID(),take=randomUUID();
 await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners`,[version,strategy]);
 await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
 await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Fixture','{}',$2 FROM local_owners",[take,strategy]);
 const rule=dataSourceThresholdPreset(randomUUID(),'price','10',{kind:'rebalance_to_target',scope:{accountId:account}} as never);
 await db.query("INSERT INTO take_input_revisions(take_id,revision,accepted_version,config) VALUES($1,1,$2,'{\"inputs\":[],\"maxSkewMs\":5000}')",[take,version]);
 await db.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,1,$2,1,$3)',[take,version,JSON.stringify({schemaVersion:1,rules:[rule]})]);
 await db.query('INSERT INTO strategy_rule_accepted(take_id,revision,trading_enabled,trading_rule_ids,disabled_rule_ids) VALUES($1,1,true,$2,$3)',[take,[rule.id],[]]);
 await db.query('INSERT INTO strategy_rule_shadow(take_id,draft_revision,enabled,notifications_enabled) VALUES($1,1,true,true)',[take]);
 const request=randomUUID();
 await db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,1,$3,'k',now(),now()+interval '1 hour','shadow',$4,'{}')`,[request,take,rule.id,JSON.stringify(rule.action)]);
 const adapter={kind:'rebalance_to_target' as const,parse:(x:unknown)=>x,advance:async()=>({state:'running' as const})};
 const registry=createVenueRegistry([{profile:robinhoodProfile,admission:'core',adapters:{rebalance_to_target:adapter}}]);
 let trading=true;
 const admit=ruleTradeAdmission(database as never,registry,()=>trading);
 const job=(over:Partial<ActionJob>={}):ActionJob=>({id:randomUUID(),kind:'rebalance_to_target',origin:'rule',originId:request,takeId:take,accountId:account,venue:'robinhood',input:{},state:'queued',waitingFor:null,reason:null,attempts:0,adapterState:{},createdAt:new Date(),updatedAt:new Date(),startedAt:null,...over});
 return {db,take,rule,request,account,admit,job,setTrading:(on:boolean)=>{trading=on;}};
}

test('a granted, active firing on a venue that can do the action is admitted',async()=>{
 const f=await fixture();
 expect(await f.admit(f.job(),false)).toEqual({admitted:true});
 // Agent runs and Take changes carry their own permissions.
 expect(await f.admit(f.job({kind:'agent_run',venue:null,accountId:null}),false)).toEqual({admitted:true});
 // A member's own action has no firing to check.
 expect(await f.admit(f.job({origin:'member',originId:randomUUID()}),false)).toEqual({admitted:true});
});

test('every refusal has the same reason the Robinhood guard gives today',async()=>{
 const f=await fixture();
 f.setTrading(false);expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'trading_disabled'});f.setTrading(true);
 expect(await f.admit(f.job({kind:'exit'}),false)).toEqual({admitted:false,reason:'action_unsupported'});
 await f.db.query('UPDATE linked_accounts SET available=false WHERE id=$1',[f.account]);
 expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'account_unavailable'});
 await f.db.query('UPDATE linked_accounts SET available=true WHERE id=$1',[f.account]);
 await f.db.query('UPDATE strategy_rule_accepted SET trading_rule_ids=$2 WHERE take_id=$1',[f.take,[]]);
 expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'trading_not_granted'});
 await f.db.query('UPDATE strategy_rule_accepted SET trading_rule_ids=$2,disabled_rule_ids=$2 WHERE take_id=$1',[f.take,[f.rule.id]]);
 expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'rule_off'});
 await f.db.query('UPDATE strategy_rule_accepted SET disabled_rule_ids=$2 WHERE take_id=$1',[f.take,[]]);
 await f.db.query("UPDATE strategy_rule_action_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",[f.request]);
 expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'request_expired'});
 // Once the adapter has run, an expired request no longer refuses: an approval stays open until decided.
 expect(await f.admit(f.job(),true)).toEqual({admitted:true});
 await f.db.query("UPDATE strategy_rule_action_requests SET expires_at=now()+interval '1 hour',status='expired' WHERE id=$1",[f.request]);
 expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'request_inactive'});
 await f.db.query("UPDATE strategy_rule_action_requests SET status='shadow' WHERE id=$1",[f.request]);
 await f.db.query('UPDATE strategy_rule_shadow SET enabled=false WHERE take_id=$1',[f.take]);
 expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'request_inactive'});
 await f.db.query('UPDATE strategy_rule_shadow SET enabled=true WHERE take_id=$1',[f.take]);
 await f.db.query('UPDATE takes SET archived_at=now() WHERE id=$1',[f.take]);
 expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'request_inactive'});
 await f.db.query('UPDATE takes SET archived_at=NULL WHERE id=$1',[f.take]);
 const newer=randomUUID();
 await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,strategy_id,owner_id,2,1,'{}','{}','{}','{}' FROM strategy_versions WHERE id=(SELECT current_version_id FROM strategies WHERE id=(SELECT strategy_id FROM takes WHERE id=$2))`,[newer,f.take]);
 await f.db.query('UPDATE strategies SET current_version_id=$2 WHERE id=(SELECT strategy_id FROM takes WHERE id=$1)',[f.take,newer]);
 expect(await f.admit(f.job(),false)).toEqual({admitted:false,reason:'take_version_changed'});
});
