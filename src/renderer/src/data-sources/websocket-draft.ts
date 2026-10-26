import {marketIdentitySchema} from '../../../shared/search';
import {marketIdentifierError} from '../../../shared/source-market-identifiers';
import type {WebsocketSourceConfig} from '../../../shared/websocket-sources';
import type {CustomSourceConfig,InspectedSourceField} from '../../../shared/data-sources';
import {buildSourceDraft} from './source-draft';
export type PriceDestination=NonNullable<CustomSourceConfig['feeds'][number]['destination']>;
export function websocketFields(fields:InspectedSourceField[],original?:WebsocketSourceConfig['feeds'][number]['mapping']){
 const used=new Set(original?.kind==='event'?Object.keys(original.fields):[]);
 return fields.map(field=>{const existing=original?.kind==='event'?Object.entries(original.fields).find(([,entry])=>JSON.stringify(entry.path)===JSON.stringify(field.path))?.[0]:undefined;
  if(existing)return {key:existing,field};let i=1;while(used.has(`field_${i}`))i++;const key=`field_${i}`;used.add(key);return {key,field};});
}
export function routedMappingError(destination:PriceDestination,fields:ReturnType<typeof websocketFields>,timestamp:string[]):string|null{
 if(destination.kind==='market-metadata'){
  if(!marketIdentitySchema.safeParse(destination.market).success)return 'Choose a destination market.';
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(destination.namespace)||['constructor','prototype','__proto__'].includes(destination.namespace))return 'Enter a valid metadata namespace.';
  const keys=fields.map(f=>f.key);
  if(new Set(keys).size!==keys.length||keys.some(key=>!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)||['constructor','prototype','__proto__'].includes(key)))return 'Use unique metadata field names.';
  return null;
 }
 if(destination.kind!=='market-prices')return null;
 const identifierError=marketIdentifierError(destination.market.venue,destination.identifier);if(identifierError)return identifierError;
 const type=(key:string)=>fields.find(f=>f.key===key)?.field.type;
 if(type(destination.symbolField)!=='string'||type(destination.priceField)!=='string')return 'Choose string fields for the market ID and exact price.';
 if(!timestamp.length)return 'Choose a provider timestamp in Unix milliseconds.';
 if(destination.conditions.length>16)return 'Use up to 16 conditions.';
 for(const c of destination.conditions){const values=c.op==='in'?c.values:[c.value];if(!type(c.field)||!values.length||values.length>200||values.some(v=>(v===null?'null':typeof v)!==type(c.field)||typeof v==='number'&&!Number.isFinite(v)))return 'Check each condition’s field and value.';}
 if(destination.holdings&&(destination.market.venue!=='robinhood'||!destination.holdings.accountIds.length))return 'Choose at least one equity account.';
 return null;
}
export function buildWebsocketFeeds(input:{original?:WebsocketSourceConfig;fields:InspectedSourceField[];name:string;unit:string;dataMode:'json'|'text';destination:PriceDestination;timestamp:string[];metadataKeys?:string[];storage:WebsocketSourceConfig['feeds'][number]['storage']}):WebsocketSourceConfig['feeds']{
 const old=input.original?.feeds[0],id=old?.id??(input.dataMode==='text'?'messages':'selected');
 const rest=input.original?.feeds.slice(1)??[];
 if(input.dataMode==='text'){
  if(input.destination.kind!=='custom-feed')throw Error('Market writes require JSON field mappings.');
  return [{id,name:old?.name??'Messages',unit:'text',mapping:{kind:'text'},storage:{...input.storage,fields:['value']}},...rest];
 }
 const fields=websocketFields(input.fields,old?.mapping).map((entry,index)=>({...entry,key:input.metadataKeys?.[index]??entry.key})),error=routedMappingError(input.destination,fields,input.timestamp);if(error)throw Error(error);
 const feed=buildSourceDraft({name:input.name,endpoint:'https://unused.example',credentialId:'',fields:input.fields,unit:input.destination.kind==='market-prices'?'USD':input.unit,metadataKeys:fields.map(f=>f.key),feedId:id,collection:'when-open',pollIntervalMs:60000,mode:input.storage.mode,sampleEveryMs:input.storage.sampleEveryMs,retentionDays:input.storage.retentionDays,
 destination:input.destination,eventTimePath:input.timestamp.length?input.timestamp:undefined}).feeds[0];
 // Retain the user's selected storage fields when their original mapping still applies.
 const allowed=feed.mapping.kind==='event'?Object.keys(feed.mapping.fields):['value'];
 if(old?.storage.fields.every(key=>allowed.includes(key)))feed.storage.fields=[...old.storage.fields];
 return [{...feed,name:old?.name??feed.name},...rest];
}
