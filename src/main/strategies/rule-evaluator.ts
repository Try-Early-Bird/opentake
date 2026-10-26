import {z} from 'zod';
import {ruleDecimal,type StrategyRule} from '../../shared/strategy-rules';
import type {TakeInputSnapshot} from '../../shared/take-inputs';
export const ruleStateSchema=z.object({session:z.string().max(80),epoch:z.string().max(16000).nullable(),lastAt:z.number().int().nonnegative().nullable(),baseline:z.boolean(),armed:z.boolean(),candidateAt:z.number().int().nonnegative().nullable(),lastEvent:z.string().max(8192).nullable(),lastFiredAt:z.number().int().nonnegative().nullable(),runs:z.number().int().min(0).max(100000),attempts:z.number().int().min(0).max(100000).optional()}).strict().transform(state=>({...state,attempts:state.attempts??state.runs}));
export type RuleState=z.infer<typeof ruleStateSchema>;
export const initialRuleState=(session:string):RuleState=>({session,epoch:null,lastAt:null,baseline:false,armed:false,candidateAt:null,lastEvent:null,lastFiredAt:null,runs:0,attempts:0});
const reset=(state:RuleState,session:string,now:number)=>({...initialRuleState(session),lastAt:now,runs:state.runs,attempts:state.attempts,lastFiredAt:state.lastFiredAt});
function numeric(raw:unknown){const text=typeof raw==='number'&&Number.isFinite(raw)?String(raw):raw;const value=ruleDecimal.parse(text),negative=value.startsWith('-'),[whole,fraction='']=(negative?value.slice(1):value).split('.');return (negative?-1n:1n)*BigInt(whole+fraction.padEnd(36,'0'));}
/** Pure shadow evaluation. Only the transaction that records a firing advances runs/lastFiredAt. */
export function evaluateRule(rule:StrategyRule,previous:RuleState,snapshot:TakeInputSnapshot,now:number,session:string,pending:boolean,queuedEvent=false){
 let state={...previous},reason='waiting',eventKey:string|null=null;
 const blocked=(why:string)=>({state:reset(state,session,now),reason:why,fire:false,eventKey:null});
 if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid evaluation clock');
 const selected=[rule.trigger.input,...rule.conditions.all.map(c=>c.input)];
 const inputs=selected.map(key=>snapshot.inputs.find(input=>input.binding.key===key));
 if(snapshot.status!=='ready'||inputs.some(input=>!input||input.quality!=='fresh'||!input.observation||input.observation.origin!=='live'))return blocked('inputs_unavailable');
 if(now<snapshot.capturedAt||now-snapshot.capturedAt>5000)return blocked('snapshot_expired');
 for(const input of inputs){const o=input!.observation!;
  if(o.receivedAt>now||o.eventTime!==null&&o.eventTime>now||now-o.receivedAt>input!.binding.maxAgeMs||now-(o.eventTime??o.receivedAt)>input!.binding.maxAgeMs)return blocked('inputs_stale');
 }
 const epoch=JSON.stringify(inputs.map(input=>[input!.binding.key,input!.observation!.sourceId,input!.observation!.configVersion,input!.observation!.runtimeId??null,input!.observation!.epoch]));
 const continuity=state.session===session&&state.epoch===epoch&&state.lastAt!==null&&now>=state.lastAt&&now-state.lastAt<=Math.min(...inputs.map(input=>input!.binding.maxAgeMs));
 if(!continuity)state=reset(state,session,now);
 state.session=session;state.epoch=epoch;state.lastAt=now;
 const first=!state.baseline;state.baseline=true;
 try{
  const value=inputs[0]!.value,trigger=rule.trigger;
  let matched=false,edge=false;
  if(trigger.kind==='threshold'){
   const actual=numeric(value),threshold=numeric(trigger.value),above=trigger.operator.endsWith('above');
   matched=above?actual>threshold:actual<threshold;
   const restored=trigger.resetValue===undefined?!matched:above?actual<=numeric(trigger.resetValue):actual>=numeric(trigger.resetValue);
   if(restored){state.armed=true;state.candidateAt=null;}
   const crossing=trigger.operator.startsWith('crosses_');
   if(first&&crossing){state.armed=restored;return {state,reason:'baseline',fire:false,eventKey:null};}
   if(first&&!crossing)state.armed=true;
   edge=matched&&state.armed;
  }else if(trigger.kind==='boolean_change'){
   if(typeof value!=='boolean')return blocked('invalid_type');
   matched=value===trigger.to;if(!matched){state.armed=true;state.candidateAt=null;}
   if(first){state.armed=!matched;return {state,reason:'baseline',fire:false,eventKey:null};}
   edge=matched&&state.armed;
  }else{
   const o=inputs[0]!.observation!;
   if(o.payload.kind!=='event')return blocked('invalid_event');
   const identity=o.payload.fields[trigger.eventIdField];
   if(typeof identity!=='string'&&typeof identity!=='number'||String(identity).length===0||typeof identity==='number'&&!Number.isFinite(identity))return blocked('invalid_event_id');
   eventKey=JSON.stringify([o.sourceId,o.configVersion,o.feedId,identity]);
   matched=value===trigger.equals;edge=matched&&eventKey!==state.lastEvent;
   state.lastEvent=eventKey;
   if(first&&!queuedEvent)return {state,reason:'baseline',fire:false,eventKey:null};
  }
  if(!matched){state.candidateAt=null;return {state,reason,fire:false,eventKey:null};}
  const conditions=rule.conditions.all.every(condition=>{
   const input=snapshot.inputs.find(input=>input.binding.key===condition.input)!;
   if(condition.kind==='boolean'){if(typeof input.value!=='boolean')throw Error('Invalid boolean');return input.value===condition.value;}
   const a=numeric(input.value),b=numeric(condition.value);return {lt:a<b,lte:a<=b,gt:a>b,gte:a>=b,eq:a===b}[condition.operator];
  });
  if(!conditions){state.candidateAt=null;state.armed=false;return {state,reason:'conditions_false',fire:false,eventKey:null};}
  if(!edge&&state.candidateAt===null)return {state,reason:'waiting_reset',fire:false,eventKey:null};
  if(state.runs>=rule.policy.maxRuns||pending||state.lastFiredAt!==null&&(now<state.lastFiredAt||now-state.lastFiredAt<rule.policy.cooldownMs)){
   state.candidateAt=null;state.armed=false;return {state,reason:state.runs>=rule.policy.maxRuns?'run_limit':pending?'pending_action':'cooldown',fire:false,eventKey:null};
  }
  state.candidateAt??=now;
  if(now-state.candidateAt<rule.policy.holdMs)return {state,reason:'holding',fire:false,eventKey:null};
  state.candidateAt=null;state.armed=false;
  return {state,reason:'fired',fire:true,eventKey};
 }catch{return blocked('invalid_type');}
}
