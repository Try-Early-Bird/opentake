import type {BasketSpec} from '../../shared/strategies';
import type {CoinbaseSpotPosition} from '../../shared/portfolio';
import {outOfBand} from '../../shared/basket-rebalance';
/** Use one observed valuation currency for every sleeve; incomplete evidence never triggers trading. */
export function coinbaseDriftExceeded(spec:BasketSpec,claims:{asset:string;quantity:string;reserved:string}[],positions:CoinbaseSpotPosition[],currency:string):boolean{
 if(spec.rebalance.driftBandPoints===null&&spec.rebalance.driftBandRelative===null)return false;
 if(claims.some(c=>Number(c.reserved)>0||!Number.isFinite(Number(c.quantity))||Number(c.quantity)<0))return false;
 const values=new Map<string,number>();let total=0;
 for(const claim of claims){
  const quantity=Number(claim.quantity);if(!quantity)continue;
  const p=positions.find(p=>p.asset===claim.asset&&p.currency===currency);
  if(!p||!(Number(p.quantity)>0)||quantity>Number(p.quantity))return false;
  const value=quantity*Number(p.marketValue)/Number(p.quantity);if(!Number.isFinite(value)||value<0)return false;
  values.set(claim.asset,value);total+=value;
 }
 if(!(total>0))return false;
 const weights=spec.target.weights,sum=weights.reduce((s,w)=>s+w.bps,0);if(!sum||weights.some(w=>w.instrument.venue!=='coinbase'))return false;
 for(const symbol of new Set([...weights.map(w=>w.instrument.symbol),...[...values.keys()].filter(s=>!['USD','USDC'].includes(s))])){
  const target=(100-spec.target.cashBps/100)*(weights.find(w=>w.instrument.symbol===symbol)?.bps??0)/sum;
  if(outOfBand((values.get(symbol)??0)/total*100,target,spec.rebalance))return true;
 }
 return outOfBand(((values.get('USD')??0)+(values.get('USDC')??0))/total*100,spec.target.cashBps/100,spec.rebalance);
}
