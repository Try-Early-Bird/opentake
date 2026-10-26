import type { ReactNode } from 'react';
export interface SourceCapabilities {
  edit: boolean;
  collection: boolean;
  interval: 'inline' | 'review' | 'none';
  storage: 'account' | 'feed';
  destination: boolean;
}
export function SourceHeader({icon,title,description,status,actions}:{icon:ReactNode;title:string;description:ReactNode;status?:ReactNode;actions?:ReactNode}) {
  return <header className="mb-7 flex flex-wrap items-center gap-3">{icon}<div className="min-w-0 flex-1"><h2 className="text-xl font-medium">{title}</h2><div className="mt-1 break-words text-sm text-muted-foreground">{description}</div></div><span className="text-xs text-muted-foreground">{status}</span>{actions}</header>;
}
export function SourceSectionHeader({title,actions}:{title:string;actions?:ReactNode}) {
  return <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3"><h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h3><div className="flex items-center gap-3 text-[11px] text-muted-foreground">{actions}</div></header>;
}
export function SourceFeedRow({name,description,status,children}:{name:string;description:ReactNode;status?:ReactNode;children?:ReactNode}) {
  return <section className="border-b border-border py-4"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><h4 className="text-sm font-medium">{name}</h4><div className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</div></div><div className="shrink-0 text-[11px] text-muted-foreground">{status}</div></div>{children}</section>;
}
const intervalLabel=(ms:number)=>ms===86400000?'Daily':ms>=3600000?`${ms/3600000} h`:ms>=60000?`${ms/60000} min`:`${ms/1000} s`;
export function SourceCollectionRow({name,description,on,busy,capabilities,onToggle,intervalMs,choices=[],onInterval,onReview,toggleLabel}:{name:string;description:string;on:boolean;busy?:boolean;capabilities:SourceCapabilities;onToggle():void;intervalMs:number;choices?:readonly number[];onInterval?(ms:number):void;onReview?():void;toggleLabel?:string}) {
  return <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-border py-4"><div className="flex items-center gap-3"><button type="button" role="switch" aria-checked={on} aria-label={toggleLabel??`${name} collection`} disabled={busy||!capabilities.collection} onClick={onToggle} className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:opacity-40 ${on?'border-foreground bg-foreground':'border-input bg-muted'}`}><span className={`absolute top-0.5 size-2.5 rounded-full bg-background shadow-sm transition-transform ${on?'left-3.5':'left-0.5'}`}/></button><div><h4 className={`text-sm font-medium ${!on?'text-muted-foreground':''}`}>{name}</h4><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div></div>
    {capabilities.interval==='inline'&&<div role="group" aria-label={`${name} check interval`} className="flex flex-wrap gap-1.5 pl-10 sm:pl-0">{[...new Set([...choices,intervalMs])].sort((a,b)=>a-b).map(ms=><button type="button" key={ms} disabled={!on||busy} aria-pressed={intervalMs===ms} onClick={()=>onInterval?.(ms)} className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-30 ${intervalMs===ms?'bg-foreground text-background':'bg-muted/70 text-sky-600 hover:bg-muted dark:text-sky-400'}`}>{intervalLabel(ms)}</button>)}</div>}
    {capabilities.interval==='review'&&<div className="flex items-center gap-3 text-xs"><span className="rounded-full bg-muted px-3 py-1.5">{intervalLabel(intervalMs)}</span>{capabilities.edit&&<button disabled={busy} className="underline underline-offset-4 disabled:opacity-40" onClick={onReview}>Edit refresh settings</button>}</div>}
  </div>;
}
