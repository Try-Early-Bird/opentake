import {expect,test} from 'vitest';
import {normalizeCryptoFillSnapshot as normalize,cryptoFillDelta as delta} from '../../../src/main/orders/crypto-fill-accounting';
const at='2026-10-15T14:00:00Z',later='2026-10-15T14:01:00Z';
const expected={orderRef:'order',pairId:'btc-pair',side:'buy' as 'buy'|'sell',clientRefs:['client','approval']};
const fill={id:'fill-1',quantity:'0.001',price:'50000',effective_price:'50100',notional:'50.10',timestamp:at};
const raw={id:'order',ref_id:'client',currency_pair_id:'btc-pair',side:'buy',state:'partially_filled',quantity:'0.002',cumulative_quantity:'0.001',updated_at:at,
 net_rounded_executed_notional:'50.10',fee:'0.10',executions:[fill]};
test('partial fills use net cash once; replay and later completion produce only new deltas',()=>{
 const first=normalize(raw,expected);expect(delta(null,first)).toMatchObject({quantityDelta:'0.001',cashDelta:'-50.1',terminal:false});
 expect(delta(first,first)).toMatchObject({quantityDelta:'0',cashDelta:'0',changed:false});
 const second=normalize({...raw,state:'filled',cumulative_quantity:'0.002',updated_at:later,net_rounded_executed_notional:'100.25',fee:'0.25',
  executions:[fill,{...fill,id:'fill-2',effective_price:'50150',notional:'50.15',timestamp:later}]},expected);
 expect(delta(first,second)).toMatchObject({quantityDelta:'0.001',cashDelta:'-50.15',terminal:true});
});
test('sell proceeds already net fees and withholding, with no duplicate deduction',()=>{
 const sale=normalize({...raw,side:'sell',net_rounded_executed_notional:'37.90',tax_withholding:{total_withholding_amount:'12',estimated_withholding_amount:null}}, {...expected,side:'sell'});
 expect(delta(null,sale)).toMatchObject({quantityDelta:'-0.001',cashDelta:'37.9'});expect(sale.withholding).toBe('12');
});
test('cancel after a partial fill preserves the filled cash; unfilled cancel books zero',()=>{
 const first=normalize(raw,expected),cancel=normalize({...raw,state:'canceled',updated_at:later},expected);
 expect(delta(first,cancel)).toMatchObject({quantityDelta:'0',cashDelta:'0',terminal:true});
 const empty=normalize({...raw,state:'canceled',cumulative_quantity:'0',net_rounded_executed_notional:null,executions:[],fee:'0.10'},expected);
 expect(delta(null,empty)).toMatchObject({quantityDelta:'0',cashDelta:'0',terminal:true});expect(empty.fee).toBeNull();
});
test('missing net cash cannot be replaced with gross notional or an estimated total',()=>{
 expect(()=>normalize({...raw,net_rounded_executed_notional:null,rounded_executed_notional:'50',net_rounded_estimated_notional:'50.10'},expected)).toThrow('net cash');
 expect(()=>normalize({...raw,tax_withholding:{estimated_withholding_amount:'12'}},expected)).toThrow('Actual withholding');
});
test.each([{currency_pair_id:'other'},{side:'sell'},{ref_id:'other'},{speculative:true},{id:'other'}])('rejects mismatched fill scope %j',patch=>{
 expect(()=>normalize({...raw,...patch},expected)).toThrow('identity');
});
test('missing, duplicate, overfilled and inconsistent execution lists cannot be booked',()=>{
 for(const patch of [{executions:[]},{executions:[fill,fill]},{cumulative_quantity:'0.003'},
  {state:'filled'},{executions:[{...fill,timestamp:later}]}])expect(()=>normalize({...raw,...patch},expected)).toThrow();
});
test('execution revisions, stale snapshots and decreasing totals require reconciliation',()=>{
 const first=normalize(raw,expected);
 for(const patch of [{updated_at:'2026-10-15T13:59:00Z'},
  {updated_at:later,executions:[{...fill,notional:'49'}]},
  {updated_at:later,net_rounded_executed_notional:'49'},
  {net_rounded_executed_notional:'50.20'}])expect(()=>delta(first,normalize({...raw,...patch},expected))).toThrow();
});
test('terminal evidence cannot reopen or change financial amounts silently',()=>{
 const closed=normalize({...raw,state:'canceled'},expected);
 expect(()=>delta(closed,normalize({...raw,updated_at:later},expected))).toThrow('Terminal');
});
test('decimal normalization makes equivalent observations idempotent without floating point',()=>{
 const first=normalize(raw,expected),same=normalize({...raw,quantity:'0.0020',net_rounded_executed_notional:'50.100',executions:[{...fill,quantity:'0.0010'}]},expected);
 expect(delta(first,same)).toMatchObject({quantityDelta:'0',cashDelta:'0',changed:false});
});
