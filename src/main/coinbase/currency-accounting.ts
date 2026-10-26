import { z } from 'zod';
import { decimalToScaledInteger as units, scaledIntegerToDecimal as decimal } from '../allocations/decimal';
import type { CoinbaseFill } from './activity';

const scale=36, one=10n**36n;
const asset=z.string().regex(/^[A-Z0-9][A-Z0-9._]{0,39}$/);
const quantity=z.string().regex(/^(0|[1-9]\d{0,39})(\.\d{1,36})?$/);
const signed=(value:bigint)=>value<0n?'-'+decimal(-value,scale):decimal(value,scale);
const amount=(value:string)=>units(quantity.parse(value),scale);
export interface CurrencyMovement {asset:string;kind:'base'|'quote'|'fee';quantity:string;exact:boolean}
export interface CurrencyClaim {accountId:string;allocationId:string;asset:string;quantity:string;reserved:string}
export interface CurrencyBalance {asset:string;total:string;available:string|null}

/** Keep native size exact. A repeating quote/base conversion cannot authorize ownership. */
export function coinbaseFillMovements(fill:CoinbaseFill):CurrencyMovement[] {
 const [base,quote]=fill.productId.split('-');asset.parse(base);asset.parse(quote);
 if(base===quote||fill.productId!==`${base}-${quote}`||fill.symbol!==base||fill.currency!==quote||fill.instrumentRef!==`coinbase:${base}`||!['buy','sell'].includes(fill.side))throw new Error('Inconsistent fill identity');
 asset.parse(fill.feeCurrency);
 if(typeof fill.sizeInQuote!=='boolean')throw new Error('Fill denomination required');
 const size=amount(fill.sourceSize),price=amount(fill.price),fee=amount(fill.feeAmount);
 if(size<=0n||price<=0n)throw new Error('Positive fill size and price required');
 const baseNumerator=fill.sizeInQuote?size*one:size;
 const baseDenominator=fill.sizeInQuote?price:1n;
 const quoteNumerator=fill.sizeInQuote?size:size*price;
 const quoteDenominator=fill.sizeInQuote?1n:one;
 const baseUnits=baseNumerator/baseDenominator,quoteUnits=quoteNumerator/quoteDenominator;
 const exactBase=baseNumerator%baseDenominator===0n,exactQuote=quoteNumerator%quoteDenominator===0n;
 // Normalized evidence rounds derived amounts; validate it independently.
 if(amount(fill.quantity)!==(baseNumerator+baseDenominator/2n)/baseDenominator || amount(fill.notionalAmount)!==(quoteNumerator+quoteDenominator/2n)/quoteDenominator)throw new Error('Changed fill amounts');
 const direction=fill.side==='buy'?1n:-1n;
 return [
  {asset:base,kind:'base',quantity:signed(baseUnits*direction),exact:exactBase},
  {asset:quote,kind:'quote',quantity:signed(-quoteUnits*direction),exact:exactQuote},
  {asset:fill.feeCurrency,kind:'fee',quantity:signed(-fee),exact:true},
 ];
}

/** Account balances and Take claims are independent inputs; symbols never create claims. */
export function reconcileCurrencyClaims(accountId:string,balances:CurrencyBalance[],claims:CurrencyClaim[]) {
 const observed=new Map<string,CurrencyBalance>();
 for(const balance of balances){asset.parse(balance.asset);if(observed.has(balance.asset))throw new Error('Duplicate currency balance');amount(balance.total);if(balance.available!==null&&amount(balance.available)>amount(balance.total))throw new Error('Available exceeds total');observed.set(balance.asset,balance);}
 const grouped=new Map<string,{claimed:bigint;reserved:bigint}>();
 const identities=new Set<string>();
 for(const claim of claims){
  if(claim.accountId!==accountId)throw new Error('Claim account mismatch');
  asset.parse(claim.asset);if(!claim.allocationId)throw new Error('Allocation identity required');
  const identity=claim.allocationId+':'+claim.asset;if(identities.has(identity))throw new Error('Duplicate allocation currency');identities.add(identity);
  const owned=amount(claim.quantity),reserved=amount(claim.reserved);if(reserved>owned)throw new Error('Reservation exceeds allocation funds');
  const old=grouped.get(claim.asset)??{claimed:0n,reserved:0n};old.claimed+=owned;old.reserved+=reserved;grouped.set(claim.asset,old);
 }
 return [...new Set([...observed.keys(),...grouped.keys()])].sort().map(currency=>{
  const physical=observed.get(currency),claim=grouped.get(currency)??{claimed:0n,reserved:0n};
  const total=physical?amount(physical.total):null,available=physical?.available===null||!physical?null:amount(physical.available);
  const shortfall=total===null?null:total<claim.claimed?claim.claimed-total:0n;
  // Conservative: provider holds may overlap reservations. Never add holds back.
  const unclaimed=available===null?null:available>claim.claimed?available-claim.claimed:0n;
  return {asset:currency,total:physical?.total??null,available:physical?.available??null,claimed:decimal(claim.claimed,scale),reserved:decimal(claim.reserved,scale),unclaimed:unclaimed===null?null:decimal(unclaimed,scale),shortfall:shortfall===null?null:decimal(shortfall,scale),state:total===null?'missing' as const:(shortfall??0n)>0n?'shortfall' as const:'reconciled' as const};
 });
}

/** Validate a proposed reservation in its own currency, without mutating capital. */
export function previewCurrencyReservation(accountId:string,allocationId:string,currency:string,requested:string,balances:CurrencyBalance[],claims:CurrencyClaim[]) {
 const reserve=amount(requested);if(reserve<=0n)throw new Error('Positive reservation required');
 const reconciled=reconcileCurrencyClaims(accountId,balances,claims),row=reconciled.find(r=>r.asset===currency);
 const own=claims.find(c=>c.accountId===accountId&&c.allocationId===allocationId&&c.asset===currency);
 if(!row||row.state!=='reconciled'||row.available===null||!own)throw new Error('Reconciled allocation currency required');
 const free=amount(own.quantity)-amount(own.reserved),physical=amount(row.available),reserved=amount(row.reserved);
 const headroom=physical>reserved?physical-reserved:0n;
 if(reserve>free||reserve>headroom)throw new Error('Insufficient unreserved currency');
 return {...own,reserved:decimal(amount(own.reserved)+reserve,scale)};
}

/** Pure accounting primitive. The execution layer must prove the order/allocation
 * binding before using it; this function is deliberately not exposed over IPC. */
export function applyAllocationFill(accountId:string,allocationId:string,fillAccountId:string,fill:CoinbaseFill,claims:CurrencyClaim[]):CurrencyClaim[] {
 if(accountId!==fillAccountId||!allocationId||claims.some(c=>c.accountId!==accountId))throw new Error('Fill allocation account mismatch');
 const seen=new Set<string>();
 for(const claim of claims){const id=claim.allocationId+':'+claim.asset;if(seen.has(id)||amount(claim.reserved)>amount(claim.quantity))throw new Error('Invalid allocation claims');seen.add(id);}
 const movements=coinbaseFillMovements(fill);
 if(movements.some(m=>!m.exact))throw new Error('Exact native execution units required');
 const next=claims.map(c=>({...c}));
 for(const movement of movements){
  let claim=next.find(c=>c.allocationId===allocationId&&c.asset===movement.asset);
  if(!claim){claim={accountId,allocationId,asset:movement.asset,quantity:'0',reserved:'0'};next.push(claim);}
  const delta=movement.quantity.startsWith('-')?-amount(movement.quantity.slice(1)):amount(movement.quantity);
  const updated=amount(claim.quantity)+delta;
  if(updated<0n)throw new Error('Fill exceeds allocation currency');
  if(amount(claim.reserved)>updated)throw new Error('Release the matched order reservation before applying its fill');
  claim.quantity=decimal(updated,scale);
  // Reservation release belongs to the durable order lifecycle, not to any fill.
 }
 return next;
}
