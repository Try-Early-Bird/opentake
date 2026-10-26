import {investmentVenues} from '../../shared/investment-venues';
import {venueBasket} from './basket';
import {basketSchema,assertInstrumentExecution,type BasketSpec} from '../../shared/strategies';
import type {MixedFundingLeg,MixedVenue} from '../../shared/mixed-execution';
import {decimalToScaledInteger as amount,scaledIntegerToDecimal as decimal} from '../allocations/decimal';
const supported=Object.keys(investmentVenues) as MixedVenue[];
/** Largest remainder: conserve every cent/basis point, with deterministic ties. */
function split(total:bigint,weights:number[]):bigint[]{
 const sum=BigInt(weights.reduce((a,b)=>a+b,0));if(sum<=0n)throw Error('Positive allocation weights required.');
 const parts=weights.map((weight,index)=>({index,value:total*BigInt(weight)/sum,remainder:total*BigInt(weight)%sum}));
 let left=total-parts.reduce((n,p)=>n+p.value,0n);
 for(const p of [...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1)){if(left===0n)break;p.value++;left--;}
 return parts.map(p=>p.value);
}
export function mixedFunding(spec:BasketSpec,amountUsd:string,routes:{venue:MixedVenue;accountId:string}[],currency:'USD'|'USDC',usdcUsdRate?:string):MixedFundingLeg[]{
 spec=basketSchema.parse(spec);assertInstrumentExecution(spec);
 const venues=supported.filter(v=>spec.target.weights.some(w=>w.instrument.venue===v));
 if(!/^\d{1,12}(\.\d{1,2})?$/.test(amountUsd)||amount(amountUsd,2)<=0n)throw Error('Enter a positive dollar amount with at most two decimals.');
 if(spec.target.weights.some(w=>!supported.includes(w.instrument.venue as MixedVenue))||venues.length<2)throw Error('A mixed Coinbase and Robinhood basket is required.');
 if(routes.length!==venues.length||new Set(routes.map(r=>r.venue)).size!==venues.length||new Set(routes.map(r=>r.accountId)).size!==venues.length)throw Error('Choose one distinct account for each platform.');
 const weights=venues.map(v=>spec.target.weights.filter(w=>w.instrument.venue===v).reduce((n,w)=>n+w.bps,0));
 const portions=split(amount(amountUsd,2),weights);
 return venues.map((venue,i)=>{
  const account=routes.find(r=>r.venue===venue);if(!account)throw Error('Missing funding account.');
  const original=spec.target.weights.filter(w=>w.instrument.venue===venue).sort((a,b)=>a.instrument.symbol.localeCompare(b.instrument.symbol));
  if(portions[i]===0n)throw Error('Amount or target weight is too small for this platform.');
  const dollars=decimal(portions[i],2),quote=venue==='coinbase'?currency:'USD';
  let quantity=dollars;
  if(quote==='USDC'){
   if(!usdcUsdRate||!/^\d{1,12}(\.\d{1,18})?$/.test(usdcUsdRate)||amount(usdcUsdRate)<=0n)throw Error('A current USDC/USD valuation is required.');
   // Round funding down to cents; do not silently treat USDC as USD or overfund.
   quantity=decimal(amount(dollars)*100n/amount(usdcUsdRate),2);
   if(amount(quantity)<=0n)throw Error('Amount is too small for this currency.');
  }
  return {venue,accountId:account.accountId,currency:quote,amountUsd:dollars,quantity,weights:original,sleeve:venueBasket(spec,venue)};
 });
}
