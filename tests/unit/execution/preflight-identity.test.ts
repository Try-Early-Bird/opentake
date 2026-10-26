import {expect,test} from 'vitest';
import {preflightSubscription} from '../../../src/main/execution/preflight';
import {instrumentKey} from '../../../src/shared/strategies';
const stock=instrumentKey({venue:'robinhood',symbol:'BTC-USD'});
const crypto=instrumentKey({venue:'robinhood',symbol:'BTC-USD',market:{venue:'robinhood',instance:'production',kind:'crypto',reference:'pair-btc'}});
const weights=[{symbol:'BTC-USD',instrumentRef:stock,weightPercent:50},{symbol:'BTC-USD',instrumentRef:crypto,weightPercent:50}];
const base={amountUsd:'100',weights,cashPercent:0,modelValuedOn:null,expectedValuedOn:null,instrumentPolicy:null};
test('same ticker contribution sizes each exact holding independently',()=>{
 const result=preflightSubscription({...base,currentValuesUsd:{[stock]:'90',[crypto]:'10'}});
 expect(result.ok).toBe(true);
 expect(result.legs).toEqual([{...weights[0],notionalUsd:'10'},{...weights[1],notionalUsd:'90'}]);
 const onlyCrypto=preflightSubscription({...base,amountUsd:'100',currentValuesUsd:{[stock]:'150',[crypto]:'50'}});
 expect(onlyCrypto.legs).toEqual([{...weights[1],notionalUsd:'100'}]);
});
test('first purchase preserves identities and policy never falls back to shared ticker',()=>{
 const result=preflightSubscription({...base,instrumentPolicy:{symbols:{[crypto]:{tradable:false,fractional:true},'BTC-USD':{tradable:false,fractional:false}}}});
 expect(result.legs).toEqual(weights.map(w=>({...w,notionalUsd:'50'})));
 expect(result.reasons).toEqual([{code:'symbol_not_tradable',symbols:['BTC-USD']}]);
});
test('ticker block preferences still apply to exact-identity targets',()=>{
 expect(preflightSubscription({...base,blockedSymbols:['btc-usd']}).reasons.some(r=>r.code==='symbol_blocked')).toBe(true);
});
