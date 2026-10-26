import {expect,test} from 'vitest';
import {allocationBelowMinimum,dailyNotionalExceeded,lossLimitReached,minimumAllocationFor} from '../../../src/main/execution/limits';
import {preflightSubscription} from '../../../src/main/execution/preflight';

test('the follower floor clears every leg with 2x headroom, in whole dollars',()=>{
 expect(minimumAllocationFor([{symbol:'A',weightPercent:60},{symbol:'B',weightPercent:40}])).toBe('5');
 expect(minimumAllocationFor([{symbol:'A',weightPercent:97},{symbol:'B',weightPercent:3}])).toBe('67');
 expect(allocationBelowMinimum('4',[{symbol:'A',weightPercent:60},{symbol:'B',weightPercent:40}])).toEqual({minimum:'5',below:true});
 expect(dailyNotionalExceeded(null,'100','100')).toBe(false);
 expect(dailyNotionalExceeded('150','100','60')).toBe(true);
 expect(lossLimitReached('10','100','89')).toBe(true);
 expect(lossLimitReached('10','100','91')).toBe(false);
});

test('a deposit buys holdings up to their share of the larger allocation and never sells',()=>{
 const result=preflightSubscription({amountUsd:'20',weights:[{symbol:'A',weightPercent:50},{symbol:'B',weightPercent:50}],cashPercent:0,
  currentValuesUsd:{A:'70',B:'30'},modelValuedOn:null,expectedValuedOn:null,instrumentPolicy:{symbols:{B:{tradable:true,fractional:false}}},blockedSymbols:['a']});
 // Enlarged to 120: A is already over 60, so only B is bought, by 30.
 expect(result.legs).toEqual([{symbol:'B',weightPercent:50,notionalUsd:'30'}]);
 expect(result.reasons.map(r=>r.code)).toEqual(['symbol_not_fractional','symbol_blocked']);
 expect(preflightSubscription({amountUsd:'10',weights:[{symbol:'A',weightPercent:100}],cashPercent:0,modelValuedOn:'2026-10-01',expectedValuedOn:'2026-10-02',instrumentPolicy:null}).reasons)
  .toEqual([{code:'model_stale',symbols:[]}]);
});
