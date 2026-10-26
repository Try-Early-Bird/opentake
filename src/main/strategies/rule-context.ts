import {ruleDecimal,type StrategyRule} from '../../shared/strategy-rules';
import type {TakeInput,TakeInputValue} from '../../shared/take-inputs';
export interface ContextValue {value:string|number|boolean;unit:string;observedAt:number;receivedAt:number;maxAgeMs:number;inputs:TakeInputValue[];window?:{start:number;end:number;samples:Array<{at:number;receivedAt:number;value:string}>}}
export type ContextFetch=(binding:TakeInput,freshness:'latest'|'next',timeoutMs:number,signal:AbortSignal)=>Promise<TakeInputValue>;
const scale=10n**36n;
export function number(value:unknown){const text=ruleDecimal.parse(typeof value==='number'?String(value):value),negative=text.startsWith('-'),[whole,fraction='']=(negative?text.slice(1):text).split('.');return (negative?-1n:1n)*BigInt(whole+fraction.padEnd(36,'0'));}
export function decimal(value:bigint){const negative=value<0n,magnitude=negative?-value:value;return ruleDecimal.parse((negative?'-':'')+String(magnitude/scale)+(magnitude%scale?'.'+String(magnitude%scale).padStart(36,'0').replace(/0+$/,''):''));}
function fromInput(input:TakeInputValue):ContextValue{
 if(input.quality!=='fresh'||input.value===null||!input.observation||input.observation.origin!=='live')throw Error('input_unavailable');
 return {value:input.value,unit:input.binding.unit,observedAt:input.observation.eventTime??input.observation.receivedAt,receivedAt:input.observation.receivedAt,maxAgeMs:input.binding.maxAgeMs,inputs:[input]};
}
function fresh(value:ContextValue,now:number){return value.observedAt<=now&&value.receivedAt<=now&&now-value.observedAt<=value.maxAgeMs&&now-value.receivedAt<=value.maxAgeMs;}
export function contextConditions(rule:StrategyRule,values:Record<string,ContextValue>){return rule.conditions.all.every(condition=>{
 const value=values[condition.input];if(!value)throw Error('missing_condition');
 if(condition.kind==='boolean'){if(typeof value.value!=='boolean')throw Error('invalid_condition_type');return value.value===condition.value;}
 const a=number(value.value),b=number(condition.value);return {lt:a<b,lte:a<=b,gt:a>b,gte:a>=b,eq:a===b}[condition.operator];
});}
/** Ordered, bounded context only. No branches, scripts, arbitrary endpoints or action dispatch. */
export async function runRuleContext(rule:StrategyRule,trigger:TakeInputValue,bindings:TakeInput[],fetch:ContextFetch,signal:AbortSignal,expiresAt:number,maxSkewMs:number,now=Date.now,windows:Record<string,ContextValue|string>={}){
 const values:Record<string,ContextValue>=Object.create(null),steps:Array<{output:string;kind:string;status:'complete'|'failed';reason?:string}>=[];
 let current:string|undefined;
 const check=()=>{if(signal.aborted)throw Error('cancelled');if(now()>=expiresAt)throw Error('expired');};
 try{
  check();values[trigger.binding.key]=fromInput(trigger);
  for(const step of rule.context){
   check();current=step.output;
   if(step.kind==='fetch'){
    const binding=bindings.find(input=>input.key===step.input);if(!binding)throw Error('binding_unavailable');
    const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
    const timeout=Math.min(step.timeoutMs,expiresAt-now());let timer:ReturnType<typeof setTimeout>|undefined;
    try{
     const value=await Promise.race([fetch(binding,step.freshness,timeout,controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('fetch_timeout'));},timeout);})]);
     if(value.binding.key!==binding.key||value.binding.sourceId!==binding.sourceId||value.binding.sourceRevision!==binding.sourceRevision||value.binding.feedId!==binding.feedId||value.binding.field!==binding.field||value.binding.unit!==binding.unit||value.binding.kind!==binding.kind||value.binding.maxAgeMs!==binding.maxAgeMs)throw Error('binding_changed');
     values[step.output]=fromInput(value);
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
   }else if(step.kind==='window'){
    const value=windows[step.output];if(!value||typeof value==='string')throw Error(typeof value==='string'?value:'window_unavailable');
    values[step.output]=value;
   }else{
    const inputs=step.inputs.map(input=>values[input]);if(inputs.some(input=>!input))throw Error('input_unavailable');
    if(inputs.some(input=>input.unit!==inputs[0].unit))throw Error('unit_mismatch');
    const numeric=inputs.map(input=>number(input.value)),sum=numeric.reduce((total,value)=>total+value,0n);
    const result=step.operation==='sum'?sum:step.operation==='mean'?sum/BigInt(numeric.length):step.operation==='difference'?numeric[0]-numeric[1]:numeric.reduce((a,b)=>step.operation==='min'?(a<b?a:b):(a>b?a:b));
    const provenance=[...new Map(inputs.flatMap(input=>input.inputs).map(input=>[JSON.stringify(input.binding),input])).values()];
    values[step.output]={value:decimal(result),unit:inputs[0].unit,observedAt:Math.min(...inputs.map(input=>input.observedAt)),receivedAt:Math.min(...inputs.map(input=>input.receivedAt)),maxAgeMs:Math.min(...inputs.map(input=>input.maxAgeMs)),inputs:provenance};
   }
   check();if(!fresh(values[step.output],now()))throw Error('stale_context');
   steps.push({output:step.output,kind:step.kind,status:'complete'});
  }
  check();const timestamps=Object.values(values).map(value=>value.observedAt);
  if(Object.values(values).some(value=>!fresh(value,now())))throw Error('stale_context');
  if(Math.max(...timestamps)-Math.min(...timestamps)>maxSkewMs)throw Error('context_time_skew');
  const status=contextConditions(rule,values)?'ready':'conditions_false';
  const result={status,values,steps,reason:null};if(Buffer.byteLength(JSON.stringify(result))>128000)throw Error('context_size');return result;
 }catch(error){
  const known=['window_unavailable','window_warming','window_gap','window_capacity','cancelled','expired','fetch_timeout','binding_unavailable','binding_changed','input_unavailable','unit_mismatch','stale_context','context_time_skew','context_size','missing_condition','invalid_condition_type'];
  const reason=error instanceof Error&&known.includes(error.message)?error.message:'context_unavailable';
  if(current)steps.push({output:current,kind:rule.context.find(step=>step.output===current)?.kind??'unknown',status:'failed',reason});
  // Failed fetch errors/payloads may contain provider details: retain sanitized step status only.
  return {status:'failed',values:{},steps,reason};
 }
}
