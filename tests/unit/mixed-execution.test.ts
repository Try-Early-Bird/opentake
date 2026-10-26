import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createMixedExecution,type MixedExecution,type MixedExecutionLeg,type MixedLegState} from '../../src/main/mixed-execution/coordinator';
import type {MixedPreview,MixedVenue} from '../../src/shared/mixed-execution';
function fixture(){
 const preview:MixedPreview={id:randomUUID(),takeId:randomUUID(),versionId:randomUUID(),routeRevision:randomUUID(),amountUsd:'10',state:'ready',executionEnabled:true,expiresAt:new Date(Date.now()+60000).toISOString(),legs:(['coinbase','robinhood'] as const).map(venue=>({venue,accountId:randomUUID(),currency:venue==='coinbase'?'USDC':'USD',quantity:'5',state:'ready',reason:null,orders:[],retainedCash:'5',available:'20',expiresAt:new Date(Date.now()+60000).toISOString(),evidence:'checked'}))};
 let saved:MixedExecution|null=null, funds=0;
 const sends:MixedVenue[]=[],reads:MixedVenue[]=[];
 const states:Record<MixedVenue,MixedLegState>={coinbase:'completed',robinhood:'waiting_market'};
 let fail:MixedVenue|undefined,valid=true;
 const store={find:async()=>saved,fund:async(id:string,p:MixedPreview,legs:{venue:MixedVenue;accountId:string;operationId:string}[])=>{funds++;saved={id,takeId:p.takeId,previewId:p.id,state:'funded',legs:legs.map(l=>({...l,reference:l.operationId,state:'reserved',message:null}))};return saved;},claimDispatch:async(_id:string,leg:MixedExecutionLeg)=>{const found=saved!.legs.find(l=>l.venue===leg.venue)!;if(found.state!=='reserved')return false;found.state='dispatching';return true;},saveLeg:async(id:string,leg:MixedExecutionLeg)=>{saved={...saved!,legs:saved!.legs.map(l=>l.venue===leg.venue?leg:l)};saved.state=saved.legs.every(l=>l.state==='completed')?'completed':saved.legs.some(l=>l.state==='attention')?'attention':'running';return saved;}};
 const adapters=Object.fromEntries((['coinbase','robinhood'] as const).map(venue=>[venue,{dispatch:async()=>{sends.push(venue);if(fail===venue)throw Error('Network disconnected after submission');return {state:states[venue],message:null};},reconcile:async()=>{reads.push(venue);return {state:states[venue],message:null};}}])) as Parameters<typeof createMixedExecution>[0]['adapters'];
 const make=()=>createMixedExecution({preview:async()=>preview,validate:async()=>{if(!valid)throw Error('Insufficient buying power');},store,adapters});
 return {preview,request:{operationId:randomUUID(),previewId:preview.id},make,sends,reads,states,setFail:(v:MixedVenue)=>{fail=v;},invalidate:()=>{valid=false;},funds:()=>funds,setSaved:(run:MixedExecution)=>{saved=run;}};
}
test('checks both accounts before any funding and rejects expired or blocked reviews',async()=>{
 const f=fixture();f.invalidate();await expect(f.make().start(f.request)).rejects.toThrow('buying power');expect(f.funds()).toBe(0);expect(f.sends).toEqual([]);
 const e=fixture();e.preview.expiresAt=new Date(0).toISOString();await expect(e.make().start(e.request)).rejects.toThrow('expired');expect(e.funds()).toBe(0);
 const b=fixture();b.preview.state='blocked';await expect(b.make().start(b.request)).rejects.toThrow('blocked');expect(b.funds()).toBe(0);
});
test('one funded operation dispatches each venue once and preserves the market-closed child',async()=>{
 const f=fixture(),service=f.make();const [a,b]=await Promise.all([service.start(f.request),service.start(f.request)]);
 expect(a).toEqual(b);expect(f.funds()).toBe(1);expect(f.sends).toEqual(['coinbase','robinhood']);expect(a.legs.map(l=>l.state)).toEqual(['completed','waiting_market']);
 f.states.robinhood='completed';const recovered=await f.make().start(f.request);expect(recovered.state).toBe('completed');expect(f.sends).toHaveLength(2);expect(f.reads).toEqual(['robinhood']);expect(f.funds()).toBe(1);
});
test('unknown submission outcome is reconciled, never funded or submitted again',async()=>{
 const f=fixture();f.setFail('coinbase');const first=await f.make().start(f.request);expect(first.state).toBe('attention');expect(first.legs[0].message).toContain('Funds remain assigned');
 const next=await f.make().start(f.request);expect(next.legs[0].state).toBe('completed');expect(f.funds()).toBe(1);expect(f.sends).toEqual(['coinbase','robinhood']);expect(f.reads).toEqual(['coinbase','robinhood']);
});
test('a crash after the dispatch marker never repeats the child write',async()=>{
 const f=fixture();f.setSaved({id:f.request.operationId,takeId:f.preview.takeId,previewId:f.preview.id,state:'running',legs:f.preview.legs.map(l=>({venue:l.venue,accountId:l.accountId,operationId:randomUUID(),reference:randomUUID(),state:'dispatching',message:null}))});
 await f.make().start(f.request);expect(f.sends).toEqual([]);expect(f.reads).toEqual(['coinbase','robinhood']);expect(f.funds()).toBe(0);
});
test('reusing an operation with a different preview is rejected',async()=>{
 const f=fixture(),service=f.make();await service.start(f.request);await expect(service.start({...f.request,previewId:randomUUID()})).rejects.toThrow('changed');expect(f.funds()).toBe(1);
});

test('preview-only adapters cannot accidentally enable live execution',async()=>{const f=fixture();f.preview.executionEnabled=false;await expect(f.make().start(f.request)).rejects.toThrow('not enabled');expect(f.funds()).toBe(0);expect(f.sends).toEqual([]);});
