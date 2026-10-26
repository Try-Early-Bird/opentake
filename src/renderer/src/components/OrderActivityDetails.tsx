import type {OrderActivity} from '../../../shared/order-activity';
import {orderStateLabel} from '../../../shared/order-activity';
export function OrderActivityDetails({order}:{order:OrderActivity}){
 const rows=[['Broker',order.venue==='coinbase'?'Coinbase':'Robinhood'],['Account',order.accountLabel],['Take',order.takeTitle??'—'],['Asset',order.symbol],['Side',order.side],['Status',orderStateLabel(order.execution.state)],['Cancellation',order.execution.cancelState==='none'?'—':orderStateLabel(order.execution.cancelState)],['Broker order ID',order.providerRef??'Not confirmed'],['Last observed',new Date(order.observedAt).toLocaleString()]];
 return <div className="space-y-4"><dl className="grid grid-cols-1 gap-x-8 gap-y-5 pt-2 sm:grid-cols-2">{rows.map(([label,value])=><div key={label}><dt className="text-sm font-medium">{label}</dt><dd className="mt-1 break-all text-sm font-normal text-foreground/90">{value}</dd></div>)}</dl>
 {(order.execution.state==='unknown'||order.execution.state==='reconciliation_required'||(order.execution.cancelState==='unknown'&&!['filled','cancelled','expired','rejected'].includes(order.execution.state)))&&<p className="text-sm text-muted-foreground">This order needs verification. An uncertain outcome does not mean it failed. Check its status before placing another order.</p>}
 </div>;
}
