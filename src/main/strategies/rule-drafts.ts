import {takeInputFeed} from '../data-sources/input-feed';
import {savedSourceConfig} from '../data-sources/saved-config';
import {z} from 'zod';
import {ruleDraftConfig,ruleDraftSave,type RuleDraftSetting} from '../../shared/strategy-rules';
import {takeInputsConfigSchema,type TakeInputsConfig,type TakeInputSnapshot} from '../../shared/take-inputs';
import type {createDatabaseLifecycle} from '../database';
import type {DatabaseClient} from '../database-client';
type Query=Pick<DatabaseClient,'query'>;
/** Drafts only. Saving neither accepts a strategy change nor grants any execution capability. */
export function createRuleDrafts(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,snapshot:(takeId:string)=>Promise<TakeInputSnapshot>){
 async function target(tx:Query,id:string){
  const row=(await tx.query<{current_version_id:string}>(`SELECT s.current_version_id FROM takes t JOIN strategies s ON s.id=t.strategy_id AND s.owner_id=t.owner_id
   WHERE t.id=$1 AND t.owner_id=(SELECT id FROM local_owners LIMIT 1) AND t.archived_at IS NULL AND s.archived_at IS NULL AND s.current_version_id IS NOT NULL FOR UPDATE OF t,s`,[id])).rows[0];
  if(!row)throw Error('Choose an active Take with an accepted version');return row.current_version_id;
 }
 async function inputs(tx:Query,id:string){
  const row=(await tx.query<{revision:number;accepted_version:string;config:unknown}>('SELECT revision,accepted_version,config FROM take_input_revisions WHERE take_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0];
  return {revision:row?.revision??0,version:row?.accepted_version,config:row?takeInputsConfigSchema.parse(row.config):{inputs:[],maxSkewMs:5000}};
 }
 async function load(tx:Query,id:string,version:string,inputRevision:number):Promise<RuleDraftSetting>{
  const row=(await tx.query<{revision:number;accepted_version:string;input_revision:number;config:unknown}>('SELECT revision,accepted_version,input_revision,config FROM strategy_rule_draft_revisions WHERE take_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0];
  return {takeId:id,revision:row?.revision??0,acceptedVersion:row?.accepted_version??version,inputRevision:row?.input_revision??inputRevision,config:row?ruleDraftConfig.parse(row.config):{schemaVersion:1,rules:[]}};
 }

 return {
  load(raw:unknown){const id=z.uuid().parse(raw);return database.use(db=>db.transaction(async tx=>{const version=await target(tx,id);return load(tx,id,version,(await inputs(tx,id)).revision);}));},
  save(raw:unknown){const setting=ruleDraftSave.parse(raw);return database.use(db=>db.transaction(async tx=>{
   const version=await target(tx,setting.takeId),binding=await inputs(tx,setting.takeId),previous=await load(tx,setting.takeId,version,binding.revision);
   if(setting.acceptedVersion!==version||setting.revision!==previous.revision||setting.inputRevision!==binding.revision||binding.version&&binding.version!==version)throw Error('Strategy, inputs or rule draft changed; reload before saving');
   await validateRuleReferences(tx,setting.config,binding.config);
   const accounts=setting.config.rules.flatMap(rule=>rule.action.kind==='agent'?rule.action.capabilities.accountIds:'scope' in rule.action?[rule.action.scope.accountId]:[]);
   if(accounts.length){const rows=(await tx.query<{id:string}>(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id WHERE c.owner_id=(SELECT id FROM local_owners LIMIT 1) AND a.id=ANY($1::uuid[])`,[accounts])).rows;
    if(accounts.some(id=>!rows.some(row=>row.id===id)))throw Error('Rule account is unavailable');}
   const revision=previous.revision+1;
   await tx.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,$2,$3,$4,$5)',[setting.takeId,revision,version,binding.revision,JSON.stringify(setting.config)]);
   return {...setting,revision};
  }));},
  async preview(raw:unknown){
   const id=z.uuid().parse(raw);
   const setting=await database.use(db=>db.transaction(async tx=>{const version=await target(tx,id);return load(tx,id,version,(await inputs(tx,id)).revision);}));
   const observation=await snapshot(id);
   const current=await database.use(db=>db.transaction(async tx=>{
    const version=await target(tx,id),binding=await inputs(tx,id),draft=await load(tx,id,version,binding.revision);
    return {version,inputRevision:binding.revision,draftRevision:draft.revision};
   }));
   return {setting,status:'draft_only' as const,activationAvailable:false,
    blockers:[...(setting.revision!==current.draftRevision?['rule_draft_changed']:[]),...(setting.acceptedVersion!==current.version||observation.acceptedVersion!==current.version?['strategy_version_changed']:[]),...(setting.inputRevision!==current.inputRevision||observation.bindingRevision!==current.inputRevision?['input_revision_changed']:[]),...(observation.status!=='ready'?[observation.reason??'inputs_unavailable']:[]),'rule_runner_not_enabled'],
    actions:setting.config.rules.map(rule=>({ruleId:rule.id,kind:rule.action.kind,approval:rule.policy.approval,canExecute:false})),
    usage:'Draft validation only. Trading actions and agent capabilities express intent, not permission. No source acquisition, notifications, agent calls or trades occur.'};
  },
 };
}

export async function validateRuleReferences(tx:Query,config:RuleDraftSetting['config'],bindings:TakeInputsConfig){
  const sources=(await tx.query<{id:string;revision:number;config:unknown}>(`SELECT s.id,s.current_revision AS revision,r.config FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision WHERE s.owner_id=(SELECT id FROM local_owners LIMIT 1) AND s.id=ANY($1::uuid[])`,[bindings.inputs.map(input=>input.sourceId)])).rows;
  for(const rule of config.rules){
   if(rule.context.some(step=>bindings.inputs.some(input=>input.key===step.output)))throw Error('Context output cannot shadow a bound input');
   for(const ref of [rule.trigger,...rule.context.flatMap<{kind:'fetch'|'numeric';input:string}>(step=>step.kind==='fetch'?[{kind:'fetch' as const,input:step.input}]:step.kind==='window'?[{kind:'numeric' as const,input:step.input}]:[]),...rule.conditions.all.filter(condition=>!rule.context.some(step=>step.output===condition.input))]){
    const binding=bindings.inputs.find(input=>input.key===ref.input);
    if(!binding)throw Error('Rule input is not bound');
    const source=sources.find(source=>source.id===binding.sourceId);
    if(!source||source.revision!==binding.sourceRevision)throw Error('Rule source changed; update its input binding');
    const feed=takeInputFeed(binding.sourceId,savedSourceConfig.parse(source.config),binding.feedId);
    if(!feed||feed.mapping.kind!==binding.kind||feed.unit!==binding.unit)throw Error('Rule feed changed');
    if('destination' in feed&&feed.destination?.kind==='market-metadata'){
     if(!feed.storage.fields.includes(binding.field))throw Error('Metadata field is not retained');
     if(ref.kind==='event')throw Error('Metadata supports sampled state rules; event inputs are not supported');
    }
    if(feed.mapping.kind==='event'){
     const field=feed.mapping.fields[binding.field];if(!field)throw Error('Rule field unavailable');
     if((ref.kind==='threshold'||ref.kind==='numeric')&&!['number','string'].includes(field.type)||(ref.kind==='boolean_change'||ref.kind==='boolean')&&field.type!=='boolean')throw Error('Rule field type does not match');
     if(ref.kind==='event'){
      const eventId=feed.mapping.fields[ref.eventIdField];
      if(!eventId||!['string','number'].includes(eventId.type)||typeof ref.equals!==field.type)throw Error('Event identity or match field is incompatible');
     }
    }

    if(ref.kind==='event'&&binding.kind!=='event'||(ref.kind==='boolean_change'||ref.kind==='boolean')&&binding.kind!=='boolean'&&binding.kind!=='event'||(ref.kind==='threshold'||ref.kind==='numeric')&&binding.kind==='boolean')throw Error('Rule input type does not match');
   }
  }
 }
