import {createContext,useContext} from 'react';
import {createPortal} from 'react-dom';
import {HoldingLogo,useLogos} from '../components/HoldingLogo';
import {Clock,SlidersHorizontal} from 'lucide-react';
import type {TakeVersionReview} from '../../../shared/take-version-review';
import {cryptoLogo} from '../crypto-logos';
import {Button} from '../components/ui/button';
export const TakeVersionBannerTarget=createContext<HTMLElement|null|undefined>(undefined);
type VersionChanges=Pick<TakeVersionReview,'currentWeights'|'nextWeights'|'currentRules'|'nextRules'>;
export function versionChanges(view:VersionChanges){
 const allocations=[...new Set([...view.currentWeights,...view.nextWeights].map(w=>w.symbol))].map(symbol=>({label:symbol,before:(view.currentWeights.find(w=>w.symbol===symbol)?.bps??0)/100,after:(view.nextWeights.find(w=>w.symbol===symbol)?.bps??0)/100})).filter(w=>w.before!==w.after);
 const schedule=(s:string)=>s==='never'?'Drift only':s.charAt(0).toUpperCase()+s.slice(1);
 const rules=[{label:'Cash target',before:`${view.currentRules.cashBps/100}%`,after:`${view.nextRules.cashBps/100}%`},{label:'Schedule',before:schedule(view.currentRules.schedule),after:schedule(view.nextRules.schedule)},{label:'Drift threshold',before:view.currentRules.driftBandPoints===null?'Off':`${view.currentRules.driftBandPoints} pts`,after:view.nextRules.driftBandPoints===null?'Off':`${view.nextRules.driftBandPoints} pts`},{label:'Relative drift',before:view.currentRules.driftBandRelative===null?'Off':`${view.currentRules.driftBandRelative}%`,after:view.nextRules.driftBandRelative===null?'Off':`${view.nextRules.driftBandRelative}%`}];
 return {allocations,rules:rules.filter(r=>r.before!==r.after),unchanged:rules.filter(r=>r.before===r.after).map(r=>r.label)};
}
export function TakeVersionBanner({view,onReview}:{view:VersionChanges&{versionSequence?:number};onReview:()=>void}){
 const target=useContext(TakeVersionBannerTarget);
 const changes=versionChanges(view);const counts=[changes.allocations.length?`${changes.allocations.length} allocation${changes.allocations.length===1?'':'s'}`:'',changes.rules.length?`${changes.rules.length} rule${changes.rules.length===1?'':'s'}`:''].filter(Boolean).join(' and ');
 const banner=<section className="mb-3 flex items-center gap-3 border-b border-border py-4"><span className="size-2 shrink-0 rounded-full bg-attention"/><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">This take has a new version</h3><p className="mt-1 text-xs text-muted-foreground">{counts?`${counts} changed`:'Details changed'} · you’re still on {view.versionSequence?`v${view.versionSequence}`:'the previous version'}</p></div><Button className="rounded-full" onClick={onReview}>Review</Button></section>;
 return target?createPortal(banner,target):target===undefined?banner:null;
}
export function TakeVersionChangeRows({view,venue='coinbase'}:{view:VersionChanges;venue?:'coinbase'|'robinhood'}){
 const changes=versionChanges(view);
 const logos=useLogos(venue==='robinhood'?changes.allocations.map(r=>r.label):[]);
 return <div><div className="divide-y divide-border border-y border-border">
 {changes.allocations.map(row=><div key={row.label} className="flex items-center gap-3 py-4">{venue==='robinhood'?<HoldingLogo weight={{symbol:row.label,logoUrl:logos.get(row.label)??null}}/>:cryptoLogo(row.label)?<img src={cryptoLogo(row.label)!} alt="" className="size-8 rounded-full"/>:<span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs">{row.label.slice(0,2)}</span>}<span className="flex-1 font-medium">{row.label}</span><span className="font-mono text-muted-foreground line-through">{row.before}%</span><span className="font-mono">{row.after}%</span><span className={`font-mono text-xs ${row.after>row.before?'text-success':'text-error'}`}>{row.after>row.before?'+':''}{Number((row.after-row.before).toFixed(2))}</span></div>)}
 {changes.rules.map(row=><div key={row.label} className="flex items-center gap-3 py-4"><span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">{row.label==='Schedule'?<Clock size={16}/>:<SlidersHorizontal size={16}/>}</span><span className="flex-1 font-medium">{row.label}</span><span className="text-muted-foreground line-through">{row.before}</span><span>{row.after}</span></div>)}
 </div>{changes.unchanged.length>0&&<p className="mt-3 text-xs text-muted-foreground">Unchanged: {changes.unchanged.join(', ').toLowerCase()}.</p>}</div>;
}
