import {test,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {runRuleContext} from '../../../src/main/strategies/rule-context';
import {dataSourceThresholdPreset,strategyRule} from '../../../src/shared/strategy-rules';
import type {TakeInputValue} from '../../../src/shared/take-inputs';
const now=100000;
function input(key:string,value:string,unit='USD'):TakeInputValue{
 const binding={key,sourceId:randomUUID(),sourceRevision:1,feedId:'price',field:'value',kind:'metric' as const,unit,maxAgeMs:15000};
 return {binding,value,quality:'fresh',ageMs:0,observation:{sourceId:binding.sourceId,feedId:'price',configVersion:1,schemaVersion:1,epoch:1,unit,receivedAt:now,eventTime:now,timeBasis:'provider',clockSkewMs:0,origin:'live',adapterId:'fixture',adapterVersion:'1',payload:{kind:'metric',value}}};
}
function rule(){return strategyRule.parse({...dataSourceThresholdPreset(randomUUID(),'price','10',{kind:'notify',message:'Test'}),context:[{kind:'fetch',input:'other_price',output:'other',freshness:'next',timeoutMs:100},{kind:'derive',operation:'difference',inputs:['price','other'],output:'spread'}],conditions:{all:[{kind:'numeric',input:'spread',operator:'gt',value:'1'}]}});}
test('ordered fetch and derive blocks retain precision and provenance, then evaluate conditions',async()=>{
 const trigger=input('price','9.000000000000000001'),other=input('other_price','7'),fetch=vi.fn(async()=>other);
 const result=await runRuleContext(rule(),trigger,[trigger.binding,other.binding],fetch,new AbortController().signal,now+1000,5000,()=>now);
 expect(result.status).toBe('ready');expect(result.values.spread.value).toBe('2.000000000000000001');expect(result.values.spread.inputs).toHaveLength(2);
 expect(fetch).toHaveBeenCalledWith(other.binding,'next',100,expect.any(AbortSignal));
 const falseResult=await runRuleContext(rule(),input('price','6'),[other.binding],fetch,new AbortController().signal,now+1000,5000,()=>now);expect(falseResult.status).toBe('conditions_false');
 for(const operation of ['sum','mean','min','max'] as const){const r=rule();r.context[1]={kind:'derive',operation,inputs:['price','other'],output:'spread'};const value=await runRuleContext(r,input('price','9'),[other.binding],fetch,new AbortController().signal,now+1000,5000,()=>now);expect(value.values.spread.value).toBe({sum:'16',mean:'8',min:'7',max:'9'}[operation]);}
});
test('blocks reject unit mismatch, stale input, time skew, timeout and revoked work without leaking provider errors',async()=>{
 const trigger=input('price','9'),other=input('other_price','7');
 const run=(fetch:any,bindings=[other.binding],signal=new AbortController().signal)=>runRuleContext(rule(),trigger,bindings,fetch,signal,now+1000,5000,()=>now);
 const eur=input('other_price','7','EUR');expect((await run(async()=>eur,[eur.binding])).reason).toBe('unit_mismatch');
 expect((await run(async()=>({...other,quality:'stale'}))).reason).toBe('input_unavailable');
 expect((await run(async()=>({...other,observation:{...other.observation!,eventTime:now-6000}}))).reason).toBe('context_time_skew');
 expect((await run(async()=>{throw Error('SECRET provider header');})).reason).toBe('context_unavailable');
 expect(JSON.stringify(await run(async()=>{throw Error('SECRET');}))).not.toContain('SECRET');
 expect((await run(()=>new Promise(()=>{}))).reason).toBe('fetch_timeout');
 const abort=new AbortController();abort.abort();const fetch=vi.fn();expect((await run(fetch,[other.binding],abort.signal)).reason).toBe('cancelled');expect(fetch).not.toHaveBeenCalled();
});
test('draft context is bounded and rejects arbitrary URLs, cycles and output collisions',()=>{
 const base=rule();
 expect(strategyRule.safeParse({...base,context:[{kind:'fetch',output:'other',input:'other_price',freshness:'next',timeoutMs:100,url:'https://example.com'}]}).success).toBe(false);
 expect(strategyRule.safeParse({...base,context:[{kind:'derive',output:'spread',operation:'sum',inputs:['later']}]}).success).toBe(false);
 expect(strategyRule.safeParse({...base,context:[{kind:'derive',output:'price',operation:'mean',inputs:['price']}]}).success).toBe(false);
});
