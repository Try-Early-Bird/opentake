import {NotificationAccount} from './NotificationAccount';
import type {NotificationItem} from '../../../shared/notifications';
import {orderStateLabel,orderNotificationTitle} from '../../../shared/order-activity';
import {NotificationRow} from './NotificationRow';

/** Shared presentation for observed order updates from either venue. */
export function OrderNotificationRow({item,onOpen}:{item:NotificationItem;onOpen:()=>void}){
 const order=item.order;
 if(!order)return null;
 const state=order.execution.state;
 const tone=item.requiresAction&&!item.resolvedAt?'attention':state==='filled'?'success':state==='rejected'?'error':'neutral';
 return <NotificationRow occurredAt={item.occurredAt} tone={tone}>
  <button type="button" onClick={onOpen} className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
   <span className="block font-medium">{orderNotificationTitle(order)}</span>
   <NotificationAccount venue={order.venue} label={order.accountLabel??item.body} takeTitle={order.takeTitle}/>
   {(state==='unknown'||state==='reconciliation_required'||order.execution.cancelState!=='none')&&<span className="mt-1 block text-muted-foreground">{orderStateLabel(state)}{order.execution.cancelState!=='none'?` · Cancellation ${order.execution.cancelState}`:''}</span>}
  </button>
 </NotificationRow>;
}
