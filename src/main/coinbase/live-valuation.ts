import type { CoinbaseSpotPosition, PortfolioView } from '../../shared/portfolio';
import { decimalToScaledInteger as units, scaledIntegerToDecimal as decimal } from '../allocations/decimal';
export type LiveCoinbasePrice = (product: string) => string | null;
export interface CoinbaseValuationInput {
 portfolio: NonNullable<PortfolioView['portfolio']>;
 spotPositions: CoinbaseSpotPosition[];
 warnings?: string[];
}
/** Reprice saved quantities only. Never mutate observations or available-to-trade amounts. */
export function valueCoinbaseHoldings<T extends CoinbaseValuationInput>(saved: T, observedAt: number, now: number, price: LiveCoinbasePrice): T {
 if (now-observedAt>900_000 || observedAt>now || saved.warnings?.length || saved.portfolio.currency!=='USD') return saved;
 let delta=0n;
 const spotPositions=saved.spotPositions.map(position=>{
  if(position.isCash || position.currency!=='USD')return position;
  const live=price(position.asset+'-USD');if(live===null)return position;
  try {
   const quantity=units(position.quantity,36), quote=units(live,36);
   if(quantity<=0n || quote<=0n)return position;
   const value=quantity*quote/(10n**36n), difference=value-units(position.marketValue,36);
   const unrealizedPnl=position.unrealizedPnl==null?position.unrealizedPnl:decimal(units(position.unrealizedPnl,36)+difference,36);
   delta+=difference;
   return {...position,marketValue:decimal(value,36),unrealizedPnl};
  } catch {return position;}
 });
 return {...saved,spotPositions,portfolio:{...saved.portfolio,totalValue:decimal(units(saved.portfolio.totalValue,36)+delta,36)}};
}
