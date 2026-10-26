import { transactionDelta, walletBalance } from './history-amounts';
import { decimalToScaledInteger as units, scaledIntegerToDecimal as decimal } from '../allocations/decimal';
import type { CoinbaseHistory } from './history';
import type { CoinbaseHistoryReconciliation, CoinbaseSpotPosition } from '../../shared/portfolio';
const format=(value:bigint)=>(value<0n?'-':'')+decimal(value<0n?-value:value,36);
/** Account-scoped reconciliation evidence, without wallet IDs or provider payloads. */
export function reconcileCoinbaseHistory(history:CoinbaseHistory,positions:CoinbaseSpotPosition[]):CoinbaseHistoryReconciliation[] {
 const assets=new Set([...positions.map(p=>p.asset),...history.transactions.map(t=>t.asset),...(history.wallets??[]).map(w=>w.asset)]);
 return [...assets].sort().map(asset=>{
  const events=history.transactions.filter(tx=>tx.asset===asset&&tx.status==='completed');
  const ledger=events.reduce((sum,tx)=>sum+transactionDelta(tx),0n);
  const holdings=positions.filter(p=>p.asset===asset).reduce((sum,p)=>sum+units(p.quantity,36),0n);
  const wallets=history.wallets?.filter(w=>w.asset===asset);
  const wallet=wallets?.length&&wallets.every(w=>walletBalance(w)!==null)?wallets.reduce((sum,w)=>sum+walletBalance(w)!,0n):null;
  const types=[...new Set(events.map(tx=>tx.type))].sort().map(type=>{
   const group=events.filter(tx=>tx.type===type);
   return {type,count:group.length,quantity:format(group.reduce((sum,tx)=>sum+transactionDelta(tx),0n)),firstAt:group.map(tx=>tx.occurredAt).sort()[0],lastAt:group.map(tx=>tx.occurredAt).sort().at(-1)!};
  });
  return {asset,ledgerQuantity:format(ledger),portfolioQuantity:format(holdings),walletQuantity:wallet===null?null:format(wallet),difference:format(holdings-ledger),types};
 });
}
