import { afterEach, expect, test, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../../src/main/migrations';
import { createStrategies, contextMarkers, mergeContext } from '../../../src/main/strategies/service';
import { createTakes } from '../../../src/main/takes';
import type { ProposalInput, Verification, BasketView, WriteResult } from '../../../src/shared/strategies';
const databases:PGlite[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(d=>d.close()));});
const verification:Verification={policy:'personal_basket',version:1,checkedAt:'2026-10-02T00:00:00Z',accountRef:null,results:[{instrument:{venue:'robinhood',symbol:'VTI'},state:'unknown',tradable:null,fractional:null,reason:'No account'}]};
function input(take:string,view?:BasketView|null):ProposalInput{return {targetTakeId:take,expectedRevision:view?.draft.id??null,expectedVersion:view?.currentVersion??null,operationId:randomUUID(),metadata:{title:'Synthetic basket',description:'',rationale:'Synthetic fixture',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]};}
function ok(result:WriteResult){expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.message);return result;}
const action=(view:BasketView)=>({targetTakeId:view.targetTakeId,expectedRevision:view.draft.id,expectedVersion:view.currentVersion,operationId:randomUUID()});
async function fixture(){
 const db=new PGlite();databases.push(db);await migrate(db);const database={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const active=new Set<string>(),ensure=vi.fn(async(_run:string)=>{}),verify=vi.fn(async()=>structuredClone(verification));
 const service=createStrategies(database,{active:r=>active.has(r),ensure,verify});
 const takes=createTakes(database,async()=>{},async()=>({ok:true,source:'runtime',models:[]}));
 async function take(){return takes.create();}
 async function run(takeId:string){const id=randomUUID(),message=randomUUID();await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running',$4)",[id,takeId,randomUUID(),JSON.stringify({selection:{provider:'claude',model:'synthetic'}})]);await db.query('INSERT INTO take_messages(id,take_id,parent_id,data) VALUES($1,$2,NULL,$3)',[message,takeId,JSON.stringify({id:message,parentId:null,role:'assistant',runId:id,text:'Synthetic',state:'running'})]);active.add(id);return {id,message};}
 return {db,database,service,takes,take,run,active,ensure,verify};
}
test('drafts, immutable commits, clean no-op, old revision copies and restart retries share one authoring history',async()=>{
 const f=await fixture(),t=await f.take(),request=input(t);const first=ok(await f.service.propose(request));
 expect(first.view.draft.revision).toBe(1);expect(first.view.clean).toBe(false);expect((await f.takes.load(t)).archiveOnly).toBe(true);
 const accept=action(first.view),committed=ok(await f.service.commit(accept));expect(committed.view.clean).toBe(true);expect(committed.view.versions).toHaveLength(1);
 const clean=ok(await f.service.commit(action(committed.view)));expect(clean.committedVersion).toBe(committed.committedVersion);expect(clean.view.versions).toHaveLength(1);
 const edit=input(t,committed.view);edit.metadata.title='Revised';edit.spec.rebalance={schedule:'quarterly',driftBandPoints:5,driftBandRelative:20};
 const second=ok(await f.service.propose(edit));expect(second.view.currentVersion).toBe(committed.committedVersion);expect(second.view.clean).toBe(false);
 const v2=ok(await f.service.commit(action(second.view)));expect(v2.view.versions).toHaveLength(2);
 const reopened=createStrategies(f.database,{active:()=>false,ensure:async()=>{},verify:f.verify});
 expect(ok(await reopened.propose(request)).proposalId).toBe(first.proposalId);
 expect(ok(await reopened.commit(accept)).committedVersion).toBe(committed.committedVersion);
 const copied=ok(await reopened.useRevision({...action(v2.view),proposalId:first.view.draft.id}));expect(copied.view.draft.revision).toBe(3);expect(copied.view.draft.copiedFrom).toBe(first.view.draft.id);expect(copied.view.draft.metadata.title).toBe('Synthetic basket');expect(copied.view.clean).toBe(false);
 await expect(f.db.query("UPDATE strategy_versions SET metadata='{}' WHERE id=$1",[committed.committedVersion])).rejects.toThrow(/append-only/);
 await expect(f.db.query('DELETE FROM strategy_proposals WHERE id=$1',[first.proposalId])).rejects.toThrow(/append-only/);
 await expect(f.takes.remove(t)).rejects.toThrow(/Archive/);
 const research=await f.take();await f.takes.remove(research);expect((await f.db.query('SELECT id FROM takes WHERE id=$1',[research])).rows).toHaveLength(0);
});
test('stale manual edits and concurrent commits cannot replace a newer revision or double-commit',async()=>{
 const f=await fixture(),t=await f.take(),v=ok(await f.service.propose(input(t))).view;
 const a=input(t,v),b=input(t,v);a.metadata.title='A';b.metadata.title='B';
 const edits=await Promise.all([f.service.propose(a),f.service.propose(b)]);expect(edits.filter(r=>r.ok)).toHaveLength(1);
 const latest=(await f.service.read(t))!;
 expect((await f.service.commit(action(v))).ok).toBe(false);
 const accepted=await Promise.all([f.service.commit(action(latest)),f.service.commit(action(latest))]);expect(accepted.filter(r=>r.ok)).toHaveLength(1);expect((await f.service.read(t))?.versions).toHaveLength(1);
});
test('commit rechecks the draft after provider verification returns',async()=>{
 const f=await fixture(),t=await f.take(),v=ok(await f.service.propose(input(t))).view;
 let release!:(v:Verification)=>void;f.verify.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const commit=f.service.commit(action(v));await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 const edit=ok(await f.service.propose(input(t,v)));release(verification);
 expect((await commit).ok).toBe(false);expect((await f.service.read(t))?.draft.id).toBe(edit.proposalId);expect((await f.service.read(t))?.versions).toHaveLength(0);
});
test('cross-chat writes retain actual provenance, union account markers, and gate reads and conflicts',async()=>{
 const f=await fixture(),target=await f.take(),source=await f.take(),run=await f.run(source);
 await f.db.transaction(tx=>mergeContext(tx,source,['robinhood:source-account']));
 await f.db.transaction(tx=>mergeContext(tx,target,['robinhood:target-account']));
 f.ensure.mockImplementation(async()=>{expect(await contextMarkers(f.db,source)).toEqual(['robinhood:source-account','robinhood:target-account']);});
 const proposed=await f.service.agentPropose(run.id,input(target));expect(proposed.ok).toBe(true);
 const v=(await f.service.read(target))!;expect(v.draft).toMatchObject({sourceTakeId:source,sourceRunId:run.id,sourceMessageId:run.message,producer:'agent'});
 expect(await contextMarkers(f.db,target)).toEqual(['robinhood:source-account','robinhood:target-account']);expect(f.ensure).toHaveBeenCalledWith(run.id);
 expect((await f.service.messageProposals(run.message))[0].proposal.id).toBe(v.draft.id);expect(await f.service.source(v.draft.id)).toEqual({messageId:run.message,takeId:source,text:'Synthetic'});
 f.ensure.mockRejectedValue(new Error('Declined'));await expect(f.service.agentRead(run.id,target)).rejects.toThrow('Declined');await expect(f.service.agentPropose(run.id,input(target))).rejects.toThrow('Declined');
 await f.takes.update(source,{archived:true});expect((await f.service.read(target))?.archivedAt).toBeNull();await expect(f.service.agentPropose(run.id,input(target,v))).rejects.toThrow(/unavailable/);
 await expect(f.takes.remove(source)).rejects.toThrow(/Archive/);
 await f.takes.update(target,{archived:true});expect(await f.service.list()).toEqual([]);expect(await f.service.list(true)).toHaveLength(1);
 await expect(f.service.propose(input(target,v))).rejects.toThrow(/Restore/);
 await f.takes.update(target,{archived:false});expect((await f.service.list())).toHaveLength(1);expect((await f.service.read(target))?.proposals).toHaveLength(1);
});
test('stopped runs and archived targets reject late verification results',async()=>{
 const f=await fixture(),target=await f.take(),source=await f.take(),run=await f.run(source);
 let release!:(v:Verification)=>void;f.verify.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const pending=f.service.agentPropose(run.id,input(target));await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.active.delete(run.id);release(verification);await expect(pending).rejects.toThrow('stopped');expect(await f.service.read(target)).toBeNull();
 f.verify.mockImplementationOnce(()=>new Promise(r=>{release=r;}));release=undefined!;const manual=f.service.propose(input(target));await vi.waitFor(()=>expect(release).toBeTypeOf('function'));await f.takes.update(target,{archived:true});release(verification);await expect(manual).rejects.toThrow(/Restore/);expect(await f.service.read(target)).toBeNull();
});
test('AI → manual → AI round trip retains venue, metadata and new base version independently of chat branches',async()=>{
 const f=await fixture(),t=await f.take(),run=await f.run(t);await f.service.agentPropose(run.id,input(t));const initial=(await f.service.read(t))!;
 const manual=input(t,initial);manual.metadata.holdings=[{instrument:{venue:'robinhood',symbol:'VTI'},reason:'Synthetic reason'}];manual.spec.rebalance.schedule='annual';
 const saved=ok(await f.service.propose(manual));const committed=ok(await f.service.commit(action(saved.view)));
 await f.takes.update(t,{headId:run.message});expect((await f.service.read(t))?.draft.id).toBe(saved.proposalId);
 const followup=input(t,committed.view);followup.metadata=committed.view.draft.metadata;followup.spec=committed.view.draft.spec;followup.metadata.description='Follow-up';
 await f.service.agentPropose(run.id,followup);const latest=(await f.service.read(t))!;expect(latest.draft.baseVersion).toBe(committed.committedVersion);expect(latest.draft.metadata.holdings[0].reason).toBe('Synthetic reason');expect(latest.draft.spec.rebalance.schedule).toBe('annual');
 const page=await f.service.history(t,latest.draft.revision);expect(page.proposals.map(p=>p.revision)).toEqual([2,1]);expect(page.versions[0].id).toBe(committed.committedVersion);
});
test('backup restore preserves authoring history and idempotency without resuming runs or creating allocations',async()=>{
 const {prepareRestoredDatabase}=await import('../../../src/main/migrations');
 const f=await fixture(),t=await f.take(),source=await f.take(),run=await f.run(source);await f.service.agentPropose(run.id,input(t));const v=(await f.service.read(t))!,request=action(v),saved=ok(await f.service.commit(request));
 const snapshot=await f.db.dumpDataDir('gzip');const restored=new PGlite({loadDataDir:snapshot});databases.push(restored);await prepareRestoredDatabase(restored);
 const service=createStrategies({use:async fn=>fn(restored)},{active:()=>false,ensure:async()=>{},verify:f.verify});
 expect(await service.read(t)).toEqual(saved.view);expect(ok(await service.commit(request)).committedVersion).toBe(saved.committedVersion);
 expect((await restored.query('SELECT state FROM take_runs WHERE id=$1',[run.id])).rows[0]).toEqual({state:'interrupted'});
 expect((await restored.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(0);
});
test('committing a take with money in it is refused for high turnover or investments too small, unless accepted (hosted publish guards)',async()=>{
 const f=await fixture(),t=await f.take(),first=ok(await f.service.commit(action(ok(await f.service.propose(input(t))).view)));
 // No money in it: anything commits.
 const free=input(t,first.view);free.spec.target.weights=[{instrument:{venue:'robinhood',symbol:'BND'},bps:10000}];
 const moved=ok(await f.service.commit(action(ok(await f.service.propose(free)).view)));
 // $5 invested in the committed version.
 const connection=(await f.db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0]!.id;
 const account=(await f.db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0]!.id;
 await f.db.query(`INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,allocation_value,created_at,updated_at) VALUES($1,$2,$3,$4,'USD','active',5,now(),now())`,
  [randomUUID(),account,moved.view.strategyId,moved.committedVersion]);
 // Back to VTI: everything is sold and rebought.
 const swap=input(t,moved.view);swap.spec.target.weights=[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}];
 const draft=ok(await f.service.propose(swap)).view;
 expect(await f.service.commitReview(t)).toMatchObject({investments:1,turnoverPercent:100,highTurnover:true,belowMinimum:0});
 expect(await f.service.commit(action(draft))).toMatchObject({ok:false,conflict:false,code:'high_turnover'});
 expect((await f.service.read(t))!.currentVersion).toBe(moved.committedVersion);
 const accepted=ok(await f.service.commit({...action(draft),acceptHighTurnover:true}));
 expect(accepted.view.clean).toBe(true);
 // A 10% holding of $5 is under the $1 minimum.
 const thin=input(t,accepted.view);thin.spec.target.weights=[{instrument:{venue:'robinhood',symbol:'VTI'},bps:9000},{instrument:{venue:'robinhood',symbol:'BND'},bps:1000}];
 const small=ok(await f.service.propose(thin)).view;
 expect(await f.service.commitReview(t)).toMatchObject({highTurnover:false,turnoverPercent:10,belowMinimum:1,smallestValueUsd:'5.00',weightThatFitsPercent:20});
 expect(await f.service.commit(action(small))).toMatchObject({ok:false,conflict:false,code:'followers_below_minimum'});
 ok(await f.service.commit({...action(small),acceptStranded:true}));
});

test('mixed-platform research saves venue identity but cannot replace a funded Robinhood basket',async()=>{
 const f=await fixture(),t=await f.take(),proposal=input(t);
 proposal.spec.target.weights=[{instrument:{venue:'robinhood',symbol:'VTI'},bps:5000},{instrument:{venue:'coinbase',symbol:'VTI'},bps:5000}];
 const saved=ok(await f.service.commit(action(ok(await f.service.propose(proposal)).view)));
 expect(saved.view.draft.spec.target.weights.map(w=>w.instrument.venue)).toEqual(['robinhood','coinbase']);
 const fundedTake=await f.take(),funded=ok(await f.service.commit(action(ok(await f.service.propose(input(fundedTake))).view)));
 const connection=(await f.db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id")).rows[0].id;
 const account=(await f.db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic','fixture',true,true) RETURNING id",[connection])).rows[0].id;
 await f.db.query("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,allocation_value,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,$3,'USD','paused',100,now(),now())",[account,funded.view.strategyId,funded.committedVersion]);
 const changed=input(fundedTake,funded.view);changed.spec=proposal.spec;
 const draft=ok(await f.service.propose(changed));
 await expect(f.service.commit({...action(draft.view),acceptHighTurnover:true,acceptStranded:true})).rejects.toThrow('mixed-platform');
 expect((await f.service.read(fundedTake))?.currentVersion).toBe(funded.committedVersion);
});

test('crypto research survives commit and reopening, but cannot replace a funded equity version',async()=>{
 const f=await fixture(),take=await f.take();
 const original=ok(await f.service.commit(action(ok(await f.service.propose(input(take))).view)));
 const request=input(take,original.view);
 const crypto={venue:'robinhood',symbol:'VTI',market:{venue:'robinhood',instance:'production',kind:'crypto',reference:'synthetic-pair'}};
 request.spec.target.weights=[{instrument:{venue:'robinhood',symbol:'VTI'},bps:5000},{instrument:crypto,bps:5000}];
 const draft=ok(await f.service.propose(request));
 const saved=ok(await f.service.commit(action(draft.view)));
 expect(saved.view.draft.spec.target.weights[1].instrument).toEqual(crypto);
 const reopened=createStrategies(f.database,{active:()=>false,ensure:async()=>{},verify:f.verify});
 expect((await reopened.read(take))?.draft.spec).toEqual(request.spec);
 const old=(await f.db.query<{spec:unknown}>('SELECT spec FROM strategy_versions WHERE id=$1',[original.committedVersion])).rows[0];
 expect(old.spec).toEqual(input(take).spec);
 const connection=(await f.db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id")).rows[0].id;
 const account=(await f.db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic','fixture',true,true) RETURNING id",[connection])).rows[0].id;
 const fundedTake=await f.take(),funded=ok(await f.service.commit(action(ok(await f.service.propose(input(fundedTake))).view)));
 await f.db.query("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,allocation_value,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,$3,'USD','paused',100,now(),now())",[account,funded.view.strategyId,funded.committedVersion]);
 const edit=input(fundedTake,funded.view);edit.spec=request.spec;
 const blocked=ok(await f.service.propose(edit));
 await expect(f.service.commit({...action(blocked.view),acceptHighTurnover:true,acceptStranded:true})).rejects.toThrow('research-only');
 expect((await f.service.read(fundedTake))?.currentVersion).toBe(funded.committedVersion);
});

test('the AI reads recent messages bounded: newest kept, long ones cut and marked, older ones counted',async()=>{
 const {recentMessages}=await import('../../../src/main/strategies/service');
 const long='x'.repeat(5000),msgs=Array.from({length:50},(_,i)=>({id:String(i),role:i%2?'assistant':'user',text:i===49?long:`m${i}`}));
 const read=recentMessages(msgs,2000,2100);
 expect(read.items.at(-1)).toEqual({id:'49',role:'assistant',text:'x'.repeat(2000),truncated:true});
 expect(read.items.map(m=>m.id)).toEqual(Array.from({length:read.items.length},(_,i)=>String(50-read.items.length+i)));
 expect(read.olderOmitted).toBe(40-read.items.length);
 expect(recentMessages([{id:'a',role:'user',text:'hi'}])).toEqual({items:[{id:'a',role:'user',text:'hi'}]});
});
test('a chat proposal the member asks to review is saved beside their draft, except as a new take\'s first draft',async()=>{
 const f=await fixture(),t=await f.take(),run=await f.run(t);
 // No draft yet: nothing to keep, so the first proposal becomes the draft without waiting for anyone.
 const first=input(t);first.metadata.title='First draft';
 expect(await f.service.agentPropose(run.id,first,{suggest:true})).not.toHaveProperty('suggested');
 const view=(await f.service.read(t))!;expect(view.draft.metadata.title).toBe('First draft');
 const next=input(t,view);next.metadata.title='Chat suggestion';
 const result=await f.service.agentPropose(run.id,next,{suggest:true}) as {ok:boolean;suggested?:boolean;proposalId?:string;note?:string};
 expect(result).toMatchObject({ok:true,suggested:true});expect(result.note).toContain('draft is unchanged');
 expect((await f.service.read(t))!.draft.metadata.title).toBe('First draft');
 // It stays in the take until the member applies it; nothing expires.
 const applied=ok(await f.service.useRevision({...action((await f.service.read(t))!),proposalId:result.proposalId!}));
 expect(applied.view.draft.metadata.title).toBe('Chat suggestion');
});
test('an automatic rule run suggests a Take change without touching the draft; the member applies or dismisses it',async()=>{
 const f=await fixture(),t=await f.take();
 const committed=ok(await f.service.commit(action(ok(await f.service.propose(input(t))).view)));
 const mine=input(t,committed.view);mine.metadata.title='Member draft';const draft=ok(await f.service.propose(mine)).view;
 const run=await f.run(t);await f.db.query(`UPDATE take_runs SET configuration=configuration||'{"unattended":true,"rule":{"requestId":"r","ruleName":"BTC drop"}}'::jsonb WHERE id=$1`,[run.id]);
 const suggestion=input(t,draft);suggestion.metadata.title='Rule suggestion';
 const result=await f.service.agentPropose(run.id,suggestion) as {ok:boolean;suggested?:boolean;proposalId?:string};
 expect(result).toMatchObject({ok:true,suggested:true});
 let view=(await f.service.read(t))!;expect(view.draft.metadata.title).toBe('Member draft');
 expect(view.suggestions).toEqual([{proposalId:result.proposalId,ruleName:'BTC drop',createdAt:expect.any(String),note:null}]);
 view=(await f.service.dismissSuggestion({targetTakeId:t,proposalId:result.proposalId!}))!;expect(view.suggestions).toEqual([]);expect(view.draft.metadata.title).toBe('Member draft');
 const again={...input(t,view),metadata:{...input(t,view).metadata,title:'Second suggestion'}};
 const second=await f.service.agentPropose(run.id,again) as {proposalId:string};expect((await f.service.read(t))!.suggestions).toHaveLength(1);
 const applied=ok(await f.service.useRevision({...action((await f.service.read(t))!),proposalId:second.proposalId}));
 expect(applied.view.draft.metadata.title).toBe('Second suggestion');expect(applied.view.suggestions).toEqual([]);
 // A chat run (someone watching) still proposes straight into the draft.
 const chat=await f.run(t);const direct=input(t,applied.view);direct.metadata.title='Chat edit';
 await f.service.agentPropose(chat.id,direct);expect((await f.service.read(t))!.draft.metadata.title).toBe('Chat edit');
});
