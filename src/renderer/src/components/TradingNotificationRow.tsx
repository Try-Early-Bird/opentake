import {NotificationAccount} from './NotificationAccount';
import { Link } from '@tanstack/react-router';
import { Button } from './ui/button';
import {NotificationRow} from './NotificationRow';
import type { NotificationItem } from '../../../shared/notifications';

export function TradingNotificationRow({item,busy,onAct,onNavigate}:{item:NotificationItem;busy:boolean;onAct:(action:'confirm'|'cancel')=>void;onNavigate:()=>void}){
 if(!item.trading||!('strategyId' in item.context))return null;
 const held=item.trading,resolved=!!item.resolvedAt;
 const expired=!!item.expiresAt&&Date.parse(item.expiresAt)<=Date.now();
 const actionable=!resolved&&!expired;
 return <NotificationRow occurredAt={item.occurredAt} tone={actionable&&item.requiresAction?'attention':'neutral'} attention={actionable&&item.requiresAction}>
  <Link to="/strategies/$strategyId" params={{strategyId:item.context.strategyId}} onClick={onNavigate} className="block outline-none focus-visible:ring-2 focus-visible:ring-ring">
   <span className="block font-medium">{item.title}</span>
   <span className="mt-1 block text-muted-foreground">{held.strategyName} · {held.summary}{resolved?' · Resolved':expired?' · Expired':''}</span>
   {item.account&&<NotificationAccount {...item.account}/>}
  </Link>
  {actionable&&held.actions.length>0&&<div className="mt-2 flex gap-1.5">
   {held.actions.includes('confirm')&&<Button size="sm" className="h-7 rounded-full px-3 text-xs" aria-label={`Confirm orders for ${held.strategyName}`} disabled={busy} onClick={()=>onAct('confirm')}>Approve</Button>}
   {held.actions.includes('cancel')&&<Button size="sm" variant="outline" className="h-7 rounded-full px-3 text-xs" aria-label={`Cancel: ${item.title}`} disabled={busy} onClick={()=>onAct('cancel')}>Cancel</Button>}
  </div>}
 </NotificationRow>;
}
