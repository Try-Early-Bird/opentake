import { transactionDelta, walletBalance, sameDisplayQuantity, reconciledWalletBalance } from './history-amounts';
import { z } from 'zod';
import { decimalToScaledInteger as units, scaledIntegerToDecimal as decimal } from '../allocations/decimal';
import type { CoinbaseSpotPosition } from '../../shared/portfolio';
import type { CoinbaseHistory } from './history';
const scale=36, divisor=10n**36n;
const terminal=new Set(['completed','canceled','expired','failed']);
const supported=new Set(['advanced_trade_fill','buy','sell','trade','send','receive','transfer','fiat_deposit','fiat_withdrawal','earn_payout','staking_reward','interest','incentives_rewards_payout','subscription_rebate','subscription','retail_simple_dust']);
export interface CoinbaseValuation {
 state:'complete'|'unavailable';
 reason:'coverage'|'unsettled'|'unsupported_event'|'ledger_mismatch'|'price_gap'|'asset_limit'|null;
 points:{observedAt:string;totalValue:string;currency:string;reconstructed:true;resolution?:'daily'}[];
}
/** Reconstructed hourly marks, never provider observations or investment returns. */
export async function reconstructCoinbaseDay(history:CoinbaseHistory,positions:CoinbaseSpotPosition[],currency:string,asOf:number,
 readCandles:(product:string,start:string,end:string)=>Promise<unknown>, dailySpot?: (product:string,date:string)=>Promise<string>):Promise<CoinbaseValuation> {
 const unavailable=(reason:CoinbaseValuation['reason']):CoinbaseValuation=>({state:'unavailable',reason,points:[]});
 if(history.state!=='complete' || history.walletCount===0)return unavailable('coverage');
 const events=history.transactions;
 if(events.some(t=>!terminal.has(t.status)))return unavailable('unsettled');
 const settled=events.filter(t=>t.status==='completed');
 if(settled.some(t=>Date.parse(t.occurredAt)>asOf))return unavailable('unsettled');
 const hour=dailySpot?86400000:3600000,end=Math.floor(asOf/hour)*hour-(dailySpot?hour:0),start=end-(dailySpot?7:24)*hour;
 // Older event types need not be interpreted to roll back this window. Their signed
 // amounts still participate in the exact current-balance reconciliation below.
 if(settled.some(t=>Date.parse(t.occurredAt)>start && !supported.has(t.type)))return unavailable('unsupported_event');
 const balance=new Map<string,bigint>();
 for(const event of settled) balance.set(event.asset,(balance.get(event.asset)??0n)+transactionDelta(event));
 const actual=new Map<string,bigint>();
 // Wallet balances retain decimal precision and include dust omitted by breakdown.
 // Never substitute rounded display quantities when exact wallet evidence exists.
 if(history.wallets) {
  for(const wallet of history.wallets) {
   const quantity=walletBalance(wallet);if(quantity===null)return unavailable('coverage');
   actual.set(wallet.asset,(actual.get(wallet.asset)??0n)+quantity);
  }
  for(const position of positions)if(!sameDisplayQuantity(decimal(actual.get(position.asset)??0n,scale),position.quantity))return unavailable('ledger_mismatch');
  const perWallet=new Map<string,bigint>();
  for(const tx of settled)perWallet.set(tx.wallet,(perWallet.get(tx.wallet)??0n)+transactionDelta(tx));
  actual.clear();
  for(const wallet of history.wallets) {
   const quantity=reconciledWalletBalance(wallet,perWallet.get(wallet.wallet)??0n);
   if(quantity===null)return unavailable('ledger_mismatch');
   actual.set(wallet.asset,(actual.get(wallet.asset)??0n)+quantity);
  }
 } else for(const position of positions)actual.set(position.asset,units(position.quantity,scale));
 for(const asset of new Set([...balance.keys(),...actual.keys()])) {
  if((balance.get(asset)??0n)!==(actual.get(asset)??0n))return unavailable('ledger_mismatch');
 }
 const hourly:{time:number;quantities:Map<string,bigint>}[]=[];
 // Roll back signed currency movements from the observed account balance.
 for(let time=start;time<=end;time+=hour) {
  const quantities=new Map(actual);
  for(const event of settled)if(Date.parse(event.occurredAt)>time)quantities.set(event.asset,(quantities.get(event.asset)??0n)-transactionDelta(event));
  if([...quantities.values()].some(q=>q<0n))return unavailable('ledger_mismatch');
  hourly.push({time,quantities});
 }
 const assets=[...new Set(hourly.flatMap(p=>[...p.quantities].filter(([,q])=>q>0n).map(([a])=>a)))].filter(a=>a!==currency);
 if(assets.length>20)return unavailable('asset_limit');
 const prices=new Map<string,Map<number,bigint>>();
 const price=z.union([z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).max(80),z.number().finite().nonnegative()]).transform(String);
 for(const asset of assets) {
  try {
   const raw=await readCandles(`${asset}-${currency}`,new Date(start).toISOString(),new Date(end+hour).toISOString());
   const parsed=z.object({candles:z.array(z.object({start:z.union([z.string(),z.number()]),open:price})).max(350),truncated:z.boolean().optional(),stale:z.boolean().optional()}).parse(raw);
   if(parsed.truncated||parsed.stale)return unavailable('price_gap');
   const values=new Map<number,bigint>();
   for(const candle of parsed.candles){const t=typeof candle.start==='number'||/^\d+$/.test(candle.start)?Number(candle.start)*1000:Date.parse(candle.start);
    if(!Number.isFinite(t)||t%hour!==0||values.has(t))return unavailable('price_gap');values.set(t,units(candle.open,scale));}
   prices.set(asset,values);
  } catch {if(!dailySpot)return unavailable('price_gap');}
  if(dailySpot) {
   const values=prices.get(asset)??new Map<number,bigint>();
   for(let t=start;t<=end;t+=hour)if(!values.has(t))try{values.set(t,units(await dailySpot(`${asset}-${currency}`,new Date(t).toISOString().slice(0,10)),scale));}catch{return unavailable('price_gap');}
   prices.set(asset,values);
  }
 }
 const points:CoinbaseValuation['points']=[];
 for(const point of hourly){
  let value=0n;
  for(const [asset,quantity] of point.quantities){
   if(quantity===0n)continue;
   const price=asset===currency?divisor:prices.get(asset)?.get(point.time);
   if(price===undefined||price<=0n)return unavailable('price_gap');
   value+=quantity*price/divisor;
  }
  points.push({observedAt:new Date(point.time).toISOString(),totalValue:decimal(value,scale),currency,reconstructed:true,...(dailySpot?{resolution:'daily' as const}:{})});
 }
 return {state:'complete',reason:null,points};
}
