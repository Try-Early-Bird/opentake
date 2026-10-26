import type {z} from 'zod';
import type {ruleWindowStep} from '../../shared/strategy-rules';
import type {TakeInputValue} from '../../shared/take-inputs';
import {number,decimal,type ContextValue} from './rule-context';
type Sample={at:number;receivedAt:number;value:string;seenAt:number};
type Series={identity:string;samples:Sample[];latest:TakeInputValue;lastChecked:number};
/** Latest-observation sampling, not lossless trade history. Each enrollment owns at most 16 series. */
export function createRuleWindows(){
 const series=new Map<string,Series>();
 return {
  clear(){series.clear();},
  observe(input:TakeInputValue,time:number){
   const key=input.binding.key,o=input.observation,at=o?.eventTime??o?.receivedAt;
   if(input.quality!=='fresh'||!o||o.origin!=='live'||at===undefined||at>time||o.receivedAt>time||time-at>input.binding.maxAgeMs||time-o.receivedAt>input.binding.maxAgeMs){series.delete(key);return;}
   let value:string;try{value=decimal(number(input.value));}catch{series.delete(key);return;}
   const identity=JSON.stringify([input.binding,o.runtimeId??null,o.epoch]),old=series.get(key);
   // Continuity is judged on observation times in read() (maxGapMs), not evaluator tick spacing:
   // a slow tick loses no coverage when the source itself was continuous.
   const current=old&&old.identity===identity&&time>=old.lastChecked?old:{identity,samples:[],latest:input,lastChecked:time};
   if(!old&&series.size>=16)return;
   current.lastChecked=time;
   const last=current.samples.at(-1);
   if(last&&(at<last.at||o.receivedAt<last.receivedAt)){series.delete(key);return;}
   // Equal timestamps use first-observed wins, matching latest-price ordering.
   if(!last||at>last.at){current.samples.push({at,receivedAt:o.receivedAt,value,seenAt:time});current.latest=input;}
   while(current.samples.length>512||current.samples.length>1&&current.samples[1].at<time-300000)current.samples.shift();
   series.set(key,current);
  },
  read(step:z.infer<typeof ruleWindowStep>,end:number):ContextValue|string{
   const current=series.get(step.input);if(!current)return 'window_unavailable';
   const start=end-step.windowMs,all=current.samples.filter(sample=>sample.seenAt<=end&&sample.at<=end);
   const anchor=[...all].reverse().find(sample=>sample.at<=start),samples=all.filter(sample=>sample.at>=start);
   if(!anchor||samples.length<step.minSamples)return 'window_warming';
   if(start-anchor.at>step.maxGapMs||!samples.length||end-samples[samples.length-1].at>step.maxGapMs)return 'window_gap';
   const coverage=[anchor,...samples];
   if(coverage.some((sample,index)=>index>0&&sample.at-coverage[index-1].at>step.maxGapMs))return 'window_gap';
   const numeric=samples.map(sample=>number(sample.value)),sum=numeric.reduce((a,b)=>a+b,0n);
   const value=step.operation==='sum'?sum:step.operation==='mean'?sum/BigInt(numeric.length):numeric.reduce((a,b)=>step.operation==='min'?(a<b?a:b):(a>b?a:b));
   const latest=samples[samples.length-1];
   let result:string;try{result=decimal(value);}catch{return 'window_capacity';}
   return {value:result,unit:current.latest.binding.unit,observedAt:latest.at,receivedAt:latest.receivedAt,maxAgeMs:current.latest.binding.maxAgeMs,inputs:[current.latest],window:{start,end,samples:coverage.map(({at,receivedAt,value})=>({at,receivedAt,value}))}};
  },
 };
}
