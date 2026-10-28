import { createHash } from 'node:crypto';
import { assertBasketExecution,assertInstrumentExecution } from '../../shared/strategies';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from '@electric-sql/pglite';
import type { DatabaseClient as PGlite } from '../database-client';
import type { createDatabaseLifecycle } from '../database';
import { fingerprint } from '../allocations/ledger';
import { commitReview } from './reallocation';
import { proposalInputSchema, proposalPayloadSchema, draftActionSchema, commitActionSchema, type ProposalInput, type ProposalPayload, type Proposal, type BasketView, type BasketSummary, type Verification, type WriteResult, type HistoryPage } from '../../shared/strategies';
import { visibleMessages, type TakeMessage } from '../../shared/takes';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Query=Pick<PGlite,'query'>;
const payloadOf=(p:ProposalPayload)=>({metadata:p.metadata,spec:p.spec,unsupportedRequests:p.unsupportedRequests});
/** Who proposes: a chat/agent run, the member, or a rule's buy/trim/exit. */
type Actor={runId:string}|{human:true}|{rule:{requestId:string;ruleId:string;ruleName:string;note:string}};
interface Target {icon_attachment_id:string|null;id:string;owner_id:string;title:string;archived_at:string|null;strategy_id:string|null;draft_revision_id:string|null;current_version_id:string|null}
export class BasketConflict extends Error {constructor(){super('The strategy changed. Review its latest draft before saving again.');}}
class CommitRefused extends Error{constructor(readonly code:'high_turnover'|'followers_below_minimum',message:string){super(message);}}
const conflict=():WriteResult=>({ok:false,conflict:true,message:new BasketConflict().message});
export async function contextMarkers(tx:Query,takeId:string):Promise<string[]>{return [...((await tx.query<{accounts:string[]}>('SELECT accounts FROM take_platform_context WHERE take_id=$1',[takeId])).rows[0]?.accounts??[])].sort();}
export async function mergeContext(tx:Query,takeId:string,markers:string[]){
 const combined=[...new Set([...await contextMarkers(tx,takeId),...markers])].sort();
 await tx.query('INSERT INTO take_platform_context(take_id,accounts) VALUES($1,$2) ON CONFLICT(take_id) DO UPDATE SET accounts=excluded.accounts',[takeId,JSON.stringify(combined)]);return combined;
}
const proposalColumns=`p.id,p.strategy_id AS "strategyId",p.revision,p.base_version_id AS "baseVersion",p.source_take_id AS "sourceTakeId",p.source_message_id AS "sourceMessageId",p.source_run_id AS "sourceRunId",p.producer,p.producer_identity AS "producerIdentity",p.previous_revision_id AS "previousRevision",p.copied_from_id AS "copiedFrom",p.verification,p.created_at::text AS "createdAt",v.id AS "acceptedVersion",p.payload`;
const present=(row:Omit<Proposal,keyof ProposalPayload>&{payload:ProposalPayload}):Proposal=>{const {payload,...fields}=row;return {...fields,...payload};};
/** The thread's recent messages for the AI, bounded so a long Take still fits one tool result:
 *  newest first within a total budget, each message cut to a limit and marked when cut. */
export function recentMessages(messages:{id:string;role:string;text:string}[],perMessage=2000,total=40000){
 const out:{id:string;role:string;text:string;truncated?:true}[]=[];let used=0;
 for(const m of messages.slice(-40).reverse()){
  const text=m.text.length>perMessage?m.text.slice(0,perMessage):m.text;
  if(used+text.length>total)break;used+=text.length;
  out.push({id:m.id,role:m.role,text,...(text.length<m.text.length?{truncated:true as const}:{})});
 }
 const omitted=Math.min(messages.length,40)-out.length;
 return {items:out.reverse(),...(omitted>0?{olderOmitted:omitted}:{})};
}
export function createStrategies(database:Database,options:{active:(run:string)=>boolean;ensure:(run:string)=>Promise<void>;verify:(spec:ProposalPayload['spec'])=>Promise<Verification>;clock?:()=>number;changed?:()=>void}){
 const now=()=>new Date(options.clock?.()??Date.now()).toISOString();
 const atomic=<T>(fn:(tx:Transaction)=>Promise<T>)=>database.use(db=>db.transaction(fn));
 async function target(tx:Query,id:string):Promise<Target>{
  const row=(await tx.query<Target>(`SELECT t.icon_attachment_id,t.id,t.owner_id,t.title,t.archived_at::text,t.strategy_id,s.draft_revision_id,s.current_version_id
   FROM takes t LEFT JOIN strategies s ON s.id=t.strategy_id WHERE t.id=$1 AND t.owner_id=(SELECT id FROM local_owners LIMIT 1)`,[z.uuid().parse(id)])).rows[0];
  if(!row)throw new Error('Target take is unavailable.');return row;
 }
 async function actor(tx:Query,who:Actor,t:Target){
  if('human' in who)return {takeId:t.id,messageId:null,runId:null,producer:'human' as const,identity:{ownerId:t.owner_id}};
  if('rule' in who)return {takeId:t.id,messageId:null,runId:null,producer:'rule' as const,identity:{rule:who.rule}};
  if(!options.active(who.runId))throw new Error('Response stopped.');
  const row=(await tx.query<{take_id:string;message_id:string;configuration:{selection:Record<string,unknown>}}>(`SELECT r.take_id,m.id AS message_id,r.configuration FROM take_runs r JOIN takes t ON t.id=r.take_id
   JOIN take_messages m ON m.take_id=r.take_id AND m.data->>'runId'=r.id::text AND m.data->>'role'='assistant'
   WHERE r.id=$1 AND r.state IN ('starting','running') AND t.owner_id=$2 AND t.archived_at IS NULL`,[z.uuid().parse(who.runId),t.owner_id])).rows[0];
  if(!row)throw new Error('Live authoring run unavailable.');
  return {takeId:row.take_id,messageId:row.message_id,runId:who.runId,producer:'agent' as const,identity:{...row.configuration.selection}};
 }
 type ProposalRow=Omit<Proposal,keyof ProposalPayload>&{payload:ProposalPayload};
 type VersionRow=BasketView['versions'][number];
 function presentView(t:Target,rows:ProposalRow[],versions:VersionRow[],suggestions?:BasketView['suggestions']):BasketView|null {
  if(!t.strategy_id||!t.draft_revision_id)return null;
  const draftRow=rows.find(p=>p.id===t.draft_revision_id);if(!draftRow)throw new Error('Draft history is unavailable.');
  const draft=present(draftRow);
  return {suggestions,iconId:t.icon_attachment_id,strategyId:t.strategy_id,targetTakeId:t.id,title:draft.metadata.title,archivedAt:t.archived_at,currentVersion:t.current_version_id,draft,clean:draft.acceptedVersion===t.current_version_id&&t.current_version_id!==null,proposals:rows.slice(0,200).map(present),versions:versions.slice(0,200),historyTruncated:rows.length>200||versions.length>200};
 }
 async function view(tx:Query,t:Target):Promise<BasketView|null>{
  if(!t.strategy_id||!t.draft_revision_id)return null;
  const rows=(await tx.query<ProposalRow>(`SELECT ${proposalColumns} FROM strategy_proposals p LEFT JOIN strategy_versions v ON v.source_proposal_id=p.id
   WHERE p.strategy_id=$1 ORDER BY p.revision DESC LIMIT 201`,[t.strategy_id])).rows;
  const versions=(await tx.query<VersionRow>(`SELECT v.id,v.sequence,v.source_proposal_id AS "proposalId",p.payload,v.verification,v.created_at::text AS "createdAt",v.provenance->>'acceptedBy' AS "acceptedBy"
   FROM strategy_versions v JOIN strategy_proposals p ON p.id=v.source_proposal_id WHERE v.strategy_id=$1 ORDER BY v.sequence DESC LIMIT 201`,[t.strategy_id])).rows;
  // Take changes automatic rule runs suggested, not yet applied or dismissed, on this version.
  // A rule's buy/trim/exit is a suggestion too, with a note on what keeps the new target.
  const suggestions=(await tx.query<{proposalId:string;ruleName:string|null;createdAt:string;note?:string}>(`SELECT p.id AS "proposalId",coalesce(r.configuration->'rule'->>'ruleName',p.producer_identity->'rule'->>'ruleName') AS "ruleName",to_json(p.created_at)#>>'{}' AS "createdAt",p.producer_identity->'rule'->>'note' AS note
   FROM strategy_proposals p LEFT JOIN take_runs r ON r.id=p.source_run_id
   WHERE p.strategy_id=$1 AND NOT EXISTS(SELECT 1 FROM strategy_suggestion_dismissals d WHERE d.proposal_id=p.id) AND (coalesce((r.configuration->>'unattended')::boolean,false) OR p.producer_identity ? 'rule') AND p.base_version_id IS NOT DISTINCT FROM $2 AND p.id<>$3
    AND NOT EXISTS(SELECT 1 FROM strategy_proposals c WHERE c.strategy_id=p.strategy_id AND c.copied_from_id=p.id) ORDER BY p.created_at DESC LIMIT 5`,[t.strategy_id,t.current_version_id,t.draft_revision_id])).rows;
  return presentView(t,rows,versions,suggestions);
 }
 /** Same bounded histories as read(), fetched in three queries for an overview. */
 async function readMany(takeIds:string[]):Promise<Record<string,BasketView|null>> {
  const ids=z.array(z.uuid()).parse(takeIds);
  if(!ids.length)return {};
  return atomic(async tx=>{
   const targets=(await tx.query<Target>(`SELECT t.icon_attachment_id,t.id,t.owner_id,t.title,t.archived_at::text,t.strategy_id,s.draft_revision_id,s.current_version_id
    FROM takes t LEFT JOIN strategies s ON s.id=t.strategy_id WHERE t.id=ANY($1::uuid[]) AND t.owner_id=(SELECT id FROM local_owners LIMIT 1)`,[ids])).rows;
   const strategies=[...new Set(targets.flatMap(t=>t.strategy_id&&t.draft_revision_id?[t.strategy_id]:[]))];
   const proposals=(await tx.query<ProposalRow>(`SELECT q.* FROM unnest($1::uuid[]) AS ids(id) CROSS JOIN LATERAL (
    SELECT ${proposalColumns} FROM strategy_proposals p LEFT JOIN strategy_versions v ON v.source_proposal_id=p.id
    WHERE p.strategy_id=ids.id ORDER BY p.revision DESC LIMIT 201) q ORDER BY q."strategyId",q.revision DESC`,[strategies])).rows;
   const versions=(await tx.query<VersionRow & {strategyId:string}>(`SELECT q.* FROM unnest($1::uuid[]) AS ids(id) CROSS JOIN LATERAL (
    SELECT v.strategy_id AS "strategyId",v.id,v.sequence,v.source_proposal_id AS "proposalId",p.payload,v.verification,v.created_at::text AS "createdAt",v.provenance->>'acceptedBy' AS "acceptedBy"
    FROM strategy_versions v JOIN strategy_proposals p ON p.id=v.source_proposal_id WHERE v.strategy_id=ids.id ORDER BY v.sequence DESC LIMIT 201) q ORDER BY q."strategyId",q.sequence DESC`,[strategies])).rows;
   // Unapplied rule suggestions per Take, as read() shows them (the same filters, five newest each).
   const live=targets.filter(t=>t.strategy_id&&t.draft_revision_id);
   const suggestionRows=(await tx.query<{takeId:string;sortAt:Date;proposalId:string;ruleName:string|null;createdAt:string;note?:string}>(`SELECT q.* FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::uuid[]) AS ids(take_id,strategy_id,version_id,draft_id) CROSS JOIN LATERAL (
    SELECT ids.take_id AS "takeId",p.created_at AS "sortAt",p.id AS "proposalId",coalesce(r.configuration->'rule'->>'ruleName',p.producer_identity->'rule'->>'ruleName') AS "ruleName",to_json(p.created_at)#>>'{}' AS "createdAt",p.producer_identity->'rule'->>'note' AS note
    FROM strategy_proposals p LEFT JOIN take_runs r ON r.id=p.source_run_id
    WHERE p.strategy_id=ids.strategy_id AND NOT EXISTS(SELECT 1 FROM strategy_suggestion_dismissals d WHERE d.proposal_id=p.id) AND (coalesce((r.configuration->>'unattended')::boolean,false) OR p.producer_identity ? 'rule') AND p.base_version_id IS NOT DISTINCT FROM ids.version_id AND p.id<>ids.draft_id
     AND NOT EXISTS(SELECT 1 FROM strategy_proposals c WHERE c.strategy_id=p.strategy_id AND c.copied_from_id=p.id) ORDER BY p.created_at DESC LIMIT 5) q ORDER BY q."takeId",q."sortAt" DESC`,
    [live.map(t=>t.id),live.map(t=>t.strategy_id),live.map(t=>t.current_version_id),live.map(t=>t.draft_revision_id)])).rows;
   const suggestionsByTake=new Map<string,NonNullable<BasketView['suggestions']>>();
   for(const {takeId,sortAt:_,...row} of suggestionRows){const group=suggestionsByTake.get(takeId)??[];group.push(row);suggestionsByTake.set(takeId,group);}
   const proposalsByStrategy=new Map<string,ProposalRow[]>(),versionsByStrategy=new Map<string,VersionRow[]>();
   for(const row of proposals){const group=proposalsByStrategy.get(row.strategyId)??[];group.push(row);proposalsByStrategy.set(row.strategyId,group);}
   for(const {strategyId,...row} of versions){const group=versionsByStrategy.get(strategyId)??[];group.push(row);versionsByStrategy.set(strategyId,group);}
   const result:Record<string,BasketView|null>=Object.fromEntries(ids.map(id=>[id,null]));
   for(const target of targets){
    // The overview previously caught unavailable detail rows independently.
    try{result[target.id]=presentView(target,proposalsByStrategy.get(target.strategy_id??'')??[],versionsByStrategy.get(target.strategy_id??'')??[],suggestionsByTake.get(target.id)??[]);}catch{result[target.id]=null;}
   }
   return result;
  });
 }
 const read=(id:string)=>atomic(async tx=>view(tx,await target(tx,id)));
 async function currentRunTarget(runId:string){
  const id=(await database.use(db=>db.query<{take_id:string}>('SELECT take_id FROM take_runs WHERE id=$1',[z.uuid().parse(runId)]))).rows[0]?.take_id;
  if(!id||!options.active(runId))throw new Error('Response stopped.');return id;
 }
 /** `suggest`: an automatic rule run's proposal is saved without becoming the draft. */
 async function propose(input:unknown,who:Actor,copiedFrom?:string,suggest=false):Promise<WriteResult>{
  const parsed=proposalInputSchema.parse(input),targetId=parsed.targetTakeId??('runId' in who?await currentRunTarget(who.runId):null);
  if(!targetId)throw new Error('Choose a target take.');
  const hash=fingerprint({...parsed,targetTakeId:targetId,actor:'runId' in who?who.runId:'rule' in who?`rule:${who.rule.requestId}`:'human',copiedFrom:copiedFrom??null});
  // Validate identity/CAS before contacting the provider; recheck after it returns.
  const early=await atomic(async tx=>{
   const t=await target(tx,targetId);await actor(tx,who,t);
   const old=(await tx.query<{id:string;request_hash:string;target_take_id:string}>('SELECT id,request_hash,target_take_id FROM strategy_proposals WHERE owner_id=$1 AND operation_id=$2',[t.owner_id,parsed.operationId])).rows[0];
   if(old){if(old.request_hash!==hash)throw new Error('This operation ID already names a different edit.');return {ok:true as const,view:(await view(tx,t))!,proposalId:old.id};}
   if(t.archived_at)throw new Error('Restore this take before editing it.');
   if(t.draft_revision_id!==parsed.expectedRevision||t.current_version_id!==parsed.expectedVersion)throw new BasketConflict();return null;
  });if(early)return early;
  const payload=proposalPayloadSchema.parse(payloadOf(parsed)),verification=await options.verify(payload.spec);
  return atomic(async tx=>{
   const t=await target(tx,targetId),source=await actor(tx,who,t);
   const old=(await tx.query<{id:string;request_hash:string}>('SELECT id,request_hash FROM strategy_proposals WHERE owner_id=$1 AND operation_id=$2',[t.owner_id,parsed.operationId])).rows[0];
   if(old){if(old.request_hash!==hash)throw new Error('This operation ID already names a different edit.');return {ok:true,view:(await view(tx,t))!,proposalId:old.id};}
   if(t.archived_at)throw new Error('Restore this take before editing it.');
   if(t.draft_revision_id!==parsed.expectedRevision||t.current_version_id!==parsed.expectedVersion)throw new BasketConflict();
   const strategyId=t.strategy_id??randomUUID();
   if(!t.strategy_id){await tx.query('INSERT INTO strategies(id,owner_id) VALUES($1,$2)',[strategyId,t.owner_id]);await tx.query('UPDATE takes SET strategy_id=$2 WHERE id=$1',[t.id,strategyId]);}
   const id=randomUUID();
   const markers=await mergeContext(tx,t.id,[...await contextMarkers(tx,source.takeId),...(verification.accountRef?['robinhood:'+verification.accountRef]:[])]);
   await tx.query(`INSERT INTO strategy_proposals(id,strategy_id,owner_id,target_take_id,source_take_id,source_message_id,source_run_id,revision,base_version_id,previous_revision_id,producer,producer_identity,payload,platform_context,verification,operation_id,request_hash,created_at,copied_from_id)
    SELECT $1,$2,$3,$4,$5,$6,$7,coalesce(max(revision),0)+1,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18 FROM strategy_proposals WHERE strategy_id=$2`,
    [id,strategyId,t.owner_id,t.id,source.takeId,source.messageId,source.runId,t.current_version_id,t.draft_revision_id,source.producer,JSON.stringify(source.identity),JSON.stringify(payload),JSON.stringify(markers),JSON.stringify(verification),parsed.operationId,hash,now(),copiedFrom??null]);
   if(!suggest){
    await tx.query('UPDATE strategies SET draft_revision_id=$2,updated_at=now() WHERE id=$1',[strategyId,id]);
    await tx.query("UPDATE takes SET updated_at=now(),title=CASE WHEN title='New Take' THEN $2 ELSE title END WHERE id=$1",[t.id,payload.metadata.title]);
   }
   await actor(tx,who,t);return {ok:true,view:(await view(tx,await target(tx,t.id)))!,proposalId:id};
  });
 }
 async function agentRead(runId:string,targetId?:string){
  const sourceId=await currentRunTarget(runId),id=targetId??sourceId;
  // Capture content and propagate its markers atomically. Verification must occur
  // before anything is returned to the model, including a conflict's latest draft.
  for(let retry=0;retry<3;retry++){
   const captured=await atomic(async tx=>{
    const t=await target(tx,id);await actor(tx,{runId},t);
    const markers=await mergeContext(tx,sourceId,await contextMarkers(tx,t.id));
    const messages=(await tx.query<{data:TakeMessage}>('SELECT data FROM take_messages WHERE take_id=$1 ORDER BY sequence',[id])).rows.map(r=>r.data);
    const head=(await tx.query<{head_id:string|null}>('SELECT head_id FROM takes WHERE id=$1',[id])).rows[0].head_id;
    const basket=await view(tx,t);
    return {markers,revision:t.draft_revision_id,version:t.current_version_id,head,data:{targetTakeId:id,title:t.title,basket:basket?{...basket,proposals:[],versions:basket.versions.filter(v=>v.id===basket.currentVersion)}:null,messages:recentMessages(visibleMessages({headId:head,messages} as Parameters<typeof visibleMessages>[0]))}};
   });
   await options.ensure(runId);
   const unchanged=await atomic(async tx=>{
    const t=await target(tx,id);await actor(tx,{runId},t);
    const head=(await tx.query<{head_id:string|null}>('SELECT head_id FROM takes WHERE id=$1',[id])).rows[0].head_id;
    const targetContext=await contextMarkers(tx,id),sourceContext=await contextMarkers(tx,sourceId);
    return t.draft_revision_id===captured.revision&&t.current_version_id===captured.version&&head===captured.head
     &&targetContext.every(m=>captured.markers.includes(m))&&fingerprint(sourceContext)===fingerprint(captured.markers)&&options.active(runId);
   });
   if(unchanged)return captured.data;
  }
  throw new Error('Context changed during verification. Retry the read.');
 }
 return {
  read,readMany,agentRead,
  async source(proposalId:string){z.uuid().parse(proposalId);return database.use(async db=>(await db.query<{messageId:string;takeId:string;text:string}>(`SELECT m.id AS "messageId",m.take_id AS "takeId",m.data->>'text' AS text FROM strategy_proposals p JOIN take_messages m ON m.id=p.source_message_id WHERE p.id=$1 AND p.owner_id=(SELECT id FROM local_owners LIMIT 1)`,[proposalId])).rows[0]??null);},
  async history(id:string,beforeRevision:number):Promise<HistoryPage>{return atomic(async tx=>{
   const t=await target(tx,id);z.number().int().positive().parse(beforeRevision);
   const rows=(await tx.query<Omit<Proposal,keyof ProposalPayload>&{payload:ProposalPayload}>(`SELECT ${proposalColumns} FROM strategy_proposals p LEFT JOIN strategy_versions v ON v.source_proposal_id=p.id WHERE p.strategy_id=$1 AND p.revision<$2 ORDER BY p.revision DESC LIMIT 51`,[t.strategy_id,beforeRevision])).rows;
   const proposals=rows.slice(0,50).map(present);
   const versions=(await tx.query<HistoryPage['versions'][number]>(`SELECT v.id,v.sequence,v.source_proposal_id AS "proposalId",p.payload,v.verification,v.created_at::text AS "createdAt",v.provenance->>'acceptedBy' AS "acceptedBy" FROM strategy_versions v JOIN strategy_proposals p ON p.id=v.source_proposal_id WHERE v.strategy_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY v.sequence DESC`,[t.strategy_id,proposals.map(p=>p.id)])).rows;
   return {proposals,versions,nextRevision:rows.length>50?proposals.at(-1)!.revision:null};
  });},
  async list(archived=false):Promise<BasketSummary[]>{return database.use(async db=>(await db.query<BasketSummary>(`SELECT s.id AS "strategyId",t.id AS "targetTakeId",p.payload->'metadata'->>'title' AS title,s.status,
   (v.source_proposal_id IS DISTINCT FROM s.draft_revision_id) AS dirty,s.archived_at::text AS "archivedAt" FROM strategies s JOIN takes t ON t.strategy_id=s.id
   JOIN strategy_proposals p ON p.id=s.draft_revision_id LEFT JOIN strategy_versions v ON v.id=s.current_version_id WHERE s.owner_id=(SELECT id FROM local_owners LIMIT 1) AND (s.archived_at IS NOT NULL)=$1 ORDER BY s.updated_at DESC`,[z.boolean().parse(archived)])).rows);},
  async propose(input:unknown){try{const result=await propose(input,{human:true});options.changed?.();return result;}catch(e){if(e instanceof BasketConflict)return conflict();throw e;}},
  /** `call.suggest`: the member asks before chat changes their draft, so an existing draft is left as it is. */
  async agentPropose(runId:string,input:unknown,call?:{suggest?:boolean}){
   try{
    // An automatic rule run (no one watching) suggests; the member's draft stays as it is.
    const unattended=!!(await database.use(db=>db.query<{unattended:boolean}>("SELECT coalesce((configuration->>'unattended')::boolean,false) AS unattended FROM take_runs WHERE id=$1",[runId]))).rows[0]?.unattended;
    // A take with no draft yet has nothing to keep, so its first proposal becomes the draft.
    const chatSuggestion=!unattended&&!!call?.suggest&&proposalInputSchema.parse(input).expectedRevision!==null;
    const result=await propose(input,{runId},undefined,unattended||chatSuggestion);if(!result.ok)return result;
    if(unattended)return {ok:true,proposalId:result.proposalId,suggested:true,note:'Saved as a suggestion for the member to review; the Take and its draft are unchanged until they apply it.'};
    if(chatSuggestion){options.changed?.();return {ok:true,proposalId:result.proposalId,suggested:true,note:'Saved as a suggestion on this reply. The member asked to review changes first, so their draft is unchanged until they apply it from the proposal card. Say so; do not say the draft was updated.'};}
    // Verification may introduce account context. Apply the same gate on response.
    options.changed?.();return {ok:true,proposalId:result.proposalId,...await agentRead(runId,result.view.targetTakeId)};
   }catch(e){if(e instanceof BasketConflict){const parsed=proposalInputSchema.parse(input);return {...conflict(),current:await agentRead(runId,parsed.targetTakeId)};}throw e;}
  },
  /** A rule's buy/trim/exit: a suggestion built from the committed version, never
   *  the draft. `change` returns the new spec or why there is none. Idempotent per firing. */
  async ruleSuggest(input:{takeId:string;rule:{requestId:string;ruleId:string;ruleName:string};change:(spec:ProposalPayload['spec'])=>{spec:ProposalPayload['spec'];note:string}|{reason:string}}){
   const t=await atomic(tx=>target(tx,input.takeId));
   if(!t.strategy_id||!t.current_version_id)return {ok:false as const,reason:'take_not_committed'};
   const committed=(await database.use(db=>db.query<{payload:ProposalPayload}>('SELECT p.payload FROM strategy_versions v JOIN strategy_proposals p ON p.id=v.source_proposal_id WHERE v.id=$1',[t.current_version_id]))).rows[0];
   if(!committed)return {ok:false as const,reason:'take_not_committed'};
   const base=proposalPayloadSchema.parse(committed.payload),made=input.change(base.spec);
   if('reason' in made)return {ok:false as const,reason:made.reason};
   const h=createHash('sha256').update(`rule-target:${input.rule.requestId}`).digest('hex');
   const operationId=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
   const result=await propose({targetTakeId:t.id,expectedRevision:t.draft_revision_id,expectedVersion:t.current_version_id,operationId,metadata:base.metadata,spec:made.spec,unsupportedRequests:[]},{rule:{...input.rule,note:made.note}},undefined,true);
   options.changed?.();
   return result.ok?{ok:true as const,proposalId:result.proposalId!}:{ok:false as const,reason:'take_changed'};
  },
  /** The member dismisses a rule's suggested Take change; it stays in history. */
  async dismissSuggestion(raw:unknown){const input=z.object({targetTakeId:z.uuid(),proposalId:z.uuid()}).strict().parse(raw);
   return atomic(async tx=>{const t=await target(tx,input.targetTakeId);
    await tx.query('INSERT INTO strategy_suggestion_dismissals(proposal_id) SELECT id FROM strategy_proposals WHERE id=$1 AND strategy_id=$2 ON CONFLICT DO NOTHING',[input.proposalId,t.strategy_id]);
    return view(tx,await target(tx,t.id));});},
  async useRevision(input:unknown):Promise<WriteResult>{
   const request=draftActionSchema.extend({proposalId:z.uuid()}).parse(input);
   const p=await atomic(async tx=>{const t=await target(tx,request.targetTakeId);const p=(await tx.query<{payload:ProposalPayload}>('SELECT payload FROM strategy_proposals WHERE id=$1 AND strategy_id=$2',[request.proposalId,t.strategy_id])).rows[0];if(!p)throw new Error('Revision unavailable.');return p.payload;});
   const {proposalId,...action}=request;
   try{const result=await propose({...p,...action},{human:true},proposalId);options.changed?.();return result;}catch(e){if(e instanceof BasketConflict)return conflict();throw e;}
  },
  async commit(input:unknown):Promise<WriteResult>{
   const {acceptHighTurnover,acceptStranded,...request}=commitActionSchema.parse(input),hash=fingerprint(request);
   const captured=await atomic(async tx=>{
    const t=await target(tx,request.targetTakeId);
    const existing=(await tx.query<{request_hash:string;version_id:string}>('SELECT request_hash,version_id FROM strategy_commit_operations WHERE owner_id=$1 AND operation_id=$2',[t.owner_id,request.operationId])).rows[0];
    if(existing){if(existing.request_hash!==hash)throw new Error('Operation ID already used.');return {done:true as const,t,versionId:existing.version_id};}
    if(t.archived_at)throw new Error('Restore this take before committing.');
    if(t.draft_revision_id!==request.expectedRevision||t.current_version_id!==request.expectedVersion)throw new BasketConflict();
    const v=(await view(tx,t))!;return {done:false as const,t,v};
   }).catch(e=>{if(e instanceof BasketConflict)return null;throw e;});if(!captured)return conflict();
   if(captured.done)return {ok:true,view:(await read(request.targetTakeId))!,committedVersion:captured.versionId};
   const payload=proposalPayloadSchema.parse(payloadOf(captured.v.draft)),verification=await options.verify(payload.spec);
   try{return await atomic(async tx=>{
    const t=await target(tx,request.targetTakeId);
    const old=(await tx.query<{version_id:string;request_hash:string}>('SELECT version_id,request_hash FROM strategy_commit_operations WHERE owner_id=$1 AND operation_id=$2',[t.owner_id,request.operationId])).rows[0];
    if(old){if(old.request_hash!==hash)throw new Error('Operation ID already used.');return {ok:true,view:(await view(tx,t))!,committedVersion:old.version_id};}
    if(t.archived_at)throw new Error('Restore this take before committing.');
    if(t.draft_revision_id!==request.expectedRevision||t.current_version_id!==request.expectedVersion)throw new BasketConflict();
    const current=(await view(tx,t))!;let versionId=t.current_version_id;
    if(!current.clean){
     if((await tx.query("SELECT 1 FROM strategy_allocations WHERE strategy_id=$1 AND status IN ('active','paused','diverged') UNION ALL SELECT 1 FROM coinbase_allocations WHERE strategy_id=$1 LIMIT 1",[t.strategy_id])).rows.length)assertInstrumentExecution(payload.spec);
     // An existing funded basket must not switch to a venue its execution engine cannot route.
     if ((await tx.query("SELECT 1 FROM strategy_allocations WHERE strategy_id=$1 AND status IN ('active','paused','diverged') LIMIT 1", [t.strategy_id])).rows.length) {
      const mixed=(await tx.query('SELECT 1 FROM mixed_take_executions WHERE take_id=$1 LIMIT 1',[request.targetTakeId])).rows.length>0;
      if(mixed){const venues=new Set(payload.spec.target.weights.map(w=>w.instrument.venue));const routes=(await tx.query<{venue:string}>('SELECT venue FROM strategy_account_routes WHERE strategy_id=$1',[t.strategy_id])).rows;if(venues.size!==routes.length||routes.some(r=>!venues.has(r.venue)))throw Error('Close the funded accounts before changing platforms in this Take.');}
      else assertBasketExecution(payload.spec);
     }
     // Hosted's publish guards: the money in this take is rebalanced to what is committed.
     const review=await commitReview(tx,t.strategy_id!,t.current_version_id,payload.spec);
     if(review.belowMinimum>0&&acceptStranded!==true)throw new CommitRefused('followers_below_minimum',
      `${review.belowMinimum} investment${review.belowMinimum===1?'':'s'} could not hold every holding at these weights, the smallest being $${review.smallestValueUsd}. `
      +(review.weightThatFitsPercent===null?'No weight would fit the smallest of them.':`The smallest holding would have to be at least ${review.weightThatFitsPercent}% for all of them to fit.`));
     if(review.highTurnover&&acceptHighTurnover!==true)throw new CommitRefused('high_turnover',
      `This replaces ${review.turnoverPercent}% of what your investment holds, so most of it is sold and rebought. Those sales are taxable. Commit again accepting that, or change less at a time.`);
     versionId=randomUUID();const p=current.draft;
     await tx.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification,source_proposal_id,created_at)
      SELECT $1,$2,$3,coalesce(max(sequence),0)+1,1,$4,$5,$6,$7,$8,$9 FROM strategy_versions WHERE strategy_id=$2`,
      [versionId,t.strategy_id,t.owner_id,JSON.stringify(payload.metadata),JSON.stringify(payload.spec),JSON.stringify({producer:p.producer,producerIdentity:p.producerIdentity,acceptedBy:t.owner_id,originTakeId:t.id,sourceTakeId:p.sourceTakeId,sourceMessageId:p.sourceMessageId,sourceRunId:p.sourceRunId,unsupportedRequests:payload.unsupportedRequests}),JSON.stringify(verification),p.id,now()]);
     await tx.query("UPDATE strategies SET status='committed',current_version_id=$2,updated_at=now() WHERE id=$1",[t.strategy_id,versionId]);
     if(verification.accountRef)await mergeContext(tx,t.id,['robinhood:'+verification.accountRef]);
    }
    await tx.query('INSERT INTO strategy_commit_operations(owner_id,operation_id,request_hash,version_id) VALUES($1,$2,$3,$4)',[t.owner_id,request.operationId,hash,versionId]);
    return {ok:true,view:(await view(tx,await target(tx,t.id)))!,committedVersion:versionId!};
   });}catch(e){if(e instanceof BasketConflict)return conflict();if(e instanceof CommitRefused)return {ok:false,conflict:false,code:e.code,message:e.message};throw e;}
  },
  /** What committing the current draft would do to the money in this take; null without a draft. */
  async commitReview(targetTakeId:string){
   return atomic(async tx=>{const t=await target(tx,targetTakeId);const v=await view(tx,t);if(!v||!t.strategy_id)return null;return commitReview(tx,t.strategy_id,t.current_version_id,proposalPayloadSchema.parse(payloadOf(v.draft)).spec);});
  },
  async verify(targetTakeId:string){const v=await read(targetTakeId);if(!v)throw new Error('Create a take draft first.');const result=await options.verify(v.draft.spec);if(result.accountRef)await atomic(tx=>mergeContext(tx,targetTakeId,['robinhood:'+result.accountRef!]).then(()=>undefined));return result;},
  async messageProposals(id:string){z.uuid().parse(id);return database.use(async db=>(await db.query<Omit<Proposal,keyof ProposalPayload>&{payload:ProposalPayload;targetTakeId:string}>(`SELECT ${proposalColumns},p.target_take_id AS "targetTakeId" FROM strategy_proposals p LEFT JOIN strategy_versions v ON v.source_proposal_id=p.id WHERE p.source_message_id=$1 AND p.owner_id=(SELECT id FROM local_owners LIMIT 1) ORDER BY p.revision`,[id])).rows.map(row=>({proposal:present(row),targetTakeId:row.targetTakeId})));},
 };
}
