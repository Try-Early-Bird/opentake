import {expect,test} from 'vitest';
import {coinbaseMinimum} from '../../src/main/coinbase/preflight';
import {planCoinbaseOrders,type Product} from '../../src/main/coinbase/order-planner';
import type {BasketSpec} from '../../src/shared/strategies';
const spec:BasketSpec={schemaVersion:1,kind:'basket',target:{cashBps:0,weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:5000},{instrument:{venue:'coinbase',symbol:'ZEC'},bps:5000}]},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
const product=(symbol:string,price:string,step:string):Product=>({product_id:`${symbol}-USDC`,base_currency_id:symbol,quote_currency_id:'USDC',product_type:'SPOT',price,base_increment:step,quote_increment:'0.01',price_increment:'0.01',base_min_size:step,base_max_size:'10000',quote_min_size:'1',quote_max_size:'1000000',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,view_only:false,status:'online'});
test.each([0,1000,5000])('minimum covers both crypto legs and %i bps retained cash',cashBps=>{
 const basket={...spec,target:{...spec.target,cashBps}},products=[product('BTC','63000.17','0.00001'),product('ZEC','42.03','0.001')];
 const minimum=coinbaseMinimum(basket,'USDC',products);
 const result=planCoinbaseOrders(basket,'USDC',[{accountId:'account',allocationId:'preview',asset:'USDC',quantity:minimum,reserved:'0'}],products);
 expect(result.orders.map(o=>o.product)).toEqual(['BTC-USDC','ZEC-USDC']);
 expect(result.orders.every(o=>Number(o.notional)>=1)).toBe(true);
});
test('preview minimum never substitutes a different quote market',()=>{
 expect(()=>coinbaseMinimum(spec,'USD',[product('BTC','100','0.01'),product('ZEC','50','0.01')])).toThrow('Market unavailable');
});
