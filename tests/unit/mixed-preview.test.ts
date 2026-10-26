import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mixedFunding} from '../../src/main/mixed-execution/funding';
import {createMixedPreview,type MixedPreviewContext,type MixedPreviewStore} from '../../src/main/mixed-execution/preview';
import type {BasketSpec} from '../../src/shared/strategies';
import type {MixedLegPreview} from '../../src/shared/mixed-execution';
const spec:BasketSpec={schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:4000},{instrument:{venue:'coinbase',symbol:'ZEC'},bps:3000},{instrument:{venue:'robinhood',symbol:'AAPL'},bps:3000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:5,driftBandRelative:null}};
const routes=[{venue:'coinbase' as const,accountId:randomUUID()},{venue:'robinhood' as const,accountId:randomUUID()}];
test('splits whole Take funding exactly and retains original asset weights',()=>{
 const legs=mixedFunding(spec,'100',routes,'USDC','1');
 expect(legs.map(l=>[l.venue,l.amountUsd,l.quantity])).toEqual([['coinbase','70','70'],['robinhood','30','30']]);
 expect(legs[0].weights.map(w=>w.bps)).toEqual([4000,3000]);
 expect(legs[0].sleeve.target.weights.map(w=>w.bps)).toEqual([5714,4286]);
 expect(mixedFunding(spec,'10.01',routes,'USD').map(l=>l.quantity)).toEqual(['7.01','3']);
 expect(mixedFunding(spec,'100',routes,'USDC','0.99')[0].quantity).toBe('70.7');
 expect(()=>mixedFunding(spec,'100',routes,'USDC')).toThrow('valuation');
 expect(()=>mixedFunding(spec,'0.001',routes,'USD')).toThrow('two decimals');
});
test('cash targets remain proportional and same-ticker venues remain distinct',()=>{
 const basket={...spec,target:{cashBps:1000,weights:[{instrument:{venue:'coinbase',symbol:'ABC'},bps:4500},{instrument:{venue:'robinhood',symbol:'ABC'},bps:4500}]}};
 const legs=mixedFunding(basket,'100',routes,'USD');
 expect(legs.map(l=>[l.quantity,l.sleeve.target.cashBps,l.sleeve.target.weights[0].bps])).toEqual([['50',1000,9000],['50',1000,9000]]);
 expect(()=>mixedFunding(spec,'100',[routes[0],routes[0]],'USD')).toThrow('distinct');
});
function fixture(){
 const now=Date.parse('2026-10-13T12:00:00Z');
 const context:MixedPreviewContext={takeId:randomUUID(),versionId:randomUUID(),routeRevision:randomUUID(),spec,routes,evidence:'initial',usdcUsdRate:'1',rateObservedAt:now};
 const saved=new Map<string,Awaited<ReturnType<MixedPreviewStore['find']>>>();let calls=0,mutate:((p:MixedLegPreview)=>MixedLegPreview)|undefined,loadCount=0;
 const load=async()=>{loadCount++;return {...context};};
 const store:MixedPreviewStore={find:async id=>saved.get(id)??null,save:async(id,requestHash,preview)=>{saved.set(id,{requestHash,preview});return preview;}};
 const preview=createMixedPreview({clock:()=>now,load,store,preview:async leg=>{calls++;const p:MixedLegPreview={venue:leg.venue,accountId:leg.accountId,currency:leg.currency,quantity:leg.quantity,state:leg.venue==='robinhood'?'waiting_market':'ready',reason:null,orders:[{symbol:leg.weights[0].instrument.symbol,side:'buy',notional:leg.quantity,fee:'0'}],retainedCash:'0',available:'1000',expiresAt:new Date(now+30000).toISOString(),evidence:'provider-evidence'};return mutate?mutate(p):p;}});
 const request={takeId:context.takeId,versionId:context.versionId,routeRevision:context.routeRevision,operationId:randomUUID(),amountUsd:'100',coinbaseCurrency:'USDC' as const};
 return {context,preview,request,saved,calls:()=>calls,mutate:(fn:typeof mutate)=>{mutate=fn;}};
}
test('one read-only preview tracks both venues and closed-market waiting; retries coalesce',async()=>{
 const f=fixture();const [a,b]=await Promise.all([f.preview(f.request),f.preview(f.request)]);
 expect(a).toEqual(b);expect(a).toMatchObject({state:'waiting_market',executionEnabled:false});expect(f.calls()).toBe(2);
 expect(await f.preview(f.request)).toEqual(a);expect(f.calls()).toBe(2);
 await expect(f.preview({...f.request,amountUsd:'99'})).rejects.toThrow('Operation ID');
});
test('stale rate, route mismatch, and changed account evidence fail before saving',async()=>{
 const f=fixture();await expect(f.preview({...f.request,routeRevision:randomUUID()})).rejects.toThrow('changed');expect(f.calls()).toBe(0);
 f.context.rateObservedAt=0;await expect(f.preview(f.request)).rejects.toThrow('stale');
 f.context.rateObservedAt=Date.parse('2026-10-13T12:00:00Z');f.mutate(p=>{f.context.evidence='changed';return p;});
 await expect(f.preview(f.request)).rejects.toThrow('changed during');expect(f.saved.size).toBe(0);
});
test('overspending, wrong account, and unexpected assets cannot become ready',async()=>{
 for(const mutation of [(p:MixedLegPreview)=>({...p,available:'0'}),(p:MixedLegPreview)=>({...p,accountId:randomUUID()}),(p:MixedLegPreview)=>({...p,orders:p.orders.map(o=>({...o,symbol:'WRONG'}))}),(p:MixedLegPreview)=>({...p,orders:p.orders.map(o=>({...o,fee:'1'}))})]){
  const f=fixture();f.mutate(mutation);await expect(f.preview(f.request)).rejects.toThrow();expect(f.saved.size).toBe(0);
 }
});


test('funding errors distinguish an account shortfall from a preview calculation mismatch',async()=>{
 const short=fixture();short.mutate(p=>({...p,available:'2'}));
 await expect(short.preview(short.request)).rejects.toThrow('Coinbase cannot fund its part of this deposit: 70 USDC is needed, but only 2 USDC is available');
 const mismatch=fixture();mismatch.mutate(p=>p.venue==='robinhood'?{...p,existingCash:'0.0001913079'}:p);
 await expect(mismatch.preview(mismatch.request)).rejects.toThrow('Robinhood’s deposit preview does not balance. New deposit: 30 USD; cash already in this Take: 0.0001913079 USD. Buys, fees, and cash left over total 30 USD — 0.0001913079 USD less than the available 30.0001913079 USD.');
 expect(short.saved.size).toBe(0);expect(mismatch.saved.size).toBe(0);
});
