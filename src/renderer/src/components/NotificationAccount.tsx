import {RobinhoodLogoTile} from '../logos';

export function NotificationAccount({venue,label,takeTitle}:{venue:'coinbase'|'robinhood';label:string;takeTitle?:string|null}){
 const name=venue==='coinbase'?'Coinbase':'Robinhood';
 return <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-normal text-muted-foreground">
  {takeTitle&&<><span>{takeTitle}</span><span aria-hidden>·</span></>}
  <span className="inline-flex items-center gap-1" title={name}>
   <span className="sr-only">{name} · </span>
   {venue==='robinhood'?<RobinhoodLogoTile className="size-3.5" markClassName="size-2.5"/>:<span aria-hidden className="inline-flex size-3.5 shrink-0 items-center justify-center rounded bg-[#0052ff]"><span className="size-1.5 rounded-full bg-white"/></span>}
   <span>{label}</span>
  </span>
 </span>;
}
