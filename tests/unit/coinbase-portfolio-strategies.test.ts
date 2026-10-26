import {test,expect} from 'vitest';
import {coinbasePortfolioStrategies,type CoinbasePortfolioAllocation} from '../../src/main/coinbase/portfolio-strategies';
import type {CoinbaseSpotPosition} from '../../src/shared/portfolio';
const allocation:CoinbasePortfolioAllocation={id:'allocation',strategyId:'strategy',takeId:'take',title:'Mixed test',description:'Mixed',status:'active',restore:false,spec:{schemaVersion:1,kind:'basket',target:{cashBps:0,weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:7000},{instrument:{venue:'robinhood',symbol:'AAPL'},bps:3000}]},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}}};
const claims=[{allocationId:'allocation',asset:'BTC',quantity:'0.1'},{allocationId:'allocation',asset:'USDC',quantity:'0.25'}];
const positions:CoinbaseSpotPosition[]=[{instrumentRef:'coinbase:BTC',asset:'BTC',quantity:'0.2',marketValue:'20',availableValue:'20',currency:'USD',isCash:false,takeAllocations:[{allocationId:'allocation',strategyId:'strategy',title:'Mixed test',quantity:'0.1'}]},{instrumentRef:'coinbase:USDC',asset:'USDC',quantity:'5',marketValue:'5',availableValue:'5',currency:'USD',isCash:true,takeAllocations:[{allocationId:'allocation',strategyId:'strategy',title:'Mixed test',quantity:'0.25'}]}];
test('Coinbase and mixed Takes use the shared row model with account-only value and personal remainder',()=>{
 const view=coinbasePortfolioStrategies([allocation],claims,positions);
 expect(view.strategies[0]).toMatchObject({strategyId:'strategy',value:'10.25',cash:'0.25',positions:[{symbol:'BTC',quantity:'0.1'}],spec:allocation.spec});
 expect(view.selfDirectedSpotPositions.map(p=>[p.asset,p.quantity,p.marketValue])).toEqual([['BTC','0.1','10'],['USDC','4.75','4.75']]);
 expect(view.warnings).toEqual([]);
 expect(Number(view.strategies[0].value)+view.selfDirectedSpotPositions.reduce((n,p)=>n+Number(p.marketValue),0)).toBe(25);
});
test('unreconciled ownership keeps physical positions visible without asserting a Take value',()=>{
 const view=coinbasePortfolioStrategies([allocation],claims,positions.map(p=>({...p,takeAllocations:undefined})));
 expect(view.strategies[0]).toMatchObject({value:null,requiresReconciliation:true});
 expect(view.selfDirectedSpotPositions).toHaveLength(2);expect(view.warnings).toHaveLength(2);
});
test('fully released Takes have no held row or spurious missing-asset warning',()=>{
 const view=coinbasePortfolioStrategies([allocation],claims.map(c=>({...c,quantity:'0'})),[]);
 expect(view.strategies).toEqual([]);expect(view.warnings).toEqual([]);
});
