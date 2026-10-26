import {expect,test} from 'vitest';
import {planFirstInvestment,robinhoodPreviewRules, type PreviewEvidence} from '../../../src/main/planning/first-investment';
const now='2026-10-03T14:00:00.000Z';
const request={accountId:'00000000-0000-4000-8000-000000000001',strategyId:'00000000-0000-4000-8000-000000000002',versionId:'00000000-0000-4000-8000-000000000003',amount:'100'};
const spec={schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:3333},{instrument:{venue:'robinhood',symbol:'BND'},bps:3333},{instrument:{venue:'robinhood',symbol:'VXUS'},bps:3334}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
const evidence:PreviewEvidence={accountId:request.accountId,venue:'robinhood',observedAt:now,instruments:['VTI','VXUS','BND'].map(symbol=>({symbol,instrumentRef:`ref-${symbol}`,markPriceUsd:'10',tradable:true,fractional:true}))};
const input={request,spec,evidence,availableCashUsd:'1000',now,rules:robinhoodPreviewRules('1000')};
test('cash-only first investment conserves cents with stable identity independent of input order',()=>{
 const p=planFirstInvestment(input);
 expect(p).toMatchObject({disposition:'planned',totalBuyUsd:'100',remainingCashUsd:'0',canFund:true,targetBasis:'committed'});
 expect(p.sleeves.map(r=>r.dollarAmount)).toEqual(['33.33','33.33','33.34']);
 expect(planFirstInvestment({...input,spec:{...spec,target:{...spec.target,weights:[...spec.target.weights].reverse()}},evidence:{...evidence,instruments:[...evidence.instruments].reverse()}})).toEqual(p);
 expect(JSON.parse(JSON.stringify(p))).toEqual(p);
 expect(planFirstInvestment({...input,request:{...request,amount:'101'}}).previewHash).not.toBe(p.previewHash);
});
test('cash targets and skipped small holdings stay cash without copy-trading floor or redistribution',()=>{
 const p=planFirstInvestment({...input,spec:{...spec,target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:8999},{instrument:{venue:'robinhood',symbol:'BND'},bps:1}],cashBps:1000}}});
 expect(p).toMatchObject({disposition:'planned',totalBuyUsd:'89.99',remainingCashUsd:'10.01',targetCashUsd:'10'});
 expect(p.sleeves[0]).toMatchObject({disposition:'skip',reason:'below_minimum_order',dollarAmount:null});
});
test('freshness, account identity, evidence completeness and venue are explicit',()=>{
 for (const patch of [{observedAt:'2026-10-03T13:00:00.000Z'},{observedAt:'2026-10-03T15:00:00.000Z'},{accountId:request.strategyId},{venue:'another'},{instruments:[evidence.instruments[0],evidence.instruments[0]]}])
  expect(()=>planFirstInvestment({...input,evidence:{...evidence,...patch}})).toThrow();
 expect(planFirstInvestment({...input,evidence:{...evidence,instruments:[]}}).sleeves.every(r=>r.reason==='missing_instrument_evidence')).toBe(true);
 const foreign=planFirstInvestment({...input,spec:{...spec,target:{weights:[{instrument:{venue:'other',symbol:'VTI'},bps:10000}],cashBps:0}}});
 expect(foreign.sleeves[0].reason).toBe('unsupported_venue');
});
test('unknown, blocked, whole-share-only and missing marks cannot appear as ready',()=>{
 for (const [patch,reason] of [[{tradable:false},'symbol_not_tradable'],[{tradable:null},'unknown_tradability'],[{fractional:false},'whole_share_sizing_unavailable'],[{fractional:null},'unknown_fractional_sizing'],[{markPriceUsd:null},'missing_mark_price']] as const){
  const p=planFirstInvestment({...input,evidence:{...evidence,instruments:evidence.instruments.map(row=>({...row,...patch}))}});
  expect(p.disposition).toBe('deferred');expect(p.sleeves.every(row=>row.reason===reason&&row.dollarAmount===null)).toBe(true);
 }
});
test('explicit venue minimum, cash limits and cent validation',()=>{
 expect(planFirstInvestment({...input,availableCashUsd:'99'})).toMatchObject({canFund:false,disposition:'deferred'});
 expect(planFirstInvestment({...input,rules:{...input.rules,minimumOrderNotionalUsd:'40'}})).toMatchObject({disposition:'no_orders',totalBuyUsd:'0',remainingCashUsd:'100'});
 expect(()=>planFirstInvestment({...input,request:{...request,amount:'1.001'}})).toThrow();
 // A cent returned by conservation must still respect the explicit order limit.
 const p=planFirstInvestment({...input,request:{...request,amount:'100.02'},rules:robinhoodPreviewRules('33.346668')});
 expect(p.sleeves.some(row=>row.reason==='order_notional_limit')).toBe(true);
 expect(p.sleeves.every(row=>row.dollarAmount===null||Number(row.dollarAmount)<=33.346668)).toBe(true);
});

test('explicit crypto cannot borrow a same-symbol equity sizing quote',()=>{
 const crypto={venue:'robinhood',symbol:'VTI',market:{venue:'robinhood',instance:'production',kind:'crypto',reference:'synthetic-pair'}};
 expect(()=>planFirstInvestment({...input,spec:{...spec,target:{weights:[{instrument:crypto,bps:10000}],cashBps:0}}})).toThrow('research-only');
});
