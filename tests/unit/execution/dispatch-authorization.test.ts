// The core's dispatch policy as a pure function over the evidence a venue supplies.
import {expect,test} from 'vitest';
import {dispatchAuthorization,DispatchRefused,withinApproved} from '../../../src/main/execution/dispatch-authorization';
import type {ActionJob} from '../../../src/main/venues/types';

const job={id:'j',kind:'buy',origin:'rule',originId:'r',takeId:'t',accountId:'a',venue:'fake',input:{},state:'running',waitingFor:null,reason:null,attempts:0,adapterState:{},createdAt:new Date(),updatedAt:new Date(),startedAt:new Date()} as ActionJob;
const order=(amountUsd:string|null,symbol='VTI',side:'buy'|'sell'='buy')=>({symbol,side,amountUsd});

test('approval tolerance: ten percent or one dollar per order, same symbol and side, no new orders',()=>{
 expect(withinApproved([order('11')],[order('10')])).toBe(true);
 expect(withinApproved([order('11.01')],[order('10')])).toBe(false);
 expect(withinApproved([order('1.99')],[order('1')])).toBe(true);
 expect(withinApproved([order('2.01')],[order('1')])).toBe(false);
 expect(withinApproved([order('5')],[order('10')])).toBe(true);
 expect(withinApproved([order('10','VTI','sell')],[order('10')])).toBe(false);
 expect(withinApproved([order('10'),order('1','BND')],[order('10')])).toBe(false);
 expect(withinApproved([order(null)],[order('10')])).toBe(false);
 expect(withinApproved([],[order('10')])).toBe(true);
});

test('the dispatch check re-reads the grant as started, then approval, then limits, and refuses with the first reason',async()=>{
 const refuse=dispatchAuthorization(async(_,started)=>({admitted:false,reason:started?'trading_not_granted':'request_expired'}));
 await expect(refuse({job,orders:[order('10')]})).rejects.toMatchObject({name:'DispatchRefused',reason:'trading_not_granted'});
 const admit=dispatchAuthorization(async()=>({admitted:true}));
 await expect(admit({job,orders:[order('10')]})).resolves.toBeUndefined();
 await expect(admit({job,orders:[order('10')],approved:[order('5')]})).rejects.toBeInstanceOf(DispatchRefused);
 await expect(admit({job,orders:[order('10')],approved:[order('9.5')]})).resolves.toBeUndefined();
 await expect(admit({job,orders:[order('10')],risk:{currency:'USD',maxDailyNotional:'100',placedToday:'95',planned:'10'}})).rejects.toMatchObject({reason:'daily_notional_limit'});
 await expect(admit({job,orders:[order('10')],risk:{currency:'USD',maxDailyNotional:'100',placedToday:'90',planned:'10'}})).resolves.toBeUndefined();
 await expect(admit({job,orders:[order('10')],risk:{currency:'USD',maxLoss:'5',capital:'100',value:'90'}})).rejects.toMatchObject({reason:'loss_limit_reached'});
});
