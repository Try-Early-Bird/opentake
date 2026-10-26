import {expect,test} from 'vitest';
import reference from '../../fixtures/planning/hosted-sizing.json';
import {sizeTargetAllocation,conserveRequestedNotionals} from '../../../src/main/planning/target-sizing';

for (const fixture of reference.sizing) test(`hosted sizing parity: ${fixture.name}`,()=>{
 const {bucketValueUsd,...input}=fixture.input;
 const result=sizeTargetAllocation({...input,allocationValueUsd:bucketValueUsd,
  minimumOrderNotionalUsd:input.minimumOrderNotionalUsd??'1',sellMinimumHeadroomBps:500});
 expect(result).toEqual(JSON.parse(JSON.stringify(fixture.expected).replaceAll('insufficient_bucket_cash','insufficient_allocation_cash')));
});
for (const [i,f] of reference.conservation.entries()) test(`hosted cent conservation parity: ${i}`,()=>{
 expect(conserveRequestedNotionals(f.orders,f.intended,f.cash)).toEqual(f.expected);
});
test('local policy and precision validation',()=>{
 const {bucketValueUsd,...input}=reference.sizing[0].input;
 const valid={...input,allocationValueUsd:bucketValueUsd,minimumOrderNotionalUsd:'1',sellMinimumHeadroomBps:500};
 for(const override of [{sellMinimumHeadroomBps:-1},{rebalanceThresholdBps:0.1},{minimumOrderNotionalUsd:'0'},{allocationValueUsd:'1.0000000000000000001'}])
  expect(()=>sizeTargetAllocation({...valid,...override})).toThrow();
});

const cryptoSell = {symbol:'BTC-USD',targetWeightPercent:0,allocationValueUsd:'100',
 currentInstrumentValueUsd:'100',currentQuantity:'0.00123456',availableCashUsd:'0',markPriceUsd:'81000',
 maximumOrderNotionalUsd:'1000',minimumOrderNotionalUsd:'1',sellMinimumHeadroomBps:500};
test('crypto exits preserve owned units at the provider increment',()=>{
 expect(sizeTargetAllocation({...cryptoSell,quantityIncrement:'0.00000001'})).toMatchObject({
  disposition:'order',order:{side:'sell',quantity:'0.00123456'}});
 expect(sizeTargetAllocation(cryptoSell)).toMatchObject({disposition:'order',order:{quantity:'0.001234'}});
});
test('partial sells floor to the actual step rather than its decimal precision',()=>{
 expect(sizeTargetAllocation({...cryptoSell,targetWeightPercent:50,quantityIncrement:'0.000025'})).toMatchObject({
  disposition:'order',order:{quantity:'0.0006'}});
 for(const quantityIncrement of ['0','-1','0.0000000000000000001'])
  expect(()=>sizeTargetAllocation({...cryptoSell,quantityIncrement})).toThrow();
});
