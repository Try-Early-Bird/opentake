import { expect,test,vi } from 'vitest';
import { basketSchema } from '../../../src/shared/strategies';
import { parseHoldingsList, parseHoldingsTable, parseDelimitedHoldings, splitWeightsEvenly, scaleWeightsTo, percentToBps, raiseSmallestTo } from '../../../src/shared/basket-editor';
import { outOfBand, scheduledRebalanceDays } from '../../../src/shared/basket-rebalance';
import { normalizeTradability } from '../../../src/main/strategies/tradability';
import { createBasketVerification } from '../../../src/main/strategies/verification';
import { ConnectionFailure } from '../../../src/main/connection-errors';
const spec={schemaVersion:1 as const,kind:'basket' as const,target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0},rebalance:{schedule:'never' as const,driftBandPoints:null,driftBandRelative:null}};
test('one holding is valid, exact totals, venues, canonical identities and unsupported rules are enforced',()=>{
 expect(basketSchema.parse(spec)).toEqual(spec);
 expect(basketSchema.safeParse({...spec,target:{...spec.target,cashBps:1}}).success).toBe(false);
 expect(basketSchema.safeParse({...spec,condition:{price:100}}).success).toBe(false);
 expect(basketSchema.safeParse({...spec,rebalance:{...spec.rebalance,schedule:'daily'}}).success).toBe(true);
 expect(basketSchema.safeParse({...spec,rebalance:{...spec.rebalance,schedule:'minute'}}).success).toBe(false);
 expect(basketSchema.safeParse({...spec,target:{weights:['BRK-B','BRK.B'].map(symbol=>({instrument:{venue:'robinhood',symbol},bps:5000})),cashBps:0}}).success).toBe(false);
 expect(basketSchema.parse({...spec,target:{weights:['robinhood','other'].map(venue=>({instrument:{venue,symbol:'VTI'},bps:5000})),cashBps:0}}).target.weights).toHaveLength(2);
});
test('ported allocation imports and balancing preserve exact basis points',()=>{
 expect(parseHoldingsList('BRK-B 50\nVTI 50\nVTI 25')).toEqual([{symbol:'BRK.B',weight:'50'},{symbol:'VTI',weight:'50'}]);
 expect(parseHoldingsTable([['Symbol','Weight'],['VTI','12.345%']])).toEqual([{symbol:'VTI',weight:'12.35'}]);
 const rows=['A','B','C'].map(symbol=>({venue:'robinhood',symbol,weight:'1',reason:''}));
 expect(splitWeightsEvenly(rows,10000).map(r=>r.weight)).toEqual(['33.34','33.33','33.33']);
 expect(scaleWeightsTo(rows,9000).reduce((n,r)=>n+percentToBps(r.weight)!,0)).toBe(9000);
});
test('calendar boundaries and strict drift bands match the port without starting jobs',()=>{
 const days=['2026-12-31','2027-01-04','2027-01-05','2027-02-01','2027-04-01'];
 expect([...scheduledRebalanceDays(days,'daily')]).toEqual(days.slice(1));
 expect([...scheduledRebalanceDays(days,'monthly')]).toEqual(['2027-01-04','2027-02-01','2027-04-01']);
 expect([...scheduledRebalanceDays(days,'quarterly')]).toEqual(['2027-01-04','2027-04-01']);expect([...scheduledRebalanceDays(days,'annual')]).toEqual(['2027-01-04']);expect([...scheduledRebalanceDays(days,'never')]).toEqual([]);
 expect(outOfBand(55,50,{driftBandPoints:5,driftBandRelative:null})).toBe(false);expect(outOfBand(55.01,50,{driftBandPoints:5,driftBandRelative:null})).toBe(true);expect(outOfBand(1,0,{driftBandPoints:null,driftBandRelative:10})).toBe(false);
});
test('personal eligibility keeps missing facts and whole-share limits unknown; venue failures do not forbid commits',async()=>{
 const readTool=vi.fn(async()=>({data:[{symbol:'VTI',tradeable:true,fractional_tradability:'tradable'},{symbol:'WHOLE',tradeable:true,fractional:false},{symbol:'BLOCK',tradeable:false}]}));
 const status=vi.fn(async()=>({status:'connected' as const,checkedAt:null,accounts:[{id:'synthetic',maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}));
 const verify=createBasketVerification({readTool,status});
 const basket={...spec,target:{weights:['VTI','WHOLE','BLOCK','MISSING'].map(symbol=>({instrument:{venue:'robinhood',symbol},bps:2500})),cashBps:0}};
 expect((await verify(basket)).results.map(r=>r.state)).toEqual(['pass','unknown','blocked','unknown']);
 readTool.mockRejectedValue(new Error('synthetic secret'));expect(JSON.stringify(await verify(spec))).not.toContain('synthetic secret');expect((await verify(spec)).results[0].state).toBe('unknown');
 expect((await verify({...spec,target:{...spec.target,weights:[{instrument:{venue:'other',symbol:'VTI'},bps:10000}]}})).results[0].state).toBe('unknown');
});

test('raising the smallest weight takes the difference from the larger holdings and keeps the total exact',()=>{
 const raised=raiseSmallestTo([{s:'A',bps:6000},{s:'B',bps:3000},{s:'C',bps:500}],2000)!;
 expect(raised.map(w=>w.bps)).toEqual([4800,2700,2000]);expect(raised.reduce((n,w)=>n+w.bps,0)).toBe(9500);
 expect(raised.every(w=>w.bps>=2000)).toBe(true);
 expect(raiseSmallestTo([{bps:5000},{bps:4000}],5000)).toBeNull();
 expect(raiseSmallestTo([{bps:6000},{bps:4000}],1000)!.map(w=>w.bps)).toEqual([6000,4000]);
});

test('tradeability verification awaits the queued venue read',async()=>{
 const status=vi.fn().mockResolvedValue({status:'connected',accounts:[{id:'account',selected:true,agenticAllowed:true,accountType:'cash'}]});
 const readTool=vi.fn().mockResolvedValue([{symbol:'VTI',tradeable:true,fractional:true}]);
 const result=await createBasketVerification({readTool,status},()=>0)(spec);
 expect(readTool).toHaveBeenCalledTimes(1);expect(result.results[0].state).toBe('pass');
});

test('venue identity and account-type eligibility do not borrow another venue or account verdict',()=>{
 expect(parseHoldingsList('BRK-B 100','other')[0].symbol).toBe('BRK-B');
 expect(parseHoldingsTable(parseDelimitedHoldings('Symbol,Name,Weight\nVTI,"A, B",100'))).toEqual([{symbol:'VTI',weight:'100'}]);
 const facts=[{symbol:'VTI',tradeable:true,fractional:true,account_type_tradabilities:[{account_type:'cash',tradability:'tradable'},{account_type:'margin',tradability:'untradable'}]}];
 expect(normalizeTradability(facts,['VTI'],'cash')[0].tradable).toBe(true);
 expect(normalizeTradability(facts,['VTI'],'margin')[0].tradable).toBe(false);
 expect(normalizeTradability(facts,['VTI'],'unknown')[0].tradable).toBeNull();
});

test('a limited-margin account reads Robinhood’s individual-type tradability (live SPY reply, 2026-10-05)',()=>{
 const reply={data:{results:[{symbol:'SPY',state:'active',tradeable:true,fractional_tradability:'tradable',account_type_tradabilities:[{account_type:'individual',account_type_tradability:'tradable'}]}]}};
 expect(normalizeTradability(reply,['SPY'],'limited_margin')).toMatchObject([{symbol:'SPY',tradable:true,fractional:true}]);
 // Conflicting entries for other types still stay unknown.
 const conflicting={results:[{symbol:'X',tradeable:true,fractional_tradability:'tradable',account_type_tradabilities:[{account_type:'individual',account_type_tradability:'tradable'},{account_type:'ira',account_type_tradability:'untradable'}]}]};
 expect(normalizeTradability(conflicting,['X'],'limited_margin')[0]?.tradable).toBeNull();
});
