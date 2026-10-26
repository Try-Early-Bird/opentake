import {expect,test} from 'vitest';
import {targetChange,rebalanceKeepers,keepersNote} from '../../src/main/strategies/rule-targets';

const btc={venue:'coinbase',instance:'production',kind:'crypto',reference:'BTC-USD'};
const spec={schemaVersion:1 as const,kind:'basket' as const,target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:6000}],cashBps:4000},rebalance:{schedule:'never' as const,driftBandPoints:null,driftBandRelative:null}};
const scope={accountId:'11111111-1111-4111-8111-111111111111'};

test('trim, exit and buy change the target between the asset and cash, never past 100%',()=>{
 const trim=targetChange(spec,{kind:'trim',scope,market:btc,toWeightBps:3000});
 expect(trim).toMatchObject({ok:true,summary:'BTC 60% → 30% (to cash)',spec:{target:{weights:[{bps:3000}],cashBps:7000}}});
 expect(targetChange(spec,{kind:'trim',scope,market:btc,toWeightBps:7000})).toEqual({ok:false,reason:'already_there'});
 expect(targetChange(spec,{kind:'exit',scope,market:btc})).toEqual({ok:false,reason:'all_cash'});
 expect(targetChange(spec,{kind:'exit',scope})).toEqual({ok:false,reason:'all_cash'});
 expect(targetChange(spec,{kind:'buy',scope,market:btc,amount:{kind:'scope_bps',value:1000}})).toMatchObject({ok:true,summary:'BTC 60% → 70% (from cash)'});
 expect(targetChange(spec,{kind:'buy',scope,market:btc,amount:{kind:'notional',value:'25',currency:'USD'}},100)).toMatchObject({ok:true,spec:{target:{weights:[{bps:8500}],cashBps:1500}}});
 expect(targetChange(spec,{kind:'buy',scope,market:btc,amount:{kind:'notional',value:'25',currency:'USD'}},null)).toEqual({ok:false,reason:'value_unavailable'});
 expect(targetChange(spec,{kind:'buy',scope,market:btc,amount:{kind:'scope_bps',value:5000}})).toEqual({ok:false,reason:'not_enough_cash'});
 expect(targetChange(spec,{kind:'buy',scope,market:btc,amount:{kind:'quantity',value:'1'}})).toEqual({ok:false,reason:'amount_unsupported'});
 const eth=targetChange(spec,{kind:'buy',scope,market:{...btc,reference:'ETH-USD'},amount:{kind:'scope_bps',value:500}});
 expect(eth).toMatchObject({ok:true,summary:'ETH 0% → 5% (from cash)',spec:{target:{weights:[{bps:6000},{instrument:{venue:'coinbase',symbol:'ETH'},bps:500}],cashBps:3500}}});
 expect(spec.target.cashBps).toBe(4000);
});

test('what keeps a Take at its target: calendar, drift band and rebalance rules that are on',()=>{
 const rules=[{name:'Rebalance to 60/40',on:true,action:{kind:'rebalance_to_target' as const,scope}},{name:'Paused',on:false,action:{kind:'rebalance_to_target' as const,scope}},{name:'Alert',on:true,action:{kind:'notify' as const,message:'x'}}];
 expect(rebalanceKeepers(spec,rules)).toEqual(['rule “Rebalance to 60/40”']);
 expect(rebalanceKeepers({...spec,rebalance:{schedule:'monthly',driftBandPoints:5,driftBandRelative:null}},[])).toEqual(['the monthly rebalance','the drift band']);
 expect(keepersNote([])).toContain('does not rebalance by itself');
});
