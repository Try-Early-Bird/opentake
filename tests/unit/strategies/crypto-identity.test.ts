import {expect,test,vi} from 'vitest';
import {basketSchema,instrumentSchema,instrumentKey,proposalPayloadSchema,supportsBasketExecution,assertInstrumentExecution} from '../../../src/shared/strategies';
import {rowInstrument,splitWeightsEvenly,scaleWeightsTo} from '../../../src/shared/basket-editor';
import {createBasketVerification} from '../../../src/main/strategies/verification';
import {mixedFunding} from '../../../src/main/mixed-execution/funding';
import {executionBasket} from '../../../src/main/mixed-execution/basket';
const crypto={venue:'robinhood',symbol:'BTC',market:{venue:'robinhood',instance:'production',kind:'crypto',reference:'synthetic-btc-usd'}};
const legacy={venue:'robinhood',symbol:'BTC'};
const spec=basketSchema.parse({schemaVersion:1,kind:'basket',target:{weights:[{instrument:legacy,bps:5000},{instrument:crypto,bps:5000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}});

test('legacy equity identity is unchanged while same-ticker crypto uses provider reference',()=>{
 expect(instrumentSchema.parse({venue:'robinhood',symbol:'BRK-B'})).toEqual({venue:'robinhood',symbol:'BRK.B'});
 expect(instrumentKey(legacy)).toBe('robinhood:BTC');
 expect(new Set(spec.target.weights.map(w=>instrumentKey(w.instrument))).size).toBe(2);
 expect(instrumentSchema.parse({...crypto,symbol:'BTC-X'}).symbol).toBe('BTC-X');
 const same={...crypto,symbol:'RENAMED',market:{...crypto.market,pair:'different label'}};
 expect(instrumentKey(same)).toBe(instrumentKey(crypto));
 expect(basketSchema.safeParse({...spec,target:{weights:[{instrument:crypto,bps:5000},{instrument:same,bps:5000}],cashBps:0}}).success).toBe(false);
 expect(instrumentKey({...crypto,market:{...crypto.market,reference:'other-pair'}})).not.toBe(instrumentKey(crypto));
 for(const market of [{...crypto.market,reference:''},{...crypto.market,venue:'coinbase'},{...crypto.market,instance:'sandbox'},{...crypto.market,kind:'equity'}])expect(instrumentSchema.safeParse({...crypto,market}).success).toBe(false);
});

test('editing weights and explanations retains exact identity',()=>{
 const rows=spec.target.weights.map(w=>({...w.instrument,weight:'50',reason:w.instrument.market?'Crypto note':'Stock note'}));
 for(const edited of [splitWeightsEvenly(rows,10000),scaleWeightsTo(rows,9000)])expect(edited.map(rowInstrument)).toEqual(spec.target.weights.map(w=>w.instrument));
 expect(proposalPayloadSchema.parse({spec,metadata:{title:'Synthetic',description:'',rationale:'',holdings:rows.map(r=>({instrument:rowInstrument(r),reason:r.reason}))},unsupportedRequests:[]}).metadata.holdings.map(h=>h.reason)).toEqual(['Stock note','Crypto note']);
});

test('crypto never borrows same-ticker equity eligibility',async()=>{
 const readTool=vi.fn(async()=>[{symbol:'BTC',tradeable:true,fractional:true}]);
 const status=async()=>({status:'connected' as const,checkedAt:null,accounts:[{id:'synthetic',selected:true,agenticAllowed:true,accountType:'cash',maskedNumber:'fixture',nickname:null}]});
 const result=await createBasketVerification({status,readTool})(spec);
 expect(readTool).toHaveBeenCalledTimes(1);
 expect(result.results.map(r=>r.state)).toEqual(['pass','unknown']);
 expect(result.results[1]).toMatchObject({instrument:crypto,tradable:null,fractional:null});
 expect(result.results[1].reason).toContain('not ready');
 readTool.mockClear();await createBasketVerification({status,readTool})({...spec,target:{weights:[{instrument:crypto,bps:10000}],cashBps:0}});
 expect(readTool).not.toHaveBeenCalled();
});

test('research crypto cannot enter either funding sleeve or legacy execution',async()=>{
 expect(supportsBasketExecution(spec)).toBe(false);
 expect(()=>assertInstrumentExecution(spec)).toThrow('research-only');
 const query=vi.fn();
 for(const venue of ['robinhood','coinbase'] as const)await expect(executionBasket({query} as never,spec,{strategyId:'s',versionId:'v',accountId:'a'},venue)).rejects.toThrow('research-only');
 expect(query).not.toHaveBeenCalled();
 const mixed={...spec,target:{weights:[{instrument:crypto,bps:5000},{instrument:{venue:'coinbase',symbol:'BTC'},bps:5000}],cashBps:0}};
 expect(()=>mixedFunding(mixed,'100',[{venue:'robinhood',accountId:'rh'},{venue:'coinbase',accountId:'cb'}],'USD')).toThrow('research-only');
 expect(supportsBasketExecution({...spec,target:{weights:[{instrument:legacy,bps:10000}],cashBps:0}})).toBe(true);
});
