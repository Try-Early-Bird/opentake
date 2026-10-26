import {expect,test} from 'vitest';
import {dispatchOrder,type SubmissionResult} from '../../../src/main/trading/dispatch';
import {recoverOrder} from '../../../src/main/trading/recovery';
import {basketEligibility,blockedAssetEligibility,reviewEligibility} from '../../../src/main/trading/eligibility';
import {normalizeOrderState} from '../../../src/shared/trading';

for(const venue of ['robinhood','coinbase'] as const){
 test(`${venue} dispatch claims before sending and stops after uncertainty`,async()=>{
  const events:string[]=[];let claimed=false;
  const journal={claim:async()=>{if(claimed)throw Error('Already attempted');claimed=true;events.push('claim');},record:async(_result:SubmissionResult)=>{events.push('record');},unknown:async(code:string)=>{events.push(code);}};
  const adapter={send:async(before:()=>Promise<void>)=>{await before();events.push('send');throw Error('Socket lost');}};
  expect(await dispatchOrder(adapter,journal)).toEqual({state:'unknown',code:'transport_error'});
  await expect(dispatchOrder(adapter,journal)).rejects.toThrow('Already attempted');
  expect(events).toEqual(['claim','send','transport_error']);
 });
}
test('provider permission failure before claim leaves no durable attempt',async()=>{
 let claims=0,unknown=0;
 await expect(dispatchOrder({send:async()=>{throw Error('Permission revoked');}},{claim:async()=>{claims++;},record:async()=>{},unknown:async()=>{unknown++;}})).rejects.toThrow('revoked');
 expect(claims).toBe(0);expect(unknown).toBe(0);
});
test('failed acceptance persistence stays uncertain and never re-enters the transport',async()=>{
 let sends=0;const codes:string[]=[];
 const result=await dispatchOrder({send:async before=>{await before();sends++;return {state:'accepted',providerRef:'one'};}},{claim:async()=>{},record:async()=>{throw Error('Disk unavailable');},unknown:async code=>{codes.push(code);}});
 expect(result.state).toBe('unknown');expect(codes).toEqual(['persistence_error']);expect(sends).toBe(1);
});
test('definitive rejection and provider uncertainty keep their classifications',async()=>{
 for(const response of [{state:'rejected',code:'invalid'},{state:'unknown',code:'provider_unknown'}] as const){
  const recorded:SubmissionResult[]=[];
  expect(await dispatchOrder({send:async before=>{await before();return response;}},{claim:async()=>{},record:async result=>{recorded.push(result);},unknown:async()=>{throw Error('Unexpected');}})).toEqual(response);
  expect(recorded).toEqual([response]);
 }
});
test('recovery uses account, venue and client identity; absence and duplicate matches never invent an outcome',()=>{
 const identity={venue:'coinbase' as const,accountId:'account',clientRef:'client'},match={...identity,providerRef:'order'};
 expect(recoverOrder(identity,[{...match,venue:'robinhood'},{...match,accountId:'other'},{...match,clientRef:'other'}])).toBeNull();
 expect(recoverOrder(identity,[match])).toEqual(match);
 expect(()=>recoverOrder(identity,[match,{...match,providerRef:'second'}])).toThrow('Ambiguous');
});
test('common basket and review eligibility keeps provider units out of application policy',()=>{
 expect(basketEligibility(true,['BTC','ETH'],['BTC'])).toEqual({ok:false,reasons:[{code:'incomplete_basket',symbols:['ETH']}]});
 expect(basketEligibility(true,['VTI','BND'],['VTI','BND']).ok).toBe(true);
 expect(basketEligibility(false,['BTC','ETH'],['BTC']).ok).toBe(true);
 expect(blockedAssetEligibility(['BTC'],['btc']).ok).toBe(false);
 expect(reviewEligibility(false,100,50).reasons[0].code).toBe('trading_disabled');
 expect(reviewEligibility(true,100,100).reasons[0].code).toBe('review_expired');
 expect(reviewEligibility(true,100,99).ok).toBe(true);
});
test('both providers expose canonical states without treating acceptance or an unknown string as a fill',()=>{
 expect(normalizeOrderState('placed')).toBe('accepted');expect(normalizeOrderState('open')).toBe('accepted');
 expect(normalizeOrderState('placement_unknown')).toBe('unknown');expect(normalizeOrderState('new-provider-status')).toBe('unknown');
 expect(normalizeOrderState('CANCELED')).toBe('cancelled');expect(normalizeOrderState('PARTIALLY_FILLED')).toBe('partially_filled');
});
import {riskEligibility} from '../../../src/main/trading/risk';
import {createTradingService} from '../../../src/main/trading/service';
test('shared risk policy uses exact native quote units and requires evidence for configured limits',()=>{
 expect(riskEligibility({currency:'USD',maxDailyNotional:'10',placedToday:'9',planned:'1'}).ok).toBe(true);
 expect(riskEligibility({currency:'USDC',precision:36,maxDailyNotional:'10',placedToday:'9',planned:'1.000000000000000000000000000000000001'}).reasons[0].code).toBe('daily_notional_limit');
 expect(riskEligibility({currency:'USD',maxLoss:'5',capital:'100',value:'94'}).reasons[0].code).toBe('loss_limit_reached');
 expect(()=>riskEligibility({currency:'USDC',maxLoss:'5'})).toThrow('evidence');
});
test('application trading boundary dispatches only to the named broker and refuses unsupported actions',async()=>{
 const calls:string[]=[];
 const adapter=(venue:'robinhood'|'coinbase')=>({review:async()=>{calls.push(venue);return {venue:'coinbase' as const,review:null};},current:async()=>({venue:'coinbase' as const,review:null}),submit:async()=>({venue:'coinbase' as const,review:null}),refresh:async()=>({venue:'coinbase' as const,review:null})});
 const service=createTradingService({coinbase:adapter('coinbase'),robinhood:adapter('robinhood')});
 await service.execute({venue:'coinbase',action:'review',input:{}});expect(calls).toEqual(['coinbase']);
 await expect(service.execute({venue:'robinhood',action:'cancel',input:'11111111-1111-4111-8111-111111111111'})).rejects.toThrow('does not support');
 await expect(service.execute({venue:'robinhood',action:'review',input:{}})).rejects.toThrow('another venue');
 await expect(service.execute({venue:'coinbase',action:'submit',input:'bad-id'})).rejects.toThrow();
});

import {observedOrderState} from '../../../src/shared/trading';
test('cumulative fills distinguish partial orders without overriding terminal or uncertain evidence',()=>{
 expect(observedOrderState('open','0.001')).toBe('partially_filled');
 expect(observedOrderState('open','0.000')).toBe('accepted');
 expect(observedOrderState('filled','1')).toBe('filled');
 expect(observedOrderState('placement_unknown','1')).toBe('unknown');
 expect(observedOrderState('open','invalid')).toBe('accepted');
});
