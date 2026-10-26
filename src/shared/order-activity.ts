import type {OrderStatus,TradingVenue} from './trading';
/** An observed order update, not proof that allocation accounting has settled. */
export interface OrderActivity {
 id:string; orderId:string; venue:TradingVenue; accountId:string; accountLabel:string;
 connectionId:string; strategyId:string|null; takeId:string|null; takeTitle:string|null;
 reviewId:string|null; providerRef:string|null; symbol:string; side:string;
 /** Requested and executed amounts remain separate so an open order never looks filled. */
 quantity?:string|null; notional?:string|null; currency?:string|null;
 filledQuantity?:string|null; filledNotional?:string|null;
 execution:OrderStatus; observedAt:string;
}
export const orderStateLabel=(value:string)=>({unknown:'Outcome unknown',reconciliation_required:'Needs reconciliation',partially_filled:'Partially filled'}[value]??value.replaceAll('_',' ').replace(/^./,v=>v.toUpperCase()));

export function orderNotificationTitle(order:OrderActivity):string {
 const filled=order.execution.state==='filled',partial=order.execution.state==='partially_filled';
 const market=order.symbol?.trim()||'Unknown market';
 const symbol=order.venue==='coinbase'?market.split('-')[0]:market;
 const amount=filled||partial?order.filledNotional:order.notional;
 const rawQuantity=filled||partial?order.filledQuantity:order.quantity;
 const quantity=rawQuantity?.includes('.')?rawQuantity.replace(/0+$/,'').replace(/\.$/,''):rawQuantity;
 const money=amount!=null&&Number.isFinite(Number(amount))?(['USD','USDC'].includes(order.currency??'USD')?`$${Number(amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`:`${amount} ${order.currency}`):null;
 const action=filled?(order.side==='sell'?'Sold':'Bought'):(order.side==='sell'?'Selling':'Buying');
 const status=filled?'':` · ${order.execution.state==='accepted'?'Open':orderStateLabel(order.execution.state)}`;
 return `${action} ${quantity?`${quantity} ${symbol}${money?` · ${money}`:''}`:money?`${money} of ${symbol}`:symbol}${status}`;
}
