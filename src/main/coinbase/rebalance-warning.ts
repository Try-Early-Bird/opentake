import {createHash} from 'node:crypto';
import {amount,format} from './order-planner';
export function rebalanceClaimsEvidence(claims:{asset:string;quantity:string;reserved:string}[]){
 return createHash('sha256').update('cash-capped-sizing-v1:').update(JSON.stringify(claims.map(c=>({asset:c.asset,quantity:format(amount(c.quantity)),reserved:format(amount(c.reserved))})).sort((a,b)=>a.asset.localeCompare(b.asset)))).digest('hex');
}
export class CoinbaseRebalanceCashError extends Error{
 constructor(readonly cash:{currency:string;required:string;available:string;shortfall:string}){super('Coinbase order amounts and fees exceed this Take’s available cash. Retry the investment preview.');}
}
