import type {InspectedSourceField} from '../../../shared/data-sources';
export type MappingRole='identifier'|'price'|'timestamp';
const names:Record<MappingRole,string[]>={identifier:['symbol','product_id','instrument_id','market_id','ticker','id','product'],price:['price','last_price','last_trade_price','last','value'],timestamp:['timestamp','event_time','time','ts']};
export function suggestedFields(fields:InspectedSourceField[],role:MappingRole,type:'string'|'number'=role==='timestamp'?'number':'string'){
 const compatible=fields.filter(f=>f.selectable&&f.type===type);
 const rank=(f:InspectedSourceField)=>names[role].indexOf((f.path.at(-1)??'').replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase());
 return compatible.map(field=>({field,suggested:rank(field)>=0})).sort((a,b)=>(rank(a.field)<0?999:rank(a.field))-(rank(b.field)<0?999:rank(b.field)));
}
export function suggestedMetadataKey(field:InspectedSourceField,used:string[]):string{
 let base=(field.path.at(-1)??'field').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,70);
 if(!/^[a-zA-Z]/.test(base)||['constructor','prototype','__proto__'].includes(base))base='field';
 let key=base,index=2;while(used.includes(key))key=`${base}_${index++}`;
 return key;
}

export function mappingFieldItems(fields:{key:string;field:InspectedSourceField}[],role:MappingRole,current:string,type?:'string'|'number',sampled=true){
 const items=suggestedFields(fields.map(f=>f.field),role,type).map(({field,suggested})=>({value:fields.find(f=>f.field===field)!.key,label:`${field.path.join(' → ')}${suggested?' · Suggested':''}`}));
 if(current&&!items.some(item=>item.value===current)){
  let label=current;try{const path=JSON.parse(current);if(Array.isArray(path))label=path.join(' → ');}catch{/* Stable custom field keys are not JSON paths. */}
  items.unshift({value:current,label:`${label} · ${sampled?'missing or incompatible':'configured'}`});
 }
 return [{value:'',label:'Choose a field'},...items];
}
