import { splitReplies } from '../../../shared/reply-options';
import {RuleRunHistory} from './RuleRunHistory';
import {TakeRules} from './TakeRules';
import {InstrumentMarketLink} from './InstrumentMarketLink';
import {createPortal} from 'react-dom';
import { supportsBasketExecution,hasPendingInstrumentSupport,instrumentKey as identityKey,type StrategyInstrument } from '../../../shared/strategies';
import { TakeIconPicker } from './TakeIconPicker';
import { ArrowLeft, Check, ChevronRight, History, TriangleAlert } from 'lucide-react';
import { Button } from '../components/ui/button';
import { StatusDot } from '../components/chat/StatusDot';
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from '../components/ui/dialog';
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { BasketView, Proposal, ProposalPayload, Verification, WriteResult, HistoryPage, CommitReview, StrategyVersion } from '../../../shared/strategies';
import { BasketEditor } from './BasketEditor';
import { raiseSmallestTo } from '../../../shared/basket-editor';
import { Dialog as ConfirmDialog, DialogContent as ConfirmContent, DialogDescription as ConfirmDescription, DialogHeader as ConfirmHeader, DialogTitle as ConfirmTitle } from '../components/ui/app-dialog';

const colors=['bg-indigo-500','bg-emerald-500','bg-amber-500','bg-orange-600','bg-sky-500','bg-fuchsia-500'];
const eyebrow='text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground';
const section='space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0';
const venueName=(venue:string)=>venue==='robinhood'?'Robinhood':venue.charAt(0).toUpperCase()+venue.slice(1);
const driftLabel=({driftBandPoints,driftBandRelative}:{driftBandPoints:number|null;driftBandRelative:number|null})=>[driftBandPoints!==null&&`${driftBandPoints} points`,driftBandRelative!==null&&`${driftBandRelative}% relative`].filter(Boolean).join(' · ')||'Off';
const shortDate=(at:string)=>new Date(at).toLocaleDateString(undefined,{month:'short',day:'numeric'});
const instrumentKey=(w:{instrument:StrategyInstrument})=>identityKey(w.instrument);
const scheduleLabel=(v:string)=>v.charAt(0).toUpperCase()+v.slice(1);
// A value that changed since the committed version: the old one struck through beside the new.
function Changed({before,after}:{before?:string;after:string}){
 return <>{before!==undefined&&before!==after&&<span className="mr-1.5 font-normal text-muted-foreground line-through">{before}</span>}{after}</>;
}
// Against
// the committed version it marks what the draft changes; holdings open for their notes.
export function TakeSummary({proposal:p,committed,checks}:{proposal:Proposal;committed?:ProposalPayload;checks?:Verification}){
 const {weights,cashBps}=p.spec.target,venues=[...new Set(weights.map(w=>w.instrument.venue))],[open,setOpen]=useState<string|null>(null);
 const before=new Map(committed?.spec.target.weights.map(w=>[instrumentKey(w),w.bps])),now=new Set(weights.map(instrumentKey));
 const removed=committed?committed.spec.target.weights.filter(w=>!now.has(instrumentKey(w))):[];
 const flagged=new Map(checks?.results.filter(r=>r.state==='blocked'||r.fractional===false).map(r=>[instrumentKey(r),r]));
 const rules=committed?.spec.rebalance;
 return <div className="space-y-4 text-sm">
 <section aria-label="Allocation" className={section}>
 <div className="flex items-center justify-between gap-3"><h3 className={eyebrow}>Allocation</h3><span className="flex items-center gap-1 text-xs text-muted-foreground"><Check size={12}/>100%</span></div>
 <div className="flex h-1.5 gap-0.5" aria-hidden="true">{weights.map((w,i)=><span key={instrumentKey(w)} className={`rounded-full ${colors[i%colors.length]}`} style={{flex:`${w.bps} 1 0`}}/>)}{cashBps>0&&<span className="rounded-full bg-muted-foreground/40" style={{flex:`${cashBps} 1 0`}}/>}</div>
 <ul aria-label="Proposed allocations" className="space-y-1">
 {weights.map((w,i)=>{const key=instrumentKey(w),reason=p.metadata.holdings.find(h=>instrumentKey(h)===key)?.reason,issue=flagged.get(key),old=before.get(key),isNew=!!committed&&old===undefined,expanded=open===key;
  return <li key={key}><div className="flex items-center gap-1"><button type="button" aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 text-left hover:bg-muted/50" onClick={()=>setOpen(expanded?null:key)}>
   <span className={`h-2 w-2 shrink-0 rounded-full ${colors[i%colors.length]}`}/><span className="row-title">{w.instrument.symbol}</span>
   {issue&&<TriangleAlert size={12} aria-label="Needs review" className="shrink-0 text-attention"/>}{isNew&&<span className="rounded bg-success/10 px-1.5 text-[11px] font-medium text-success">New</span>}
   <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{w.instrument.market?'Robinhood · Crypto':venues.length>1?venueName(w.instrument.venue):''}</span>
   <span className="shrink-0 font-medium tabular-nums"><Changed before={old===undefined?undefined:`${old/100}%`} after={`${w.bps/100}%`}/></span></button><InstrumentMarketLink instrument={w.instrument}/></div>
   {expanded&&<div className="space-y-1 pb-1 pl-5 text-xs leading-5 text-muted-foreground">{reason&&<p>{reason}</p>}{issue&&<p className="text-attention">{issue.state==='blocked'?'Not tradeable on your account.':'Whole shares only, so it can’t be bought at an exact weight in a small investment.'}</p>}{!reason&&!issue&&<p>No notes for this holding.</p>}</div>}</li>;})}
 {removed.map(w=><li key={instrumentKey(w)} className="flex items-center gap-3 py-1 text-muted-foreground"><span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"/><span className="line-through">{w.instrument.symbol}</span><span className="rounded bg-error/10 px-1.5 text-[11px] font-medium text-error">Removed</span><span className="flex-1"/><span className="tabular-nums"><Changed before={`${w.bps/100}%`} after="0%"/></span><InstrumentMarketLink instrument={w.instrument}/></li>)}
 <li className="flex items-center gap-3 py-1 text-muted-foreground"><span className="h-2 w-2 rounded-full bg-muted-foreground/40"/><span className="flex-1">Cash</span><span className="tabular-nums"><Changed before={committed?`${committed.spec.target.cashBps/100}%`:undefined} after={`${cashBps/100}%`}/></span></li></ul>
 <p className="text-xs text-muted-foreground">{venues.length===1?`All on ${venueName(venues[0]!)} · `:''}Tap a holding for details and review notes</p>
 </section>
 {p.metadata.rationale&&<section aria-label="Why this take" className={section}><h3 className={eyebrow}>Why this take</h3><ClampedText text={p.metadata.rationale}/></section>}
 <RulesSection rebalance={p.spec.rebalance} committed={rules} flagged={!!p.unsupportedRequests.length}/>
 </div>;
}
// Hide empty portfolio settings unless a pending change or review warning needs attention.
function RulesSection({rebalance,committed,flagged}:{rebalance:Proposal['spec']['rebalance'];committed?:Proposal['spec']['rebalance'];flagged:boolean}){
 const none=rebalance.schedule==='never'&&driftLabel(rebalance)==='Off',changed=!!committed&&(committed.schedule!==rebalance.schedule||driftLabel(committed)!==driftLabel(rebalance));
 const [open,setOpen]=useState(!none||changed||flagged);
 if(none&&!changed&&!flagged)return null;
 const summary=none?'None':[rebalance.schedule!=='never'&&scheduleLabel(rebalance.schedule),driftLabel(rebalance)!=='Off'&&`${driftLabel(rebalance)} drift`].filter(Boolean).join(' · ');
 return <section aria-label="Portfolio settings" className={section}>
 <button type="button" aria-expanded={open} className="flex w-full items-center justify-between gap-3 text-left" onClick={()=>setOpen(!open)}>
  <h3 className={`${eyebrow} flex items-center gap-1.5`}>Portfolio settings{flagged&&<TriangleAlert size={12} aria-label="Needs review" className="text-attention"/>}</h3>
  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{!open&&summary}<ChevronRight size={14} className={`transition-transform ${open?'rotate-90':''}`}/></span></button>
 {open&&<>
 <p className="flex justify-between gap-3"><span className="text-muted-foreground">Rebalance</span><span className="font-medium"><Changed before={committed&&scheduleLabel(committed.schedule)} after={scheduleLabel(rebalance.schedule)}/></span></p>
 <p className="flex justify-between gap-3"><span className="text-muted-foreground">Drift bands</span><span className="font-medium"><Changed before={committed&&driftLabel(committed)} after={driftLabel(rebalance)}/></span></p>
 <p className="text-xs text-muted-foreground">Runs during market hours while you have money in this take.</p></>}
 </section>;
}
// Long AI explanations show their first lines; clicking the text expands and collapses it.
function ClampedText({text}:{text:string}){
 const ref=useRef<HTMLParagraphElement>(null),[open,setOpen]=useState(false),[long,setLong]=useState(false);
 // Measured after layout and again whenever the panel's width changes the wrapping.
 useEffect(()=>{const el=ref.current;if(!el||open)return;const measure=()=>setLong(el.scrollHeight>el.clientHeight+1);
  const frame=requestAnimationFrame(measure);const observer=new ResizeObserver(measure);observer.observe(el.parentElement??el);
  return()=>{cancelAnimationFrame(frame);observer.disconnect();};},[text,open,long]);
 const body=<p ref={ref} className={`leading-6 ${open?'':'line-clamp-4'}`}>{text}</p>;
 if(!long&&!open)return body;
 return <button type="button" aria-expanded={open} className="block w-full text-left" onClick={()=>setOpen(!open)}>{body}<span className="mt-1 block text-xs font-medium text-muted-foreground hover:text-foreground">{open?'Show less':'Show more'}</span></button>;
}
// What to look at before investing: what the take could not carry out, which applies
// to its rules. Tradeability is checked in the background and marked on the holding.
type ReviewItem={group:'Rules';title:string};
function reviewItems(unsupported:string[]):ReviewItem[]{return unsupported.map(title=>({group:'Rules' as const,title}));}
function ReviewCard({items}:{items:ReviewItem[]}){
 const [open,setOpen]=useState<number|null>(null);
 return <section aria-label="To review" className="rounded-2xl bg-attention/[0.07] p-4 text-sm">
 <p className="flex items-center gap-2.5 text-[15px] font-medium"><TriangleAlert size={16} className="shrink-0 text-attention"/>Review before investing</p>
 <ul className="mt-2 divide-y divide-border pl-[26px]">{items.map((item,i)=><li key={`${item.group}\n${item.title}`}><button type="button" aria-expanded={open===i} className="flex w-full items-center gap-3 py-2.5 text-left" onClick={()=>setOpen(open===i?null:i)}>
  <span className="min-w-0 flex-1"><span className="block text-muted-foreground">{item.group}</span><span className={`mt-0.5 block text-[15px] ${open===i?'':'truncate'}`}>{item.title}</span></span>
  <ChevronRight size={14} className={`shrink-0 text-muted-foreground transition-transform ${open===i?'rotate-90':''}`}/></button></li>)}</ul>
 </section>;
}
// Drafts already checked in the background this session, so reopening one doesn't call Robinhood again.
const backgroundChecked=new Set<string>();
const panelClassName='flex h-[45dvh] min-h-0 w-full shrink-0 flex-col border-t border-border bg-background md:h-full md:w-[380px] md:border-t-0 md:border-l xl:w-[420px]';
export function BasketPanel({takeId,...props}:{takeId:string|null;profileId?:string|null;archived?:boolean;editTarget?:HTMLElement|null}){
 if(!takeId)return <aside aria-label="Take confirmation" className={panelClassName}/>;
 return <TakeStrategyPanel key={takeId} takeId={takeId} {...props}/>;
}
function TakeStrategyPanel({takeId,profileId,archived=false,editTarget}:{takeId:string;profileId?:string|null;archived?:boolean;editTarget?:HTMLElement|null}){
 const [view,setView]=useState<BasketView|null>(null),[loaded,setLoaded]=useState(false),[editor,setEditor]=useState<{base:BasketView|null}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[available,setAvailable]=useState(true),[verification,setVerification]=useState<{draftId:string;value:Verification}|null>(null),[history,setHistory]=useState(false);
 // A failed refresh is its own message: it clears on the next success and shows only after a few
 // failures in a row, so a brief host restart does not leave an error under the Take.
 const [loadError,setLoadError]=useState('');
 useEffect(()=>{let active=true,failures=0;async function load(){try{const [v,a]=await Promise.all([window.strategies.read(takeId),window.strategies.available(takeId,profileId)]);if(active){failures=0;setLoadError('');setView(v);setAvailable(a);setLoaded(true);}}catch(e){if(active&&++failures>=3)setLoadError((e instanceof Error?e.message:'Could not load take.').replace(/^Error invoking remote method '[^']+': (Error: )?/,''));}}void load();const timer=setInterval(()=>void load(),1500);
  const changed=(event:Event)=>{if((event as CustomEvent<{takeId:string}>).detail?.takeId===takeId)void load();},visible=()=>{if(document.visibilityState==='visible')void load();};
  window.addEventListener('take-view-changed',changed);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('take-view-changed',changed);document.removeEventListener('visibilitychange',visible);};},[takeId,profileId]);
 const [older,setOlder]=useState<HistoryPage>({proposals:[],versions:[],nextRevision:null});
 // Your money in this strategy: committing a new version rebalances an active investment.
 const [investment,setInvestment]=useState<{status:string;value:string|null}|null>(null);
 const strategyId=view?.strategyId,committedVersion=view?.currentVersion;
 // Publish review: what committing this draft does to the money in the take.
 const [review,setReview]=useState<CommitReview|null>(null),[acceptStranded,setAcceptStranded]=useState(false),[acceptTurnover,setAcceptTurnover]=useState(false);
 const draftId=view?.draft.id,clean=view?.clean;
 useEffect(()=>{let active=true;setAcceptStranded(false);setAcceptTurnover(false);if(!draftId||clean){setReview(null);return;}
  void window.strategies.commitReview(takeId).then(r=>{if(active)setReview(r);}).catch(()=>{if(active)setReview(null);});return()=>{active=false;};},[takeId,draftId,clean,committedVersion]);
 const stranded=!!review&&review.investments>0&&review.belowMinimum>0,strandedBlocks=stranded&&!acceptStranded;
 // Committing with these consequences is confirmed in a dialog, one acknowledgement each.
 const warned=stranded||!!review?.highTurnover;
 // The dialog's one-click fix for small investments: every holding raised to the weight that fits them.
 const fitWeights=review?.weightThatFitsPercent!=null&&view?raiseSmallestTo(view.draft.spec.target.weights,Math.round(review.weightThatFitsPercent*100)):null;
 const turnoverBlocks=!!review&&review.highTurnover&&!acceptTurnover;
 useEffect(()=>{let active=true;if(!strategyId){setInvestment(null);return;}
  void window.portfolio.snapshot().then(snapshot=>{if(!active)return;const mine=(snapshot.strategies??[]).filter(s=>s.strategyId===strategyId);
   setInvestment(mine.length===0?null:{status:mine.some(s=>s.status==='active')?'active':mine[0]!.status,value:mine.some(s=>s.value===null)?null:String(mine.reduce((n,s)=>n+Number(s.value),0))});}).catch(()=>{});
  return()=>{active=false;};},[strategyId,committedVersion]);
 // Retain loaded history when new drafts move the first page forward.
 useEffect(()=>{if(view)setOlder(old=>old.proposals.length?mergeHistory(old,{proposals:view.proposals,versions:view.versions,nextRevision:old.nextRevision}):old);},[view]);
 const action=(v:BasketView)=>({targetTakeId:takeId,expectedRevision:v.draft.id,expectedVersion:v.currentVersion,operationId:crypto.randomUUID()});
 async function apply(work:()=>Promise<WriteResult>){setBusy(true);setError('');try{const result=await work();if(!result.ok){if(!result.conflict)throw new Error(result.message);setView(await window.strategies.read(takeId));throw new Error(result.message+' Your edits remain open; copy them or cancel to review the latest draft.');}setView(result.view);return result;}catch(e){setError(e instanceof Error?e.message:'Take action failed.');return null;}finally{setBusy(false);}}
 const pendingSave=useRef<{key:string;operationId:string}>();
 async function save(payload:ProposalPayload){const base=editor!.base;const data={...payload,targetTakeId:takeId,expectedRevision:base?.draft.id??null,expectedVersion:base?.currentVersion??null};const key=JSON.stringify(data);if(pendingSave.current?.key!==key)pendingSave.current={key,operationId:crypto.randomUUID()};const operationId=pendingSave.current.operationId;const result=await apply(()=>window.strategies.propose({...data,operationId}));if(result)setEditor(null);}
 const readOnly=archived||!!view?.archivedAt;
 const commit=()=>apply(()=>window.strategies.commit({...action(view!),acceptHighTurnover:acceptTurnover,acceptStranded}));
 const settled=!!view&&matchesCommitted(view),committedRecord=view?.versions.find(v=>v.id===view.currentVersion),changes=view&&committedRecord&&!settled?takeChanges(view.draft,committedRecord.payload):null;
 const changeCount=changes?changes.rows.length+changes.notes.length+(changes.reworded?1:0):0;
 // Discarding drafts back to the committed version, as a new revision like any restore.
 const discard=()=>committedRecord&&void apply(()=>window.strategies.useRevision({...action(view!),proposalId:committedRecord.proposalId}));
 const [confirming,setConfirming]=useState(false);
 const checks=view&&verification?.draftId===view.draft.id?verification.value:view?.draft.verification,reviewList=view?reviewItems(view.draft.unsupportedRequests):[];
 // Tradeability runs behind the scenes: a draft whose check could not finish (imported, or
 // Robinhood busy or unreachable) is checked again once when it opens.
 const draftForCheck=view&&!readOnly&&view.draft.verification.results.some(r=>r.state==='unknown'&&r.fractional!==false)?view.draft.id:null;
 useEffect(()=>{if(!draftForCheck||backgroundChecked.has(draftForCheck))return;backgroundChecked.add(draftForCheck);
  void window.strategies.verify(takeId).then(value=>setVerification({draftId:draftForCheck,value})).catch(()=>{});},[draftForCheck,takeId]);
 if(!view&&!editor)return <aside aria-label="Take confirmation" className={panelClassName}>{(error||loadError)&&<p role="alert" className="px-5 py-4 text-sm text-destructive">{error||loadError}</p>}</aside>;
 if(history&&view)return <aside aria-label="Take confirmation" className={panelClassName}>
 <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-4"><Button variant="ghost" size="icon-sm" aria-label="Back to take" title="Back" onClick={()=>{setHistory(false);setError('');}}><ArrowLeft size={16}/></Button><div className="min-w-0"><h2 className="text-lg font-semibold leading-6">History</h2><p className="truncate text-xs text-muted-foreground">{view.title}</p></div></header>
 <TakeHistory view={view} older={older} busy={busy} readOnly={readOnly} error={error}
  onUse={p=>void apply(()=>window.strategies.useRevision({...action(view),proposalId:p.id})).then(result=>{if(result)setHistory(false);})}
  onLoadOlder={()=>{setBusy(true);void window.strategies.history(takeId,older.nextRevision??view.proposals.at(-1)!.revision).then(page=>setOlder(old=>mergeHistory(mergeHistory(old,{proposals:view.proposals,versions:view.versions,nextRevision:page.nextRevision}),page))).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}/>
 </aside>;
 return <aside aria-label="Take confirmation" className={panelClassName}>
 <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4"><div className="flex min-w-0 flex-1 items-start gap-2">{view&&<TakeIconPicker takeId={takeId} iconId={view.iconId} readOnly={readOnly} onChanged={iconId=>setView(current=>current?{...current,iconId}:current)}/>}<div className="min-w-0"><h2 className="text-lg font-semibold leading-6">{view?.title??'Your take draft'}</h2>{view&&<p className="mt-1 text-xs text-muted-foreground">Revision {view.draft.revision} · {shortDate(view.draft.createdAt)}{readOnly?' · Archived':''}</p>}</div></div>
 {view&&<div className="flex shrink-0 items-center gap-1">
  {!editor&&!readOnly&&loaded&&editTarget&&createPortal(<Button variant="ghost" size="sm" disabled={busy} onClick={()=>{setError('');setEditor({base:view});}}>Edit take</Button>,editTarget)}
  <Button variant="ghost" size="icon-sm" aria-label="History" title="History" onClick={()=>setHistory(true)}><History size={16}/></Button></div>}</header>
 <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-4">
 {!available&&<p className="text-xs text-muted-foreground">The AI cannot propose changes with the current tool permissions or instructions. Use the pencil to edit this Take yourself.</p>}
  {editor&&<BasketEditor initial={editor.base?.draft} busy={busy} saveError={error} onSave={save} onCancel={()=>{setEditor(null);setError('');}}/>}
 {view&&<TakeSummary key={view.draft.id} proposal={view.draft} committed={settled?undefined:committedRecord?.payload} checks={checks}/>}{view&&!!view.suggestions?.length&&<RuleSuggestions view={view} busy={busy||readOnly} onApply={p=>void apply(()=>window.strategies.useRevision({targetTakeId:takeId,expectedRevision:view.draft.id,expectedVersion:view.currentVersion,operationId:crypto.randomUUID(),proposalId:p}))} onDismiss={p=>{setBusy(true);setError('');void window.strategies.dismissSuggestion({targetTakeId:takeId,proposalId:p}).then(v=>{if(v)setView(v);}).catch(e=>setError(e instanceof Error?e.message:'Could not dismiss.')).finally(()=>setBusy(false));}}/>}{view?.currentVersion&&<TakeRules takeId={takeId} strategyId={view.strategyId} title={view.title} readOnly={readOnly}/>}
 {(error||loadError)&&<p role="alert" className="text-sm text-destructive">{error||loadError}</p>}
 </div>
 {!editor&&view&&<footer className="shrink-0 space-y-3 border-t border-border bg-background px-5 pt-4 pb-6">
 {!!reviewList.length&&<ReviewCard items={reviewList}/>}
 <div className="flex items-center justify-between gap-3 text-sm"><p className="flex items-center gap-2"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${settled?'bg-success':'bg-attention'}`}/>{settled?`Committed as version ${committedRecord?.sequence??''}`.trim():!view.currentVersion?'Not committed yet':changes?`${changeCount} uncommitted ${changeCount===1?'change':'changes'}`:'Uncommitted changes'}</p>
  {!settled&&committedRecord&&!readOnly&&<button type="button" disabled={busy} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40" onClick={discard}>Discard</button>}</div>
 {!supportsBasketExecution(view.draft.spec) && <p className="text-xs leading-5 text-muted-foreground">{hasPendingInstrumentSupport(view.draft.spec)?'Robinhood crypto Takes can be saved for research. Funding and trading are not available yet.':'Each platform uses the balance in its selected account.'}</p>}
 <p className="text-xs leading-5 text-muted-foreground">{settled?'This version is saved. Continue the conversation to refine it.'
  :investment?.status==='active'?'Committing saves a new version. Review and switch versions on the Take page when you are ready.'
  :investment?'Your investment keeps its accepted version until you switch on the Take page.'
  :'Committing saves this version. It doesn’t place trades.'}</p>
 <div className="flex gap-2">{view.currentVersion&&<Link to="/strategies/$strategyId" params={{strategyId:view.strategyId}} className={`${settled?'flex-1 bg-foreground text-background hover:bg-foreground/90':'shrink-0 bg-muted hover:bg-muted/70'} rounded-full px-5 py-2.5 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>Invest</Link>}
 {!settled&&<button disabled={busy||readOnly} className="flex-1 rounded-full bg-foreground px-4 py-2.5 text-sm font-medium text-background disabled:opacity-40" onClick={()=>{if(warned){setAcceptStranded(false);setAcceptTurnover(false);setConfirming(true);}else void commit();}}>{busy?'Saving…':'Commit'}</button>}</div></footer>}
 {review&&view&&<ConfirmDialog open={confirming} onOpenChange={next=>{if(!next&&!busy)setConfirming(false);}}><ConfirmContent className="max-w-md">
  <ConfirmHeader><ConfirmTitle>{investment?.status==='active'?'Commit changes?':view.currentVersion?'Commit changes?':'Commit take?'}</ConfirmTitle>
   <ConfirmDescription>Committing saves a new version. Your investment keeps its accepted version until you review and switch on the Take page.</ConfirmDescription></ConfirmHeader>
  <div className="divide-y divide-border">
  {stranded&&<CommitConsequence title={`${review.belowMinimum} ${review.belowMinimum===1?'investment is':'investments are'} too small for this basket`}
   body={`${review.belowMinimum===1?'Its':'Their'} share of the smallest holding is under Robinhood’s $1 minimum, so that holding is skipped and ${review.belowMinimum===1?'it holds':'they hold'} less than the take.${review.weightThatFitsPercent===null?' No weight would fit the smallest of them.':` A smallest weight of ${review.weightThatFitsPercent}% would fit everyone.`}`}
   action={fitWeights&&<button type="button" disabled={busy} className="mt-2 rounded-full bg-muted px-3 py-1 text-xs font-medium hover:text-foreground disabled:opacity-40" onClick={()=>{setConfirming(false);void apply(()=>window.strategies.propose({...action(view),metadata:view.draft.metadata,spec:{...view.draft.spec,target:{...view.draft.spec.target,weights:fitWeights}},unsupportedRequests:view.draft.unsupportedRequests}));}}>Set smallest weight to {review.weightThatFitsPercent}%</button>}/>}
  {review.highTurnover&&<CommitConsequence title="The new version changes most holdings" body={`${review.turnoverPercent}% could be sold and rebought when you switch and rebalance.`}/>}
  </div>
  <label className="flex items-center gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5 text-sm"><input type="checkbox" checked={(!stranded||acceptStranded)&&(!review.highTurnover||acceptTurnover)} disabled={busy} onChange={e=>{setAcceptStranded(stranded&&e.target.checked);setAcceptTurnover(review.highTurnover&&e.target.checked);}}/>{stranded&&review.highTurnover?'I understand both and want to commit anyway':'I understand and want to commit anyway'}</label>
  <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirming(false)}>Cancel</Button><Button size="sm" className="rounded-full px-4" disabled={busy||strandedBlocks||turnoverBlocks} onClick={()=>{setConfirming(false);void commit();}}>{busy?'Saving…':investment?.status==='active'?'Commit changes':view.currentVersion?'Commit changes':'Commit take'}</Button></div>
 </ConfirmContent></ConfirmDialog>}
 </aside>;
}

export function ProposalCards({messageId,running,onReview}:{messageId:string;running:boolean;onReview:(takeId:string)=>void}){
 const [items,setItems]=useState<{proposal:Proposal;targetTakeId:string}[]>([]);
 const seen=useRef(new Set<string>());const follow=useRef(running);if(running)follow.current=true;const review=useRef(onReview);review.current=onReview;
 useEffect(()=>{let active=true;const load=()=>void window.strategies.messageProposals(messageId).then(rows=>{if(active){setItems(rows);for(const row of rows){if(follow.current&&!seen.current.has(row.proposal.id))review.current(row.targetTakeId);seen.current.add(row.proposal.id);}}}).catch(()=>{});load();const timer=running?setInterval(load,1000):undefined;return()=>{active=false;clearInterval(timer);};},[messageId,running]);
 return <>{items.map(item=><ProposalCard key={item.proposal.id} {...item} onReview={onReview}/>)}</>;
}
// The chat's preview of a portfolio the AI built: what it changed and every
// holding. The take is reviewed and committed in the side panel, which new
// suggestions open while a reply streams and "Apply" opens again; "See
// performance" is the take's own page (chart, key stats, your investment). A
// suggestion that isn't the draft is applied from its own card: the
// same write as the panel history's "Apply", checked against the draft as it is
// when clicked.
// One shared read per take for every card in the chat, refreshed like the panel,
// so each card's applied/committed state follows changes made anywhere.
const takeViews=new Map<string,{view:BasketView|null;listeners:Set<(v:BasketView|null)=>void>;timer?:ReturnType<typeof setInterval>}>();
// The Take panel listens too: a change made from a chat card shows at once, not on the
// next poll (timers are throttled while the window is hidden or covered).
function publishTakeView(id:string,view:BasketView|null){window.dispatchEvent(new CustomEvent('take-view-changed',{detail:{takeId:id}}));const entry=takeViews.get(id);if(!entry)return;entry.view=view;entry.listeners.forEach(listener=>listener(view));}
function useTakeView(id:string){
 const [view,setView]=useState<BasketView|null>(()=>takeViews.get(id)?.view??null);
 useEffect(()=>{
  let entry=takeViews.get(id);if(!entry){entry={view:null,listeners:new Set()};takeViews.set(id,entry);}
  const shared=entry;shared.listeners.add(setView);setView(shared.view);
  if(!shared.timer){const load=()=>void window.strategies.read(id).then(v=>publishTakeView(id,v)).catch(()=>{});load();shared.timer=setInterval(load,1500);}
  return()=>{shared.listeners.delete(setView);if(!shared.listeners.size){clearInterval(shared.timer);takeViews.delete(id);}};
 },[id]);
 return view;
}
function ProposalCard({proposal:p,targetTakeId,onReview}:{proposal:Proposal;targetTakeId:string;onReview:(takeId:string)=>void}){
 const view=useTakeView(targetTakeId),[busy,setBusy]=useState(false),[error,setError]=useState('');
 // "Apply" writes a copy, so the draft is this card's when it is this revision or a copy of it.
 const isThis=(draft:Proposal)=>draft.id===p.id||draft.copiedFrom===p.id;
 const current=!!view&&isThis(view.draft),archived=!!view?.archivedAt;
 // What this suggestion changed, when the revision before it is in the take's loaded history.
 const previous=view?.proposals.find(q=>q.id===p.previousRevision),changes=previous?takeChanges(p,previous):null;
 const before=new Map(previous?.spec.target.weights.map(w=>[instrumentKey(w),w.bps])??[]);
 // Both write a new draft copied from an earlier revision, checked against the draft as it is when clicked.
 async function revise(kind:'use'|'undo'){setBusy(true);setError('');try{
  const latest=await window.strategies.read(targetTakeId);
  if(!latest)throw new Error('This take is no longer available.');
  if(kind==='undo'&&!isThis(latest.draft))throw new Error('The take has changed since this suggestion. Use History in the panel to restore an earlier revision.');
  const target=kind==='use'?p.id:p.previousRevision!;
  if(kind==='undo'||!isThis(latest.draft)){
   const result=await window.strategies.useRevision({targetTakeId,expectedRevision:latest.draft.id,expectedVersion:latest.currentVersion,operationId:crypto.randomUUID(),proposalId:target});
   if(!result.ok)throw new Error(result.message);
   publishTakeView(targetTakeId,result.view);
  }else publishTakeView(targetTakeId,latest);
  onReview(targetTakeId);
 }catch(e){setError(e instanceof Error?e.message:'Could not change the draft.');}finally{setBusy(false);}}
 const committed=!!view&&current&&matchesCommitted(view);
 const status=!view?null:committed?{tone:'success' as const,text:'Committed'}:current?{tone:'attention' as const,text:'Applied · not committed'}:{tone:'muted' as const,text:'Not applied'};
 const strong='font-mono tabular-nums text-foreground';
 return <aside className="rounded-xl border border-border bg-muted/20 p-4" aria-label="Proposed take">
 <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-medium">{p.metadata.title}</h3><p className="text-xs text-muted-foreground">Revision {p.revision}</p></div>
  {status&&<span className={`flex shrink-0 items-center gap-1.5 text-xs ${status.tone==='success'?'text-success':status.tone==='attention'?'text-attention':'text-muted-foreground'}`}><StatusDot tone={status.tone}/>{status.text}</span>}</div>
 {changes&&(!!changes.rows.length||p.metadata.title!==previous!.metadata.title)&&<ul aria-label="What changed" className="mt-3 space-y-1 text-xs text-muted-foreground">
  {changes.rows.map(row=><li key={row.label} className="flex flex-wrap items-baseline gap-x-2"><span className="text-foreground">{row.label}</span>{row.tag==='new'?<>added at <span className={strong}>{row.after}</span></>:row.tag==='removed'?<><s className="font-mono">{row.before}</s> removed</>:<><s className="font-mono">{row.before}</s><span aria-label="to">→</span><span className={strong}>{row.after}</span></>}</li>)}
  {p.metadata.title!==previous!.metadata.title&&<li>Renamed from <s>{previous!.metadata.title}</s></li>}
 </ul>}
 <ul aria-label="Holdings" className="mt-3 divide-y divide-border border-b border-border text-sm">{p.spec.target.weights.map(w=>{const old=before.get(instrumentKey(w)),delta=previous&&old!==undefined?(w.bps-old)/100:null;return <li key={instrumentKey(w)} className="flex items-center gap-3 py-2">
  <VenueBadge venue={w.instrument.venue}/><span className="flex-1 font-medium">{w.instrument.symbol}{w.instrument.market&&<span className="ml-2 text-xs font-normal text-muted-foreground">Crypto</span>}</span>
  {previous&&old===undefined?<span className="text-xs text-muted-foreground">new</span>:delta?<span className="font-mono text-xs text-attention tabular-nums">{delta>0?'+':''}{delta}</span>:null}
  <span className="w-12 text-right font-mono tabular-nums">{w.bps/100}%</span></li>;})}
  {p.spec.target.cashBps>0&&<li className="flex items-center gap-3 py-2 text-muted-foreground"><span aria-hidden="true" className="size-5 shrink-0 rounded-full bg-muted"/><span className="flex-1">Cash</span><span className="w-12 text-right font-mono tabular-nums">{p.spec.target.cashBps/100}%</span></li>}</ul>
 <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
  {view&&!current&&!archived&&<button type="button" disabled={busy} onClick={()=>void revise('use')} className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background disabled:opacity-40">{busy?'Applying…':'Apply'}</button>}
  {current&&!archived&&p.previousRevision&&<button type="button" disabled={busy} onClick={()=>void revise('undo')} className="text-muted-foreground hover:text-foreground disabled:opacity-40">{busy?'Undoing…':'Undo'}</button>}
  <Link to="/strategies/$strategyId" params={{strategyId:p.strategyId}} className="text-muted-foreground hover:text-foreground">See performance</Link>
 </div>{error&&<p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}</aside>;
}
/** Where a holding trades, as a small lettered badge. */
function VenueBadge({venue}:{venue:string}){
 const style=venue==='robinhood'?'bg-[#00c805] text-black':venue==='coinbase'?'bg-[#0052ff] text-white':'bg-muted text-muted-foreground';
 return <span title={venue.charAt(0).toUpperCase()+venue.slice(1)} className={`grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-bold uppercase ${style}`}>{venue.charAt(0)}</span>;
}

// What changed between two versions of a take, in the terms the take view shows:
// rows with a before and after, a rename, and whether only wording changed. The AI
// rewrites its explanations with most changes, so those edits are tracked, not listed.
type ChangeRow={label:string;before:string;after:string;tag?:'new'|'removed';muted?:boolean};
function takeChanges(p:ProposalPayload,previous:ProposalPayload):{rows:ChangeRow[];notes:string[];reworded:boolean}{
 const key=instrumentKey,pct=(bps:number)=>`${bps/100}%`,schedule=(v:string)=>v.charAt(0).toUpperCase()+v.slice(1);
 const mixed=[...p.spec.target.weights,...previous.spec.target.weights].some(w=>w.instrument.venue!=='robinhood');
 const label=(w: {instrument:StrategyInstrument})=>w.instrument.market?`${w.instrument.symbol} · Robinhood crypto`:mixed?`${w.instrument.symbol} · ${w.instrument.venue}`:w.instrument.symbol;
 const before=new Map(previous.spec.target.weights.map(w=>[key(w),w])),after=new Set(p.spec.target.weights.map(key)),rows:ChangeRow[]=[],notes:string[]=[];
 for(const w of p.spec.target.weights){const old=before.get(key(w));if(!old)rows.push({label:label(w),before:'—',after:pct(w.bps),tag:'new'});else if(old.bps!==w.bps)rows.push({label:label(w),before:pct(old.bps),after:pct(w.bps)});}
 for(const w of previous.spec.target.weights)if(!after.has(key(w)))rows.push({label:label(w),before:pct(w.bps),after:'—',tag:'removed'});
 if(p.spec.target.cashBps!==previous.spec.target.cashBps)rows.push({label:'Cash',before:pct(previous.spec.target.cashBps),after:pct(p.spec.target.cashBps),muted:true});
 if(p.spec.rebalance.schedule!==previous.spec.rebalance.schedule)rows.push({label:'Rebalance',before:schedule(previous.spec.rebalance.schedule),after:schedule(p.spec.rebalance.schedule)});
 if(driftLabel(p.spec.rebalance)!==driftLabel(previous.spec.rebalance))rows.push({label:'Drift bands',before:driftLabel(previous.spec.rebalance),after:driftLabel(p.spec.rebalance)});
 if(p.metadata.title!==previous.metadata.title)notes.push(`Renamed to “${p.metadata.title}”`);
 const reworded=p.metadata.description!==previous.metadata.description||p.metadata.rationale!==previous.metadata.rationale
  ||JSON.stringify(p.metadata.holdings)!==JSON.stringify(previous.metadata.holdings)||JSON.stringify(p.unsupportedRequests)!==JSON.stringify(previous.unsupportedRequests);
 return {rows,notes,reworded};
}
// A draft restored from the committed version is a new revision that changes
// nothing, so it reads as committed rather than as uncommitted changes.
function matchesCommitted(view:BasketView){
 if(view.clean)return true;
 const committed=view.versions.find(v=>v.id===view.currentVersion)?.payload;if(!committed)return false;
 const {rows,notes,reworded}=takeChanges(view.draft,committed);return !rows.length&&!notes.length&&!reworded;
}
// The same changes as one line each, for chat cards and history.
/** A Take change a rule's agent suggested while no one was watching. The draft is
 *  untouched until the member applies it (checked against the draft as it is then). */
function RuleSuggestions({view,busy,onApply,onDismiss}:{view:BasketView;busy:boolean;onApply:(proposalId:string)=>void;onDismiss:(proposalId:string)=>void}){
 return <section aria-label="Suggested changes" className="space-y-2">{view.suggestions!.map(s=>{
  const p=view.proposals.find(q=>q.id===s.proposalId);if(!p)return null;
  const changes=revisionChanges(p,view.draft),ago=Math.max(1,Math.round((Date.now()-Date.parse(s.createdAt))/60000));
  return <div key={s.proposalId} className="rounded-lg border border-attention/25 bg-attention/10 p-3 text-sm">
   <p className="flex items-center gap-1.5 text-xs font-medium text-attention"><span className="size-1.5 rounded-full bg-attention" aria-hidden="true"/>Suggested by rule “{s.ruleName??'Rule agent'}” · {ago<60?`${ago} m`:ago<1440?`${Math.round(ago/60)} h`:`${Math.round(ago/1440)} d`} ago</p>
   {changes.length?<ul className="mt-1.5 space-y-0.5">{changes.map(c=><li key={c}>{c}</li>)}</ul>:<p className="mt-1.5 text-muted-foreground">Same as your current draft.</p>}
   {s.note&&<p className="mt-1.5 text-xs">{s.note}</p>}
   <p className="mt-1.5 text-xs text-muted-foreground">Applying makes it your draft{view.clean?'':', replacing your uncommitted changes'}. Nothing is committed or traded until you commit.</p>
   <div className="mt-2 flex gap-2"><button type="button" disabled={busy||!changes.length} onClick={()=>onApply(s.proposalId)} className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background disabled:opacity-40">Apply</button>
    <button type="button" disabled={busy} onClick={()=>onDismiss(s.proposalId)} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">Dismiss</button></div>
  </div>;})}</section>;
}
function revisionChanges(p:ProposalPayload,previous:ProposalPayload):string[]{
 const {rows,notes}=takeChanges(p,previous);
 return [...rows.map(row=>row.tag==='new'?`Added ${row.label} at ${row.after}`:row.tag==='removed'?`Removed ${row.label} (was ${row.before})`:`${row.label} ${row.before} → ${row.after}`),...notes];
}
// Everything committing the draft changes from the committed version.
// The take's revisions, newest first, each as what changed rather than the whole take.
function TakeHistory({view,older,busy,readOnly,error,onUse,onLoadOlder}:{view:BasketView;older:HistoryPage;busy:boolean;readOnly:boolean;error:string;onUse:(p:Proposal)=>void;onLoadOlder:()=>void}){
 const proposals=[...view.proposals,...older.proposals.filter(p=>!view.proposals.some(q=>q.id===p.id))].sort((a,b)=>b.revision-a.revision);
 const versions:StrategyVersion[]=[...view.versions,...older.versions.filter(v=>!view.versions.some(q=>q.id===v.id))];
 const at=(value:string)=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
 return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 text-sm">
 <RuleRunHistory takeId={view.targetTakeId}/>
 {error&&<p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
 <ol className="divide-y divide-border">{proposals.map(p=>{
  const previous=proposals.find(q=>q.id===p.previousRevision),restored=p.copiedFrom?proposals.find(q=>q.id===p.copiedFrom):undefined;
  const changes=previous?revisionChanges(p,previous):null,committed=versions.filter(v=>v.proposalId===p.id),current=p.id===view.draft.id;
  const by=p.producer==='human'?'You':p.producer==='rule'?`Rule “${String((p.producerIdentity.rule as {ruleName?:string}|undefined)?.ruleName??'')}”`:[p.producerIdentity.provider,p.producerIdentity.model].filter(Boolean).map(String).join(' · ')||'AI';
  return <li key={p.id} className="py-4 first:pt-0"><article aria-label={`Revision ${p.revision}`} className="space-y-2">
   <div className="flex items-baseline justify-between gap-3"><h3 className="font-medium">Revision {p.revision}</h3><span className="shrink-0 text-xs text-muted-foreground">{at(p.createdAt)}</span></div>
   <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{by}</span>{current&&<span className="rounded-full bg-attention/10 px-2 font-medium text-attention">Current draft</span>}{committed.map(v=><span key={v.id} className="rounded-full bg-success/10 px-2 font-medium text-success">Committed · v{v.sequence}</span>)}</p>
   {restored&&<p className="text-xs text-muted-foreground">Restored from revision {restored.revision}</p>}
   {changes===null?<p className="text-muted-foreground">{p.previousRevision?'Load older revisions to see what changed.':`Created with ${p.spec.target.weights.map(w=>`${w.instrument.symbol} ${w.bps/100}%`).join(', ')}${p.spec.target.cashBps?`, cash ${p.spec.target.cashBps/100}%`:''}`}</p>
    :changes.length?<ul className="space-y-1">{changes.map(c=><li key={c}>{c}</li>)}</ul>:<p className="text-muted-foreground">{previous&&takeChanges(p,previous).reworded?'Only the wording changed.':'No changes to the take.'}</p>}
   {(!current&&!readOnly||p.sourceMessageId)&&<div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
    {!current&&!readOnly&&<button disabled={busy} className="font-medium text-foreground underline underline-offset-4 disabled:opacity-40" onClick={()=>onUse(p)}>Apply</button>}
    {p.sourceMessageId&&<SourceMessage proposal={p}/>}
   </div>}
  </article></li>;})}</ol>
 {view.historyTruncated&&(!older.proposals.length||older.nextRevision!==null)&&<button disabled={busy} className="mt-2 text-sm underline" onClick={onLoadOlder}>Load older revisions</button>}
 </div>;
}
function SourceMessage({proposal}:{proposal:Proposal}){
 const [text,setText]=useState('Loading…');
 return <Dialog onOpenChange={open=>{if(open)void window.strategies.source(proposal.id).then(message=>setText((message&&splitReplies(message.text).text)||'This response contains the proposed take without additional text.')).catch(()=>setText('Source message could not be loaded.'));}}><DialogTrigger className="underline underline-offset-4">View source message</DialogTrigger><DialogContent><DialogTitle>Source message</DialogTitle><p className="whitespace-pre-wrap">{text}</p><p className="text-xs text-muted-foreground">Message {proposal.sourceMessageId}</p></DialogContent></Dialog>;
}

// One consequence of committing, as the confirmation dialog lists them.
function CommitConsequence({title,body,action}:{title:string;body:string;action?:React.ReactNode}){
 return <div className="flex gap-3 py-3 first:pt-0"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-attention/15"><TriangleAlert size={13} className="text-attention"/></span>
 <div className="min-w-0 text-sm"><p className="font-medium">{title}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{body}</p>{action}</div></div>;
}
function mergeHistory(old:HistoryPage,page:HistoryPage):HistoryPage{
 return {proposals:[...new Map([...old.proposals,...page.proposals].map(p=>[p.id,p])).values()].sort((a,b)=>b.revision-a.revision),versions:[...new Map([...old.versions,...page.versions].map(v=>[v.id,v])).values()].sort((a,b)=>b.sequence-a.sequence),nextRevision:page.nextRevision};
}
