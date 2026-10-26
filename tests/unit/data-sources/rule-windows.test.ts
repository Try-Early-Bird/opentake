import {test,expect} from 'vitest';
import {createRuleWindows} from '../../../src/main/strategies/rule-windows';
import {runRuleContext} from '../../../src/main/strategies/rule-context';
import {dataSourceThresholdPreset,strategyRule} from '../../../src/shared/strategy-rules';
import type {TakeInputValue} from '../../../src/shared/take-inputs';
const binding={key:'price',sourceId:'00000000-0000-4000-8000-000000000001',sourceRevision:1,feedId:'price',field:'value',kind:'metric' as const,unit:'USD',maxAgeMs:15000};
function input(at:number,value=String(at/1000),epoch=1):TakeInputValue{return {binding,value,quality:'fresh',ageMs:0,observation:{sourceId:binding.sourceId,feedId:'price',configVersion:1,schemaVersion:1,epoch,unit:'USD',receivedAt:at,eventTime:at,timeBasis:'provider',clockSkewMs:0,origin:'live',adapterId:'fixture',adapterVersion:'1',payload:{kind:'metric',value}}};}
const step={kind:'window' as const,input:'price',output:'average',operation:'mean' as const,windowMs:4000,minSamples:3,maxGapMs:2000};
test('windows require full coverage, deduplicate observations and preserve decimal precision',()=>{
 const store=createRuleWindows();store.observe(input(1000,'1.000000000000000001'),1000);
 expect(store.read(step,1000)).toBe('window_warming');
 store.observe(input(1000,'99'),2000);store.observe(input(3000,'2.000000000000000001'),3000);store.observe(input(5000,'3.000000000000000001'),5000);
 const result=store.read(step,5000);expect(result).toMatchObject({value:'2.000000000000000001',window:{start:1000,end:5000}});
 for(const operation of ['sum','min','max'] as const)expect(store.read({...step,operation},5000)).toMatchObject({value:{sum:'6.000000000000000003',min:'1.000000000000000001',max:'3.000000000000000001'}[operation]});
 store.observe(input(7000,'100'),7000);expect(result).toMatchObject({value:'2.000000000000000001'});
});
test('gaps, epochs, stale values, clock reversal and restarts cannot reuse complete windows',()=>{
 const warm=()=>{const store=createRuleWindows();for(const at of [1000,3000,5000])store.observe(input(at),at);return store;};
 let store=warm();expect(store.read({...step,maxGapMs:1000},5000)).toBe('window_gap');
 store.observe(input(7000,'7',2),7000);expect(store.read(step,7000)).toBe('window_warming');
 store=warm();const restarted=input(7000);restarted.observation!.runtimeId='new-runtime';store.observe(restarted,7000);expect(store.read(step,7000)).toBe('window_warming');
 store=warm();store.observe({...input(7000),quality:'stale'},7000);expect(store.read(step,7000)).toBe('window_unavailable');
 store=warm();store.observe(input(4000),4000);expect(store.read(step,5000)).toBe('window_warming');
 store=warm();store.observe(input(9000),9000);expect(store.read(step,9000)).toBe('window_warming');
 store.clear();expect(store.read(step,9000)).toBe('window_unavailable');
 expect(createRuleWindows().read(step,5000)).toBe('window_unavailable');
});
test('window context uses captured evidence and composes with derive and conditions',async()=>{
 const store=createRuleWindows();for(const at of [1000,3000,5000])store.observe(input(at),at);
 const rule=strategyRule.parse({...dataSourceThresholdPreset('00000000-0000-4000-8000-000000000002','price','10',{kind:'notify',message:'Fixture'}),context:[step,{kind:'derive',output:'spread',inputs:['price','average'],operation:'difference'}],conditions:{all:[{kind:'numeric',input:'spread',operator:'gt',value:'1'}]}});
 const run=(windows:any)=>runRuleContext(rule,input(5000),[binding],async()=>{throw Error('No fetch');},new AbortController().signal,10000,5000,()=>6000,windows);
 const result=await run({average:store.read(step,5000)});expect(result.status).toBe('ready');expect(result.values.spread.value).toBe('2');expect(result.values.average.window?.end).toBe(5000);
 expect((await run({average:'window_warming'})).reason).toBe('window_warming');
 expect(strategyRule.safeParse({...rule,context:[{...step,windowMs:1000}]}).success).toBe(false);
});

test('sample and numeric bounds fail closed instead of producing a truncated aggregate',()=>{
 const store=createRuleWindows();for(let at=0;at<=3000;at+=5)store.observe(input(at,'1'),at);
 expect(store.read({...step,windowMs:3000},3000)).toBe('window_warming');
 const large=createRuleWindows();for(const at of [1000,3000,5000])large.observe(input(at,'9'.repeat(80)),at);
 expect(large.read({...step,operation:'sum'},5000)).toBe('window_capacity');
});

test('window continuity follows observation times, not evaluator tick spacing',()=>{
 const store=createRuleWindows(),pair={...step,minSamples:2};
 store.observe(input(1000),1000);store.observe(input(3000),3000);
 // A 2.5s tick gap with continuous observations keeps the window.
 store.observe(input(5000),5500);
 expect(store.read(pair,5500)).toMatchObject({value:'4',window:{start:1500,end:5500}});
 // A real observation gap is still reported.
 store.observe(input(9000),9000);expect(store.read(pair,9000)).toBe('window_gap');
});
