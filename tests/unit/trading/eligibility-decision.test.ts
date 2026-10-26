import {expect,test} from 'vitest';
import {evaluateEligibility,instrumentEligibility} from '../../../src/main/trading/eligibility';
import {productSchema} from '../../../src/main/coinbase/order-planner';

test('only explicit affirmative evidence for every requirement permits execution',()=>{
 expect(evaluateEligibility([])).toMatchObject({ok:false,state:'unknown'});
 for(const satisfied of [null,undefined,'true',1]){
  expect(evaluateEligibility([{code:'symbol_not_tradable',symbols:['BTC'],satisfied:satisfied as boolean|null}])).toMatchObject({ok:false,state:'unknown'});
 }
 expect(evaluateEligibility([{code:'symbol_not_tradable',symbols:['BTC'],satisfied:true}])).toEqual({ok:true,state:'eligible',reasons:[]});
});

test('known denials and unknown requirements are both retained with stable reason groups',()=>{
 const checks=[
  {code:'symbol_not_tradable' as const,symbols:['B','B'],satisfied:false},
  {code:'symbol_not_tradable' as const,symbols:['A'],satisfied:false},
  {code:'symbol_not_fractional' as const,symbols:['C'],satisfied:null},
 ];
 expect(evaluateEligibility(checks)).toEqual({ok:false,state:'blocked',reasons:[
  {code:'symbol_not_tradable',symbols:['A','B']},{code:'eligibility_unknown',symbols:['C']},
 ]});
 expect(checks[0].symbols).toEqual(['B','B']);
});

test('fractional sizing is required by the calling operation, not assumed from the venue',()=>{
 const facts={symbol:'VTI',tradable:true,fractional:false};
 expect(instrumentEligibility(facts,true)).toMatchObject({ok:false,reasons:[{code:'symbol_not_fractional'}]});
 expect(instrumentEligibility(facts,false).ok).toBe(true);
 expect(instrumentEligibility({...facts,fractional:null},true).state).toBe('unknown');
 expect(instrumentEligibility({...facts,tradable:false,fractional:null},true).state).toBe('blocked');
});

const product={product_id:'BTC-USD',base_currency_id:'BTC',quote_currency_id:'USD',product_type:'SPOT',
 price:'100',base_increment:'0.001',quote_increment:'0.01',price_increment:'0.01',base_min_size:'0.001',base_max_size:'1000',quote_min_size:'1',quote_max_size:'100000',
 is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,view_only:false,status:'online'};

test('Coinbase retains every restriction and rejects missing or malformed evidence',()=>{
 expect(productSchema.parse(product)).toEqual(product);
 for(const key of ['is_disabled','trading_disabled','cancel_only','post_only','auction_mode','view_only']){
  for(const value of [true,undefined,null,'false'])expect(productSchema.safeParse({...product,[key]:value}).success).toBe(false);
 }
 for(const status of ['offline','unknown','',undefined])expect(productSchema.safeParse({...product,status}).success).toBe(false);
 expect(productSchema.safeParse({...product,status:'ONLINE'}).success).toBe(true);
 // Limit-only is still an order-type restriction in the submission adapter;
 // it must not prevent legitimate limit-order sizing/valuation.
 expect(productSchema.safeParse({...product,limit_only:true}).success).toBe(true);
});
