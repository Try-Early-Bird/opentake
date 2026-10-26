import {createHash,randomUUID} from 'node:crypto';
import {mixedPreviewRequest,type MixedPreview,type MixedLegPreview,type MixedFundingLeg,type MixedVenue} from '../../shared/mixed-execution';
import type {BasketSpec} from '../../shared/strategies';
import {decimalToScaledInteger as amount,scaledIntegerToDecimal as decimal} from '../allocations/decimal';
import {mixedFunding} from './funding';
export interface MixedPreviewContext {
 takeId:string;versionId:string;routeRevision:string;spec:BasketSpec;
 routes:{venue:MixedVenue;accountId:string}[];
 /** Includes account eligibility, balances/reservations, and accepted version evidence. */
 evidence:string;usdcUsdRate?:string;rateObservedAt?:number;
}
export interface MixedPreviewStore {
 find(operationId:string):Promise<{requestHash:string;preview:MixedPreview}|null>;
 /** Atomically compare the operation key/hash; return the winner on an identical retry. */
 save(operationId:string,requestHash:string,preview:MixedPreview):Promise<MixedPreview>;
}
export function createMixedPreview(deps:{load(takeId:string):Promise<MixedPreviewContext>;preview(leg:MixedFundingLeg,context:MixedPreviewContext):Promise<MixedLegPreview>;store:MixedPreviewStore;clock?:()=>number;executionEnabled?:boolean}){
 const clock=deps.clock??Date.now;
 const inflight=new Map<string,{hash:string;work:Promise<MixedPreview>}>();
 return (raw:unknown):Promise<MixedPreview>=>{
  const request=mixedPreviewRequest.parse(raw),hash=createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const prior=inflight.get(request.operationId);if(prior){if(prior.hash!==hash)return Promise.reject(Error('Operation ID already used for another preview.'));return prior.work;}
  const work=(async()=>{
   const existing=await deps.store.find(request.operationId);
   if(existing){if(existing.requestHash!==hash)throw Error('Operation ID already used for another preview.');return existing.preview;}
   const context=await deps.load(request.takeId);
   if(context.takeId!==request.takeId||context.versionId!==request.versionId||context.routeRevision!==request.routeRevision)throw Error('Take or account choices changed. Review again.');
   if(request.coinbaseCurrency==='USDC'&&(context.rateObservedAt===undefined||clock()-context.rateObservedAt>60000||context.rateObservedAt>clock()))throw Error('USDC valuation is stale. Refresh before reviewing.');
   const funding=mixedFunding(context.spec,request.amountUsd,context.routes,request.coinbaseCurrency,context.usdcUsdRate);
   // Preview is read-only. No provider call or database transaction spans both venues.
   const legs:MixedLegPreview[]=[];
   for(const leg of funding){
    const preview=await deps.preview(leg,context);
    if(preview.venue!==leg.venue||preview.accountId!==leg.accountId||preview.currency!==leg.currency||preview.quantity!==leg.quantity)throw Error('Preview does not match its funding account.');
    if(!['ready','waiting_market','blocked'].includes(preview.state)||!preview.evidence||!Number.isFinite(Date.parse(preview.expiresAt))||Date.parse(preview.expiresAt)<=clock())throw Error('Preview expired or is missing evidence.');
    const numeric=[preview.existingCash??'0',preview.quantity,preview.retainedCash,preview.available,...preview.orders.flatMap(o=>[o.notional,o.fee])];
    if(numeric.some(n=>!/^\d{1,40}(\.\d{1,36})?$/.test(n)))throw Error('Invalid preview amounts.');
    if(preview.orders.some(o=>o.side!=='buy'||!leg.weights.some(w=>w.instrument.symbol===o.symbol)))throw Error('Preview contains an unexpected order.');
    const cost=preview.orders.reduce((n,o)=>n+amount(o.notional,36)+amount(o.fee,36),0n)+amount(preview.retainedCash,36);
    if(preview.state!=='blocked'){
     const venue=leg.venue==='coinbase'?'Coinbase':'Robinhood',currency=leg.currency;
     const funding=amount(preview.quantity,36)+amount(preview.existingCash??'0',36);
     if(amount(preview.quantity,36)>amount(preview.available,36))throw Error(`${venue} cannot fund its part of this deposit: ${preview.quantity} ${currency} is needed, but only ${preview.available} ${currency} is available in that account. Lower the deposit or add funds to that account, then preview again. No orders were placed by this preview.`);
     if(cost!==funding){
      const difference=decimal(cost>funding?cost-funding:funding-cost,36);
      throw Error(`${venue}’s deposit preview does not balance. New deposit: ${preview.quantity} ${currency}; cash already in this Take: ${preview.existingCash??'0'} ${currency}. Buys, fees, and cash left over total ${decimal(cost,36)} ${currency} — ${difference} ${currency} ${cost>funding?'more':'less'} than the available ${decimal(funding,36)} ${currency}. Preview again. If this repeats, report it; adding funds will not fix this calculation mismatch. No orders were placed by this preview.`);
     }
    }
    legs.push(preview);
   }
   const fresh=await deps.load(request.takeId);
   if(fresh.evidence!==context.evidence||fresh.versionId!==context.versionId||fresh.routeRevision!==context.routeRevision)throw Error('Accounts or Take changed during preview. Review again.');
   const expiry=Math.min(...legs.map(l=>Date.parse(l.expiresAt)));
   if(expiry<=clock())throw Error('Preview expired. Review again.');
   const preview:MixedPreview={id:randomUUID(),takeId:request.takeId,versionId:request.versionId,routeRevision:request.routeRevision,amountUsd:request.amountUsd,legs,state:legs.some(l=>l.state==='blocked')?'blocked':legs.some(l=>l.state==='waiting_market')?'waiting_market':'ready',expiresAt:new Date(expiry).toISOString(),executionEnabled:deps.executionEnabled===true};
   return deps.store.save(request.operationId,hash,preview);
  })();
  inflight.set(request.operationId,{hash,work});void work.finally(()=>{if(inflight.get(request.operationId)?.work===work)inflight.delete(request.operationId);}).catch(()=>{});return work;
 };
}
