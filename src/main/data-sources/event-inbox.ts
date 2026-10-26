import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseClient} from '../database-client';
import type {DataObservation,DataFeedRef} from '../../shared/data-sources';
import type {RuleEventBatch} from './rule-events';
type Query=Pick<DatabaseClient,'query'>;
type Target={take_id:string;revision:number;rule_id:string};
export const ruleEventInboxCap=10000;
/** Pending-count cache for one storage transaction; the owner lock serializes writers. */
export type InboxCounts=Map<string,number>;
async function targets(tx:Query,owner:string,ref:Pick<DataFeedRef,'sourceId'|'feedId'|'configVersion'>,receivedAt:number){
 return (await tx.query<Target>(`SELECT t.id AS take_id,d.revision,rule->>'id' AS rule_id
 FROM takes t JOIN strategies s ON s.id=t.strategy_id AND s.owner_id=t.owner_id
 JOIN strategy_rule_shadow e ON e.take_id=t.id AND e.enabled
 JOIN strategy_rule_accepted a ON a.take_id=t.id AND a.revision=e.draft_revision
 JOIN strategy_rule_draft_revisions d ON d.take_id=t.id AND d.revision=a.revision AND d.accepted_version=s.current_version_id
 JOIN LATERAL (SELECT * FROM take_input_revisions WHERE take_id=t.id ORDER BY revision DESC LIMIT 1) i ON i.revision=d.input_revision AND i.accepted_version=s.current_version_id
 CROSS JOIN LATERAL jsonb_array_elements(d.config->'rules') rule
 CROSS JOIN LATERAL jsonb_array_elements(i.config->'inputs') binding
 WHERE t.owner_id=$1 AND t.archived_at IS NULL AND s.archived_at IS NULL
 AND e.updated_at<=$5 AND NOT (rule->>'id')::uuid=ANY(a.disabled_rule_ids)
 AND rule->'trigger'->>'kind'='event' AND rule->'trigger'->>'input'=binding->>'key'
 AND binding->>'sourceId'=$2 AND binding->>'sourceRevision'=$3 AND binding->>'feedId'=$4`,[owner,ref.sourceId,String(ref.configVersion),ref.feedId,new Date(receivedAt)])).rows;
}
/** Consecutive drops share one marker; markers bypass the cap and are read in inbox order as a gap.
 * Only the rule's newest pending row, visible to the current enrollment, is extended: a drop after a
 * real event or a re-enrollment gets its own marker at its own position. */
async function mark(tx:Query,target:Target,kind:'overflow'|'gap',receivedAt:number){
 const updated=await tx.query(`UPDATE strategy_rule_event_inbox q SET observation=jsonb_set(q.observation,'{marker,dropped}',to_jsonb(least((q.observation->'marker'->>'dropped')::int+1,1000000000)))
 WHERE q.id=(SELECT p.id FROM strategy_rule_event_inbox p WHERE p.take_id=$1 AND p.draft_revision=$2 AND p.rule_id=$3 AND p.handled_at IS NULL ORDER BY p.id DESC LIMIT 1)
 AND q.receipt LIKE $4 AND EXISTS(SELECT 1 FROM strategy_rule_shadow e WHERE e.take_id=q.take_id AND e.enabled AND e.draft_revision=q.draft_revision AND e.updated_at<=q.received_at) RETURNING q.id`,[target.take_id,target.revision,target.rule_id,`${kind}:%`]);
 if(updated.rows.length)return;
 await tx.query(`INSERT INTO strategy_rule_event_inbox(take_id,draft_revision,rule_id,receipt,observation,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[target.take_id,target.revision,target.rule_id,`${kind}:${randomUUID()}`,JSON.stringify({marker:{kind,dropped:1}}),new Date(receivedAt)]);
}
async function pending(tx:Query,takeId:string,counts?:InboxCounts){
 const cached=counts?.get(takeId);if(cached!==undefined)return cached;
 const count=(await tx.query<{count:number}>(`SELECT count(*)::int AS count FROM strategy_rule_event_inbox WHERE take_id=$1 AND handled_at IS NULL AND receipt NOT LIKE '%:%'`,[takeId])).rows[0].count;
 counts?.set(takeId,count);return count;
}
/** Journal only events needed by accepted, enabled rules. Never promotes sampled metadata to events.
 * Never throws for capacity: shared observation storage must still commit. */
export async function journalRuleEvent(tx:Query,owner:string,o:DataObservation,counts?:InboxCounts){
 if(o.payload.kind!=='event'||o.origin!=='live')return;
 const found=await targets(tx,owner,o,o.receivedAt);
 const receipt=createHash('sha256').update(JSON.stringify(o)).digest('hex');
 for(const target of found){
  const count=await pending(tx,target.take_id,counts);
  if(count>=ruleEventInboxCap){await mark(tx,target,'overflow',o.receivedAt);continue;}
  const inserted=await tx.query(`INSERT INTO strategy_rule_event_inbox(take_id,draft_revision,rule_id,receipt,observation,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,[target.take_id,target.revision,target.rule_id,receipt,JSON.stringify(o),new Date(o.receivedAt)]);
  if(inserted.rows.length)counts?.set(target.take_id,count+1);
 }
}
/** Storage dropped or quarantined a live event: affected rules must report event_gap. */
export async function journalRuleEventGap(tx:Query,owner:string,ref:Pick<DataFeedRef,'sourceId'|'feedId'|'configVersion'>,receivedAt:number){
 for(const target of await targets(tx,owner,ref,receivedAt))await mark(tx,target,'gap',receivedAt);
}
type Row={id:string;receipt:string;received_at:Date;observation:DataObservation|{marker:{kind:'overflow'|'gap';dropped:number}}};
export async function readRuleEventInbox(db:Query,takeId:string,revision:number,ruleId:string):Promise<RuleEventBatch&{verify(tx:Query):Promise<boolean>}>{
 const read=(await db.query<Row>(`SELECT q.id,q.receipt,q.received_at,q.observation FROM strategy_rule_event_inbox q JOIN strategy_rule_shadow e ON e.take_id=q.take_id AND e.enabled AND e.draft_revision=q.draft_revision WHERE q.take_id=$1 AND q.draft_revision=$2 AND q.rule_id=$3 AND q.handled_at IS NULL AND q.received_at>=e.updated_at ORDER BY q.id LIMIT 8`,[takeId,revision,ruleId])).rows;
 // A marker is reported alone, in order: events before it are evaluated first.
 const index=read.findIndex(row=>'marker' in row.observation);
 const rows=index===0?read.slice(0,1):index>0?read.slice(0,index):read;
 const marker=index===0?(read[0].observation as {marker:{kind:'overflow'|'gap'}}).marker:null;
 const outcomes=new Map<DataObservation,string>();
 const observations=marker?[]:rows.map(row=>row.observation as DataObservation),latest=observations.at(-1)??null;
 const issue=marker?(marker.kind==='overflow'?'capacity' as const:'gap' as const):null;
 return {durable:true,record:(o,reason)=>{outcomes.set(o,reason);},gap:!!marker,observations,snapshot:{quality:marker?'gap':latest?'fresh':'missing',connection:'live',latest,issue,lastReceivedAt:latest?.receivedAt??null},valid:()=>true,ack:()=>true,
  // Re-checked under the enrollment row lock: a concurrent re-enrollment excludes these rows.
  async verify(tx){if(!rows.length)return true;const min=new Date(Math.min(...rows.map(row=>row.received_at.getTime())));return (await tx.query('SELECT 1 FROM strategy_rule_shadow WHERE take_id=$1 AND enabled AND draft_revision=$2 AND updated_at<=$3',[takeId,revision,min])).rows.length>0;},
  async commit(tx){for(const row of rows)await tx.query('UPDATE strategy_rule_event_inbox SET handled_at=now(),outcome=$2 WHERE id=$1 AND handled_at IS NULL',[row.id,marker?(marker.kind==='overflow'?'event_overflow':'event_gap'):outcomes.get(row.observation as DataObservation)??'not_evaluated']);}};
}
