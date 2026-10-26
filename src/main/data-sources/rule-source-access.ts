import {randomUUID} from 'node:crypto';
import {coinbaseSourceId} from '../../shared/coinbase-source';
import {takeInputSchema,type TakeInput} from '../../shared/take-inputs';
import type {DataFeedRef,DataSnapshot} from '../../shared/data-sources';
import type {createCustomDataSources} from './service';
import type {createCoinbaseStreamHost} from './coinbase-stream/host';
import type {createCoinbaseSourceSettings} from './coinbase-stream/source-settings';
import {coinbaseInputProduct} from './input-feed';
import {evaluateTakeInput} from './take-inputs';

/** Route provider inputs to the existing socket; custom inputs keep their shared runtime. */
export function createRuleSourceAccess(
 custom:Pick<ReturnType<typeof createCustomDataSources>,'peek'|'ruleDemand'|'ruleFetch'>,
 stream:Pick<ReturnType<typeof createCoinbaseStreamHost>,'ruleDemand'|'inputSnapshot'|'watch'>,
 source:Pick<ReturnType<typeof createCoinbaseSourceSettings>,'get'>,
 available:()=>boolean,now=Date.now,
){
 const demands=new Map<string,DataFeedRef[]>(),temporary=new Map<string,DataFeedRef>();
 function eligible(ref:DataFeedRef){
  const current=source.get();return current.id===ref.sourceId&&current.revision===ref.configVersion&&ref.schemaVersion===1&&current.enabled&&current.validated&&current.config.collection==='automatic'&&!!coinbaseInputProduct(ref.feedId);
 }
 function products(refs:DataFeedRef[]){return [...new Set(refs.filter(ref=>ref.sourceId===coinbaseSourceId&&eligible(ref)).map(ref=>coinbaseInputProduct(ref.feedId)!))].sort();}
 function check(refs:DataFeedRef[]){if(new Set(refs.map(ref=>JSON.stringify(ref))).size>128||products(refs).length>100)throw Error('Rule source capacity reached');}
 function reconcile(){stream.ruleDemand(available()?products([...demands.values()].flat().concat([...temporary.values()])):[]);}
 function peek(refs:DataFeedRef[]):Array<DataSnapshot|null>{
  const generic=custom.peek(refs.filter(ref=>ref.sourceId!==coinbaseSourceId));let index=0;
  return refs.map(ref=>ref.sourceId===coinbaseSourceId?available()&&eligible(ref)?stream.inputSnapshot(ref):null:generic[index++]);
 }
 function demand(id:string,refs:DataFeedRef[]){
  const next=new Map(demands);if(refs.length)next.set(id,refs);else next.delete(id);
  check([...next.values()].flat().concat([...temporary.values()]));
  custom.ruleDemand(id,refs.filter(ref=>ref.sourceId!==coinbaseSourceId));
  demands.clear();for(const [key,value] of next)demands.set(key,value);reconcile();
 }
 async function fetch(raw:TakeInput,freshness:'latest'|'next',timeoutMs:number,signal:AbortSignal){
  const binding=takeInputSchema.parse(raw);
  if(binding.sourceId!==coinbaseSourceId)return custom.ruleFetch(binding,freshness,timeoutMs,signal);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw Error('Source unavailable');
  const ref={sourceId:binding.sourceId,feedId:binding.feedId,configVersion:binding.sourceRevision,schemaVersion:1};
  if(!available()||signal.aborted||!eligible(ref))throw Error('Source unavailable');
  const baseline=peek([ref])[0]?.latest,start=now(),id=randomUUID();
  check([...demands.values()].flat().concat([...temporary.values()],ref));temporary.set(id,ref);
  try{
   reconcile();
   // Event-driven: the stream reports trades and readiness changes; the deadline bounds the wait.
   return await new Promise<ReturnType<typeof evaluateTakeInput>>((resolve,reject)=>{
    let done=false,unwatch=()=>{};
    const finish=(value?:ReturnType<typeof evaluateTakeInput>)=>{if(done)return;done=true;clearTimeout(timer);unwatch();signal.removeEventListener('abort',abort);if(value)resolve(value);else reject(Error('Source unavailable'));};
    const abort=()=>finish();signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>finish(),Math.max(0,timeoutMs-(now()-start)));
    const check=()=>{
     if(done)return;
     try{
      if(signal.aborted||!available()||!eligible(ref)||now()<start||now()-start>=timeoutMs){finish();return;}
      const snapshot=peek([ref])[0],current=source.get();
      const value=evaluateTakeInput(binding,{...current,current_revision:current.revision},snapshot,now()),o=value.observation;
      if(value.quality==='fresh'&&o&&(freshness==='latest'||o.receivedAt>=start&&(!baseline||o.epoch!==baseline.epoch||o.eventTime!==baseline.eventTime))){finish(value);return;}
     }catch{finish();}
    };
    unwatch=stream.watch(check);check();
   });
  }finally{temporary.delete(id);reconcile();}
 }
 return {peek,demand,fetch};
}
