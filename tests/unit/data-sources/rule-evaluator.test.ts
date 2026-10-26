import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {dataSourceThresholdPreset} from '../../../src/shared/strategy-rules';
import {evaluateRule,initialRuleState} from '../../../src/main/strategies/rule-evaluator';
import type {TakeInputSnapshot} from '../../../src/shared/take-inputs';
const source=randomUUID(),version=randomUUID();
function sample(value:string,time:number,quality:'fresh'|'gap'='fresh'):TakeInputSnapshot{return {takeId:randomUUID(),bindingRevision:1,acceptedVersion:version,capturedAt:time,status:quality==='fresh'?'ready':'blocked',reason:quality==='fresh'?null:'inputs-unavailable',inputs:[{binding:{key:'price',sourceId:source,sourceRevision:1,feedId:'price',field:'value',kind:'metric',unit:'USD',maxAgeMs:5000},value,quality,ageMs:0,observation:{sourceId:source,feedId:'price',configVersion:1,schemaVersion:1,epoch:1,unit:'USD',receivedAt:time,eventTime:time,timeBasis:'provider',clockSkewMs:0,origin:'live',adapterId:'fixture',adapterVersion:'1',payload:{kind:'metric',value}}}]};}
const rule=()=>({...dataSourceThresholdPreset(randomUUID(),'price','10',{kind:'notify',message:'test'}),policy:{cooldownMs:10000,holdMs:0,maxRuns:3,expiresAfterMs:1000,approval:'ask' as const}});
test('crossings baseline, reset, preserve decimal precision and respect run/cooldown/pending limits',()=>{
 const r=rule();let state=initialRuleState('s');
 const step=(value:string,time:number,pending=false)=>{const result=evaluateRule(r,state,sample(value,time),time,'s',pending);state=result.state;return result;};
 expect(step('9',1000).reason).toBe('baseline');expect(step('9',2000).fire).toBe(false);
 expect(step('10.000000000000000001',3000).fire).toBe(false);
 expect(step('9.999999999999999999',4000).fire).toBe(true);
 state.runs=1;state.lastFiredAt=4000;
 step('11',5000);expect(step('9',6000).reason).toBe('cooldown');
 step('11',7000);expect(step('9',8000,true).reason).toBe('pending_action');
 state.runs=3;step('11',9000);expect(step('9',10000).reason).toBe('run_limit');
});
test('hold windows reset on gaps, restart, epoch change and backwards clock; level rules can evaluate fresh initial state',()=>{
 const r=rule();r.policy.holdMs=2000;let state=initialRuleState('s');
 state=evaluateRule(r,state,sample('11',1000),1000,'s',false).state;
 let result=evaluateRule(r,state,sample('9',2000),2000,'s',false);expect(result.reason).toBe('holding');
 result=evaluateRule(r,result.state,sample('9',3000,'gap'),3000,'s',false);expect(result.state.candidateAt).toBeNull();
 result=evaluateRule(r,result.state,sample('9',4000),4000,'s',false);expect(result.reason).toBe('baseline');
 state=evaluateRule(r,result.state,sample('11',5000),5000,'s',false).state;
 state=evaluateRule(r,state,sample('9',6000),6000,'s',false).state;
 expect(evaluateRule(r,state,sample('9',8000),8000,'s',false).fire).toBe(true);
 expect(evaluateRule(r,state,sample('9',8000),8000,'restarted',false).reason).toBe('baseline');
 const epoch=sample('9',8000);epoch.inputs[0].observation!.epoch=2;expect(evaluateRule(r,state,epoch,8000,'s',false).reason).toBe('baseline');
 expect(evaluateRule(r,state,sample('9',1000),1000,'s',false).reason).toBe('baseline');
 const level={...rule(),trigger:{kind:'threshold' as const,input:'price',operator:'below' as const,value:'10'}};
 expect(evaluateRule(level,initialRuleState('s'),sample('9',1000),1000,'s',false).fire).toBe(true);
});
test('conditions, stale observations, invalid values and backfill cannot produce a firing',()=>{
 const r=rule(),state=evaluateRule(r,initialRuleState('s'),sample('11',1000),1000,'s',false).state;
 const stale=sample('9',1000);stale.capturedAt=7000;expect(evaluateRule(r,state,stale,7000,'s',false).reason).toBe('inputs_stale');
 const backfill=sample('9',2000);backfill.inputs[0].observation!.origin='backfill';expect(evaluateRule(r,state,backfill,2000,'s',false).fire).toBe(false);
 expect(evaluateRule(r,state,sample('not-number',2000),2000,'s',false).reason).toBe('invalid_type');
 const conditional={...r,conditions:{all:[{kind:'numeric' as const,input:'price',operator:'lt' as const,value:'5'}]}};
 expect(evaluateRule(conditional,evaluateRule(conditional,initialRuleState('s'),sample('11',1000),1000,'s',false).state,sample('9',2000),2000,'s',false).reason).toBe('conditions_false');
});
test('boolean changes need a baseline and a reset before firing again',()=>{
 const r={...rule(),trigger:{kind:'boolean_change' as const,input:'price',to:true}};
 const boolean=(value:boolean,time:number)=>{const result=sample('0',time);result.inputs[0].binding.kind='boolean';result.inputs[0].value=value;result.inputs[0].observation!.payload={kind:'boolean',value};return result;};
 let state=evaluateRule(r,initialRuleState('s'),boolean(true,1000),1000,'s',false).state;
 expect(evaluateRule(r,state,boolean(true,2000),2000,'s',false).fire).toBe(false);
 state=evaluateRule(r,state,boolean(false,3000),3000,'s',false).state;
 const fired=evaluateRule(r,state,boolean(true,4000),4000,'s',false);expect(fired.fire).toBe(true);
 expect(evaluateRule(r,fired.state,boolean(true,5000),5000,'s',false).fire).toBe(false);
});
