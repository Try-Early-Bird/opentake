import {takeInputFeed,takeInputCollection} from './input-feed';
import {z} from 'zod';
import {takeInputsConfigSchema,type TakeInput,type TakeInputValue,type TakeInputSnapshot,type TakeInputsSetting} from '../../shared/take-inputs';
import type {DataFeedRef,DataSnapshot} from '../../shared/data-sources';
import type {createDatabaseLifecycle} from '../database';
import type {DatabaseClient} from '../database-client';
import {savedSourceConfig} from './saved-config';
import {marketKey} from '../../shared/search';
import {sampleSchema} from './contracts';
type Query=Pick<DatabaseClient,'query'>;
type Source={id:string;current_revision:number;enabled:boolean;validated:boolean;config:unknown};
/** Inspectable context only. No acquisition, agent calls, rules, or execution. */
export function evaluateTakeInput(binding:TakeInput,source:Source|undefined,snapshot:DataSnapshot|null,now:number,committedMetadata=false):TakeInputValue{
 const result=(quality:TakeInputValue['quality'],observation:TakeInputValue['observation']=null):TakeInputValue=>({binding,quality,value:null,ageMs:observation?Math.max(0,now-(observation.eventTime??observation.receivedAt)):null,observation});
 if(!source)return result('missing');
 if(source.current_revision!==binding.sourceRevision)return result('source-changed');
 const parsed=savedSourceConfig.safeParse(source.config);if(!parsed.success)return result('invalid');
 if(!source.enabled||!source.validated||!takeInputCollection(parsed.data))return result('disabled');
 const feed=takeInputFeed(binding.sourceId,parsed.data,binding.feedId);
 if(!feed||feed.mapping.kind!==binding.kind||feed.unit!==binding.unit)return result('invalid');
 if('destination' in feed&&feed.destination?.kind==='market-metadata'&&!committedMetadata)return result('missing');
 const o=snapshot?.latest;if(!o)return result('missing');
 if(o.sourceId!==binding.sourceId||o.configVersion!==binding.sourceRevision||o.feedId!==binding.feedId||o.schemaVersion!==1||o.unit!==binding.unit||o.payload.kind!==binding.kind||!sampleSchema.safeParse({payload:o.payload,eventTime:o.eventTime,origin:o.origin}).success)return result('invalid');
 if(!Number.isSafeInteger(o.receivedAt)||o.receivedAt<0||o.receivedAt>now||o.eventTime!==null&&o.eventTime>now)return result('invalid');
 if(snapshot.quality!=='fresh'||snapshot.connection!=='live'||o.origin!=='live')return result(snapshot.quality==='gap'?'gap':snapshot.quality==='invalid'?'invalid':'stale',o);
 const age=Math.min(binding.maxAgeMs,'destination' in feed&&feed.destination?.kind==='market-metadata'?feed.destination.maxAgeMs:Infinity,'freshnessMs' in parsed.data?parsed.data.freshnessMs:parsed.data.pollIntervalMs*2);
 if(now-o.receivedAt>age||now-(o.eventTime??o.receivedAt)>age)return result('stale',o);
 const value=o.payload.kind==='event'?o.payload.fields[binding.field]:o.payload.kind==='metric'||o.payload.kind==='boolean'?o.payload.value:undefined;
 if(value===undefined||value===null)return result('missing',o);
 if(o.payload.kind!=='event'&&binding.field!=='value'||feed.mapping.kind==='event'&&!Object.hasOwn(feed.mapping.fields,binding.field))return result('invalid',o);
 return {...result('fresh',o),value};
}
/** Only committed, retained fields from the currently live runtime epoch are eligible. */
export async function evaluateStoredTakeInput(tx:Query,binding:TakeInput,source:Source|undefined,snapshot:DataSnapshot|null,now:number):Promise<TakeInputValue>{
 const config=savedSourceConfig.safeParse(source?.config);
 const feed=config.success?takeInputFeed(binding.sourceId,config.data,binding.feedId):undefined;
 if(!feed||!('destination' in feed)||feed.destination?.kind!=='market-metadata')return evaluateTakeInput(binding,source,snapshot,now);
 const blocked=(quality:TakeInputValue['quality']):TakeInputValue=>({binding,quality,value:null,ageMs:null,observation:null});
 const preflight=evaluateTakeInput(binding,source,null,now);
 if(preflight.quality!=='missing')return preflight;
 if(!feed.storage.fields.includes(binding.field))return blocked('invalid');
 const live=snapshot?.latest;
 if(!live||!live.runtimeId||snapshot?.quality!=='fresh'||snapshot.connection!=='live')return blocked(snapshot?.quality==='gap'?'gap':'missing');
 const row=(await tx.query<{fields:Record<string,unknown>;field_timestamps:Record<string,unknown>}>(`SELECT m.fields,m.field_timestamps FROM market_source_metadata m
  JOIN data_sources s ON s.id=m.source_id AND s.owner_id=m.owner_id AND s.current_revision=m.revision
  WHERE m.owner_id=(SELECT id FROM local_owners LIMIT 1) AND m.source_id=$1 AND m.revision=$2 AND m.feed_id=$3 AND m.market_key=$4 AND m.namespace=$5 AND s.enabled AND s.validated`,
  [binding.sourceId,binding.sourceRevision,binding.feedId,marketKey({identity:feed.destination.market}),feed.destination.namespace])).rows[0];
 const proof=z.object({updatedAt:z.number().int().nonnegative(),eventTime:z.number().int().nonnegative().nullable(),provenance:z.object({runtimeId:z.uuid(),epoch:z.number().int().nonnegative(),revision:z.number().int().positive(),adapterId:z.string(),adapterVersion:z.string(),origin:z.literal('live')})}).safeParse(row?.field_timestamps[binding.field]);
 if(!proof.success)return blocked('missing');
 const p=proof.data.provenance;
 if(p.runtimeId!==live.runtimeId||p.epoch!==live.epoch||p.revision!==binding.sourceRevision||p.adapterId!==live.adapterId||p.adapterVersion!==live.adapterVersion)return blocked('gap');
 const value=row?.fields[binding.field];
 const definition=feed.mapping.kind==='event'?feed.mapping.fields[binding.field]:undefined;
 if(!definition||value===null||value===undefined)return blocked('missing');
 if(typeof value!==definition.type)return blocked('invalid');
 // Preserve original field receipt/provider times; never borrow another field's freshness.
 const observation={sourceId:live.sourceId,feedId:live.feedId,configVersion:live.configVersion,schemaVersion:live.schemaVersion,adapterId:p.adapterId,adapterVersion:p.adapterVersion,runtimeId:p.runtimeId,epoch:p.epoch,unit:live.unit,origin:p.origin,clockSkewMs:Math.max(0,(proof.data.eventTime??proof.data.updatedAt)-proof.data.updatedAt),receivedAt:proof.data.updatedAt,eventTime:proof.data.eventTime,timeBasis:proof.data.eventTime===null?'receipt' as const:'provider' as const,
  payload:{kind:'event' as const,fields:{[binding.field]:value as string|number|boolean}}};
 return evaluateTakeInput(binding,source,{...snapshot!,latest:observation},now,true);
}
export function createTakeInputs(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,peek:(refs:DataFeedRef[])=>Array<DataSnapshot|null>,now=Date.now){
 async function target(tx:Query,takeId:string){
  const row=(await tx.query<{current_version_id:string|null}>(`SELECT s.current_version_id FROM takes t JOIN strategies s ON s.id=t.strategy_id AND s.owner_id=t.owner_id
   WHERE t.id=$1 AND t.owner_id=(SELECT id FROM local_owners LIMIT 1) AND t.archived_at IS NULL AND s.archived_at IS NULL FOR UPDATE OF t,s`,[takeId])).rows[0];
  if(!row?.current_version_id)throw Error('Choose an active Take with an accepted version');return row.current_version_id;
 }
 async function load(tx:Query,takeId:string,version:string):Promise<TakeInputsSetting>{
  const row=(await tx.query<{revision:number;accepted_version:string;config:unknown}>('SELECT revision,accepted_version,config FROM take_input_revisions WHERE take_id=$1 ORDER BY revision DESC LIMIT 1',[takeId])).rows[0];
  return {takeId,revision:row?.revision??0,acceptedVersion:row?.accepted_version??version,config:row?takeInputsConfigSchema.parse(row.config):{inputs:[],maxSkewMs:5000}};
 }
 async function sources(tx:Query,inputs:TakeInput[]){return (await tx.query<Source>(`SELECT s.id,s.current_revision,s.enabled,s.validated,r.config FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision WHERE s.owner_id=(SELECT id FROM local_owners LIMIT 1) AND s.id=ANY($1::uuid[]) FOR SHARE OF s`,[[...new Set(inputs.map(input=>input.sourceId))]])).rows;}
 async function snapshotInTransaction(tx:Query,id:string,keys?:string[]):Promise<TakeInputSnapshot>{
   const version=await target(tx,id),setting=await load(tx,id,version);
   if(keys){z.array(z.string()).max(16).parse(keys);setting.config.inputs=setting.config.inputs.filter(input=>keys.includes(input.key));}
   const catalog=await sources(tx,setting.config.inputs);
   // All live samples are copied synchronously in one event-loop turn, after DB fences.
   const snapshots=peek(setting.config.inputs.map(input=>({sourceId:input.sourceId,feedId:input.feedId,configVersion:input.sourceRevision,schemaVersion:1}))),capturedAt=now();
   const inputs=await Promise.all(setting.config.inputs.map((input,index)=>version!==setting.acceptedVersion?{binding:input,quality:'version-changed' as const,value:null,ageMs:null,observation:null}:evaluateStoredTakeInput(tx,input,catalog.find(item=>item.id===input.sourceId),snapshots[index]??null,capturedAt)));
   const times=inputs.flatMap(input=>input.quality==='fresh'&&input.observation?[input.observation.eventTime??input.observation.receivedAt]:[]);
   const reason=!inputs.length?'no-inputs':inputs.some(input=>input.quality!=='fresh')?'inputs-unavailable':Math.max(...times)-Math.min(...times)>setting.config.maxSkewMs?'time-skew':null;
   return {takeId:id,bindingRevision:setting.revision,acceptedVersion:setting.acceptedVersion,capturedAt,status:reason?'blocked':'ready',reason,inputs};
 }
 return {
  load(raw:unknown){const id=z.uuid().parse(raw);return database.use(db=>db.transaction(async tx=>load(tx,id,await target(tx,id))));},
  save(raw:unknown){const setting=z.object({takeId:z.uuid(),revision:z.number().int().nonnegative(),acceptedVersion:z.uuid(),config:takeInputsConfigSchema}).strict().parse(raw);
   return database.use(db=>db.transaction(async tx=>{const version=await target(tx,setting.takeId);const previous=await load(tx,setting.takeId,version);
    if(version!==setting.acceptedVersion||previous.revision!==setting.revision)throw Error('Take inputs changed; reload before saving');
    const catalog=await sources(tx,setting.config.inputs);
    for(const binding of setting.config.inputs){const source=catalog.find(item=>item.id===binding.sourceId);if(!source||source.current_revision!==binding.sourceRevision||!source.enabled||!source.validated)throw Error('Source unavailable or changed');
     const config=savedSourceConfig.parse(source.config),feed=takeInputFeed(binding.sourceId,config,binding.feedId);
     if(feed&&'destination' in feed&&feed.destination?.kind==='market-metadata'&&!feed.storage.fields.includes(binding.field))throw Error('Metadata field is not retained');
     if(!takeInputCollection(config)||!feed||feed.mapping.kind!==binding.kind||feed.unit!==binding.unit||(feed.mapping.kind==='event'?!Object.hasOwn(feed.mapping.fields,binding.field):binding.field!=='value'))throw Error('Unsupported input field');
    }
    const revision=previous.revision+1;await tx.query('INSERT INTO take_input_revisions(take_id,revision,accepted_version,config) VALUES($1,$2,$3,$4)',[setting.takeId,revision,version,JSON.stringify(setting.config)]);
    return {...setting,revision};
   }));
  },
  snapshotInTransaction,
  snapshot(raw:unknown,keys?:string[]):Promise<TakeInputSnapshot>{const id=z.uuid().parse(raw);return database.use(db=>db.transaction(tx=>snapshotInTransaction(tx,id,keys)));},
 };
}
