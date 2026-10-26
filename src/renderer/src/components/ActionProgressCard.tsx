import {NotificationAccount} from './NotificationAccount';
import {money} from '../portfolio/format';
import {Check,Clock,AlertCircle} from 'lucide-react';
import type {ActionProgress} from '../../../shared/action-notification';
export function ActionProgressCard({action,onView}:{action:ActionProgress;onView?:()=>void}){
 const done=action.state==='completed',attention=action.state==='attention';
 const approval=action.accounts.some(a=>a.state==='awaiting_confirmation');
 return <div className="relative min-w-0 text-xs">
  {onView&&<button type="button" aria-label={`${approval?'Review':'View'} ${action.takeTitle}: ${action.title}`} onClick={onView} className="absolute inset-0 z-10 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"/>}
  <div className="flex items-center gap-2"><span className={done?'text-success':attention?'text-error':'text-muted-foreground'}>{done?<Check size={16}/>:attention?<AlertCircle size={16}/>:<Clock size={16}/>}</span><span className="flex-1 font-medium">{action.title}</span>{onView&&<span className="text-[11px] font-medium underline underline-offset-2">{approval?'Review':'View'}</span>}</div>
  <p className="mt-1 line-clamp-2 pl-6 text-[11px] text-muted-foreground">{action.takeTitle}</p>
  {approval&&<p className="mt-1 pl-6 text-[11px] text-muted-foreground">Orders have not been submitted. Review them before confirming.</p>}
  <ul className="my-2 space-y-1 pl-6">{action.orders.map(o=><li key={o.id} className="flex items-start gap-2"><span className={o.state==='filled'?'text-success':['failed','rejected','unknown','reconciliation_required'].includes(o.state)?'text-error':'text-muted-foreground'}>{o.state==='filled'?'✓':'•'}</span><span className="min-w-0 flex-1">{o.symbol}<span className="ml-1 text-[10px] text-muted-foreground">{o.side}</span><NotificationAccount venue={o.venue==='coinbase'?'coinbase':'robinhood'} label={o.account}/></span><span className="shrink-0 font-mono tabular-nums">{o.amount===null?'—':money(o.amount)}{o.state!=='filled'&&<span className="font-sans text-muted-foreground"> · {approval&&o.state==='reserved'?'Not submitted':o.state.replaceAll('_',' ')}</span>}</span></li>)}</ul>
  {action.accounts.map((a,i)=><div key={`${a.venue}:${i}`} className="mt-1 line-clamp-2 pl-6 text-[11px] text-muted-foreground">{a.message&&a.state!=='completed'&&<p>{a.label} · {a.message}</p>}</div>)}
 </div>;
}
