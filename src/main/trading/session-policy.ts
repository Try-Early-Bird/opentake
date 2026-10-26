import {isRegularSessionOpen,nextRegularSessionOpen,shiftEasternDate,isTradingDay} from '../market-series/sessions';
import type {BasketSpec} from '../../shared/strategies';

export interface TradingSessionPolicy {
 readonly calendar:'us-equity-regular'|'continuous';
 isOpen(now:number):boolean;
 nextOpen(now:number):number;
}
function validTime(now:number):void{
 if(!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime()))throw new Error('Invalid trading session time');
}
const regular:TradingSessionPolicy=Object.freeze({
 calendar:'us-equity-regular' as const,
 isOpen(now:number){validTime(now);return isRegularSessionOpen(now);},
 nextOpen(now:number){validTime(now);return nextRegularSessionOpen(now);},
});
const continuous:TradingSessionPolicy=Object.freeze({
 calendar:'continuous' as const,
 isOpen(now:number){validTime(now);return true;},
 nextOpen(now:number){validTime(now);return now;},
});
/** Calendar policy only: an open session never proves account, instrument or
 * order eligibility. Continuous venues still require fresh maintenance and
 * restriction evidence. Unknown combinations must not default to open.
 * Robinhood crypto's calendar does not enable its execution capability. */
export function tradingSessionPolicy(venue:string,assetClass:string):TradingSessionPolicy{
 if(venue==='robinhood'&&['equity','stock','etf'].includes(assetClass))return regular;
 if((venue==='coinbase'||venue==='robinhood')&&assetClass==='crypto')return continuous;
 throw new Error('Unsupported trading session policy');
}
// These adapters currently execute only these asset classes. Future mixed
// instruments must select policy per instrument, never by venue alone.
export const robinhoodEquitySession=tradingSessionPolicy('robinhood','equity');
export const coinbaseCryptoSession=tradingSessionPolicy('coinbase','crypto');

/** Use the strictest sleeve calendar for a funded basket. Cash-only/unknown
 * baskets keep the equity default; an open calendar is never eligibility. */
export function basketSessionPolicy(spec:Pick<BasketSpec,'target'>|null):TradingSessionPolicy {
 const weights=spec?.target.weights??[];
 if(!weights.length)return regular;
 const policies=weights.map(({instrument})=>tradingSessionPolicy(instrument.venue,
  instrument.market?.kind??(instrument.venue==='coinbase'?'crypto':'equity')));
 return policies.some(policy=>policy.calendar==='us-equity-regular')?regular:continuous;
}
/** Complete dates, including weekends for continuous markets. Date labels use
 * the Take's existing Eastern calendar, independently of source candle labels. */
export function basketCalendar(spec:Pick<BasketSpec,'target'>|null,from:string,to:string):string[] {
 const policy=basketSessionPolicy(spec),days:string[]=[];
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to)))throw Error('Invalid calendar date');
 for(let day=from;day<=to;day=shiftEasternDate(day,1)){
  if(days.length>=36600)throw Error('Calendar range too large');
  if(policy.calendar==='continuous'||isTradingDay(day))days.push(day);
 }
 return days;
}
export function lastCompletedBasketDay(spec:Pick<BasketSpec,'target'>|null,today:string):string {
 const policy=basketSessionPolicy(spec);
 let day=shiftEasternDate(today,-1);
 while(policy.calendar==='us-equity-regular'&&!isTradingDay(day))day=shiftEasternDate(day,-1);
 return day;
}
