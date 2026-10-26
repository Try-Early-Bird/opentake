import {expect,test} from 'vitest';
import Ajv from 'ajv';
import {takeMarketOrder} from '../../../src/main/orders/contract';
import schemas from '../../fixtures/robinhood-crypto-tool-schemas-2026-10-14-followup.json';
test('Take market buys spend USD and sells use units for both Robinhood asset classes',()=>{
 for(const side of ['buy','sell'] as const){
  const equity=takeMarketOrder({assetClass:'equity',symbol:'BTC',side,amount:'5'});
  const crypto=takeMarketOrder({assetClass:'crypto',currencyPairId:'pair-btc',side,amount:'5'});
  expect(equity.success).toBe(true);expect(crypto.success).toBe(true);
  if(!equity.success||!crypto.success)throw Error('Invalid synthetic order');
  const sizing=side==='buy'?{dollar_amount:'5'}:{quantity:'5'};
  expect(equity.data).toEqual({symbol:'BTC',side,type:'market',...sizing});
  expect(crypto.data).toEqual({currency_pair_id:'pair-btc',side,type:'market',time_in_force:'gtc',...sizing});
  const {currency_pair_id,...parameters}=crypto.data;
  const validate=new Ajv({strict:false}).compile(schemas.tools.find(t=>t.name==='place_crypto_order')!.inputSchema);
  expect(validate({...parameters,symbol:'BTC-USD',rhs_account_number:'123456',ref_id:'synthetic'})).toBe(true);
 }
});
test('asset precision and identity remain separate; no limit price or equity lots leak into crypto',()=>{
 expect(takeMarketOrder({assetClass:'crypto',currencyPairId:'pair',side:'sell',amount:'0.00000001'}).success).toBe(true);
 expect(takeMarketOrder({assetClass:'equity',symbol:'BTC',side:'sell',amount:'0.00000001'}).success).toBe(false);
 expect(takeMarketOrder({assetClass:'crypto',currencyPairId:'',side:'buy',amount:'5'}).success).toBe(false);
 for(const amount of ['0','-1','5.001'])expect(takeMarketOrder({assetClass:'crypto',currencyPairId:'pair',side:'buy',amount}).success).toBe(false);
 const result=takeMarketOrder({assetClass:'equity',symbol:'VTI',side:'sell',amount:'1',tax_lots:[{open_lot_id:'lot',quantity:'1'}]});
 expect(result.success&&result.data.tax_lots).toEqual([{open_lot_id:'lot',quantity:'1'}]);
});
