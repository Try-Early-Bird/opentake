import type {ReactNode} from 'react';
import {Check,Clock,TriangleAlert,X} from 'lucide-react';
import {exactTime} from './activity-format';

export function NotificationRow({children,occurredAt,tone='neutral',attention=false}:{children:ReactNode;occurredAt:string;tone?:'neutral'|'success'|'error'|'attention';attention?:boolean}){
 const Icon=tone==='success'?Check:tone==='error'?X:tone==='attention'?TriangleAlert:Clock;
 const age=Math.max(0,Math.floor((Date.now()-Date.parse(occurredAt))/60000));
 const when=age<1?'now':age<60?`${age}m`:age<1440?`${Math.floor(age/60)}h`:`${Math.floor(age/1440)}d`;
 return <li className={`flex items-start gap-2.5 px-3.5 py-3 ${attention?'bg-muted/50':''}`}>
  <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${tone==='success'?'bg-brand/10 text-brand':tone==='error'?'bg-destructive/10 text-destructive':tone==='attention'?'bg-foreground/10 text-foreground':'bg-muted text-muted-foreground'}`}><Icon size={13} aria-hidden/></span>
  <div className="min-w-0 flex-1 text-xs leading-4">{children}</div>
  <time dateTime={occurredAt} title={exactTime(occurredAt)} className="mt-0.5 shrink-0 text-[10px] tabular-nums text-muted-foreground">{when}</time>
 </li>;
}
