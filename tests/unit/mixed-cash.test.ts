import {expect,test} from 'vitest';
import {mixedCash} from '../../src/renderer/src/strategies/MixedCashSummary';
import type {MixedExecution} from '../../src/shared/mixed-execution';
const run={legs:[{venue:'coinbase',accountId:'cb'},{venue:'robinhood',accountId:'rh'}]} as MixedExecution;
test('cash rolls up converted values rather than raw currency quantities',()=>{
 const result=mixedCash(run,{coinbase:{value:'7',currency:'USD',positions:[],cash:[{currency:'USDC',quantity:'0.1',reserved:'0',value:'0.099'}]},robinhood:{value:'3',currency:'USD',positions:[],cash:[{currency:'USD',quantity:'3',reserved:null,value:'3'}]}});
 expect(result.value).toBeCloseTo(3.099);expect(result.rows).toHaveLength(2);expect(result.rows[0].reserved).toBe('0');expect(result.rows[1].reserved).toBeNull();
});
test('cash does not invent zero for missing account data or a missing valuation',()=>{
 expect(mixedCash(run,{}).value).toBeNull();
 expect(mixedCash(run,{coinbase:{value:null,currency:'USD',positions:[],cash:[{currency:'USDC',value:null}]},robinhood:{value:'0',currency:'USD',positions:[],cash:[]}}).value).toBeNull();
 expect(mixedCash(run,{coinbase:{value:'0',currency:'USD',positions:[],cash:[]},robinhood:{value:'0',currency:'USD',positions:[],cash:[]}}).value).toBe(0);
});

test('cash details distinguish queued buying budgets from unknown order reservations',async()=>{
 const {cashHeldValue}=await import('../../src/renderer/src/strategies/MixedCashSummary');
 const queued={...run,legs:run.legs.map(l=>({...l,state:'waiting_market' as const}))};
 const result=mixedCash(queued,{robinhood:{value:'3',currency:'USD',positions:[],cash:[{currency:'USD',quantity:'3',reserved:null,value:'3'}],pendingBuys:[{symbol:'AAPL',amount:'3',expectedAt:null}]}});
 expect(cashHeldValue(result.rows[0])).toBe(3);
 expect(cashHeldValue({...result.rows[0],state:'pending'})).toBeNull();
 expect(cashHeldValue({...result.rows[0],reserved:'1'})).toBe(1);
 expect(cashHeldValue({...result.rows[0],reserved:'0'})).toBe(0);
 expect(cashHeldValue({...result.rows[0],value:null})).toBeNull();
});
