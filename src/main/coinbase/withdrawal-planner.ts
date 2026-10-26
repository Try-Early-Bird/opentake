import {planRedemption,redemptionBand} from '../allocations/redemption';
import {scaledIntegerToDecimal} from '../allocations/decimal';
import {amount,format,productSchema,type Product,type Candidate} from './order-planner';
import type {CurrencyClaim} from './currency-accounting';
const scale=10n**36n;
const up=(value:bigint,step:bigint)=>(value+step-1n)/step*step;
/** The same partial-withdrawal band as equities, with Coinbase's market minimums and increments. */
function withdrawalContext(quote:string,claims:CurrencyClaim[],products:Product[]){
 if(claims.some(c=>amount(c.reserved)>0n))throw Error('Wait for this Take’s pending orders before withdrawing.');
 const positions=claims.filter(c=>!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n);
 if(!positions.length)throw Error('This Take has no holdings to withdraw from.');
 const market=new Map(products.map(p=>[p.base_currency_id,productSchema.parse(p)]));
 let minimum=0n,total=0n;
 const holdings=positions.map(c=>{
  const p=market.get(c.asset);if(!p||p.product_id!==`${c.asset}-${quote}`||p.quote_currency_id!==quote)throw Error(`Exact ${c.asset}-${quote} market required.`);
  const step=amount(p.base_increment),price=up(amount(p.price),amount(p.price_increment));
  const baseMinimum=up(amount(p.base_min_size),step);
  const quoteMinimum=up((amount(p.quote_min_size)*scale+amount(p.price)-1n)/amount(p.price),step);
  const minBase=baseMinimum>quoteMinimum?baseMinimum:quoteMinimum;
  const baseFloor=up((minBase*price+scale-1n)/scale,amount(p.quote_increment));
  const floor=baseFloor>amount(p.quote_min_size)?baseFloor:amount(p.quote_min_size);if(floor>minimum)minimum=floor;
  const value=amount(c.quantity)*amount(p.price)/scale;total+=value;
  return {symbol:c.asset,valueUsd:scaledIntegerToDecimal(value/(10n**18n),18)};
 });
 const min18=scaledIntegerToDecimal((minimum+10n**18n-1n)/(10n**18n),18);
 return {positions,market,total,holdings,min18};
}
export function coinbaseWithdrawalBand(quote:string,claims:CurrencyClaim[],products:Product[]){
 const {holdings,min18,positions,market,total}=withdrawalContext(quote,claims,products);
 const band=redemptionBand(holdings,{minimumOrderNotionalUsd:min18});
 let maximum=amount(band.maximumUsd);
 for(const position of positions){
  const p=market.get(position.asset)!,price=up(amount(p.price),amount(p.price_increment)),step=amount(p.base_increment);
  const baseCap=amount(p.base_max_size)/step*step,quoteCap=(amount(p.quote_max_size)*scale/price)/step*step;
  const notional=(baseCap<quoteCap?baseCap:quoteCap)*price/scale;
  const value=amount(position.quantity)*amount(p.price)/scale;
  const cap=value>0n?(notional*total/value)/(scale/100n)*(scale/100n):0n;
  if(cap<maximum)maximum=cap;
 }
 return {minimumAmount:band.minimumUsd,maximumAmount:format(maximum),possible:band.possible&&maximum>=amount(band.minimumUsd),holdingsValue:band.holdingsValueUsd};
}
export function planCoinbaseWithdrawal(quantity:string,quote:string,claims:CurrencyClaim[],products:Product[]){
 if(amount(quantity)<=0n)throw Error('Enter an amount to withdraw.');
 const {positions,market,total,holdings,min18}=withdrawalContext(quote,claims,products);
 const band=coinbaseWithdrawalBand(quote,claims,products);
 if(!band.possible)throw Error('This Take is too small for a partial withdrawal.');
 if(amount(quantity)>amount(band.maximumAmount))throw Error(`Withdraw at most ${band.maximumAmount} ${quote} to keep this Take invested and meet Coinbase order limits.`);
 const planned=planRedemption(quantity,holdings,{minimumOrderNotionalUsd:min18});
 if(!planned.ok){const reason=planned.reasons[0];throw Error(reason?.code==='below_band'?`Withdraw at least ${planned.band.minimumUsd} ${quote}.`:reason?.code==='above_band'?`Withdraw at most ${planned.band.maximumUsd} ${quote} to keep this Take invested.`:'This Take is too small for a partial withdrawal.');}
 const orders:Candidate[]=planned.legs.map(leg=>{
  const p=market.get(leg.symbol)!,price=up(amount(p.price),amount(p.price_increment));
  const base=(amount(leg.notionalUsd)*scale/price)/amount(p.base_increment)*amount(p.base_increment);
  const notional=base*price/scale,remaining=amount(positions.find(c=>c.asset===leg.symbol)!.quantity)-base;
  if(base<amount(p.base_min_size)||notional<amount(p.quote_min_size)||remaining<amount(p.base_min_size)||remaining*amount(p.price)/scale<amount(p.quote_min_size))throw Error(`${leg.symbol} cannot meet Coinbase minimums at this withdrawal amount.`);
  if(base>amount(p.base_max_size)||notional>amount(p.quote_max_size))throw Error(`${leg.symbol} exceeds Coinbase's order maximum.`);
  return {orderType:'market',product:p.product_id,side:'sell',baseSize:format(base),limitPrice:format(price),notional:format(notional)};
 });
 return {phase:'sell' as const,orders,skipped:[] as string[],remainingValue:format(total-orders.reduce((sum,o)=>sum+amount(o.baseSize)*amount(market.get(o.product.split('-')[0])!.price)/scale,0n)),band:coinbaseWithdrawalBand(quote,claims,products),value:format(total+amount(claims.find(c=>c.asset===quote)?.quantity??'0')),cash:claims.find(c=>c.asset===quote)?.quantity??'0'};
}

/** Sell every tradable unit; residue is disclosed and released to the same account on completion. */
export function planCoinbaseClose(quote:string,claims:CurrencyClaim[],products:Product[],sellSymbols?:string[]){
 if(claims.some(c=>amount(c.reserved)>0n))throw Error('Wait for this Take’s pending orders before closing.');
 if(sellSymbols?.some(symbol=>!claims.some(c=>c.asset===symbol&&!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n)))throw Error('Unknown closing position.');
 const orders:Candidate[]=[],residue:{asset:string;quantity:string}[]=[];
 let total=amount(claims.find(c=>c.asset===quote)?.quantity??'0');
 for(const c of claims){
  if(['USD','USDC'].includes(c.asset)||amount(c.quantity)===0n)continue;
  const p=products.find(p=>p.product_id===`${c.asset}-${quote}`);if(!p)throw Error(`Exact ${c.asset}-${quote} market required.`);
  productSchema.parse(p);
  const price=up(amount(p.price),amount(p.price_increment)),owned=amount(c.quantity);
  total+=owned*amount(p.price)/scale;
  let base=owned/amount(p.base_increment)*amount(p.base_increment),notional=base*price/scale;
  if((sellSymbols!==undefined&&!sellSymbols.includes(c.asset))||base<amount(p.base_min_size)||notional<amount(p.quote_min_size)){base=0n;notional=0n;}
  if(base>amount(p.base_max_size)||notional>amount(p.quote_max_size))throw Error(`${c.asset} exceeds Coinbase's order maximum.`);
  if(base>0n)orders.push({orderType:'market',product:p.product_id,side:'sell',baseSize:format(base),limitPrice:format(price),notional:format(notional)});
  if(owned>base)residue.push({asset:c.asset,quantity:format(owned-base)});
 }
 if(!claims.some(c=>amount(c.quantity)>0n))throw Error('This Take has no funds to take out.');
 return {phase:'sell' as const,orders,skipped:[] as string[],residue,value:format(total),cash:claims.find(c=>c.asset===quote)?.quantity??'0'};
}
