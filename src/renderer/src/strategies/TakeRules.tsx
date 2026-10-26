import {useNavigate} from '@tanstack/react-router';
import {money} from '../portfolio/format';
import {claimApprovalNavigation} from './rule-approval-navigation';
import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {StatusDot} from '../components/chat/StatusDot';
import type {RuleProposal,RuleReview,RuleTradeApproval} from '../../../shared/rule-proposals';
import {RulesDialog,ago,changedRules,isOff,rulesChanged,whenText,type RulesMode} from './RulesWindow';
import type {StrategyRule} from '../../../shared/strategy-rules';
const errorText=(error:unknown)=>error instanceof Error?error.message:'Could not load Take rules.';
/** Open a Take's Rules window from elsewhere (chat's proposal card). */
export const openTakeRules=(takeId:string,review=false,ruleId?:string)=>window.dispatchEvent(new CustomEvent('open-take-rules',{detail:{takeId,review,ruleId}}));

/** The Rules entry in the Take panel: a summary that opens the Rules window. */
export function TakeRules({takeId,strategyId,title,readOnly=false}:{takeId:string;strategyId:string;title:string;readOnly?:boolean}){
 const navigate=useNavigate();
 const [view,setView]=useState<RuleReview|null>(null),[error,setError]=useState('');
 const [open,setOpen]=useState(false),[mode,setMode]=useState<RulesMode>({kind:'rules'});
 useEffect(()=>{let live=true;const load=()=>void window.dataSources.configure({action:'rule-review',takeId}).then(v=>{if(live){setView(v as RuleReview);setError('');}}).catch(e=>{if(live)setError(errorText(e));});load();window.addEventListener('take-rules-changed',load);const timer=setInterval(load,3000);
  // Timers are throttled while the window is hidden or covered: catch up when it shows again.
  const visible=()=>{if(document.visibilityState==='visible')load();};document.addEventListener('visibilitychange',visible);
  return()=>{live=false;clearInterval(timer);window.removeEventListener('take-rules-changed',load);document.removeEventListener('visibilitychange',visible);};},[takeId]);
 useEffect(()=>{const show=(event:Event)=>{const detail=(event as CustomEvent<{takeId:string;review:boolean;ruleId?:string}>).detail;if(detail?.takeId!==takeId)return;setMode({kind:detail.review?'review':'rules',ruleId:detail.ruleId});setOpen(true);};window.addEventListener('open-take-rules',show);return()=>window.removeEventListener('open-take-rules',show);},[takeId]);
 useEffect(()=>{
  const reviewId=claimApprovalNavigation(view?.lifecycle,readOnly,sessionStorage);
  if(reviewId)void navigate({to:'/strategies/$strategyId',params:{strategyId},hash:'order-review'}).catch(()=>{sessionStorage.removeItem(`rule-approval-navigation:${reviewId}`);});
 },[view?.lifecycle,readOnly,strategyId,navigate]);
 const rules=view?.config.rules??[],proposal=view?.proposals[0],changes=proposal?changedRules(proposal):[];
 const show=(next:RulesMode)=>{setMode(next);setOpen(true);};
 const rowClass='flex w-full items-start gap-3 border-t border-border py-3 text-left';
 return <section aria-label="Take rules" className="text-sm">
  <div className="flex items-center justify-between gap-2 pb-3"><p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Rules</p>
   <button type="button" disabled={!view} onClick={()=>show({kind:'rules'})} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40">Open<ArrowUpRight size={13} aria-hidden="true"/></button></div>
  {error&&<p role="alert" className="pb-3 text-xs text-destructive">{error}</p>}
  {!view?<p className="border-t border-border py-3 text-xs text-muted-foreground">Loading rules…</p>:<>
   <TradeApprovals takeId={takeId} readOnly={readOnly}/>
   {!rules.length&&!proposal&&<p className="border-t border-border py-3 text-xs text-muted-foreground">No rules yet. Ask chat what this Take should watch for.</p>}
   {!!rules.length&&<ul>{rules.map(r=>{const life=view.lifecycle?.[r.id],off=isOff(view,r.id),attention=life?.status==='Needs attention'||life?.status==='Awaiting approval',removed=changes.some(c=>c.id===r.id&&c.kind==='Removed');
    const status=removed?<span className="text-attention">Removing</span>:off?<span className="text-destructive">Off</span>:life?.status&&life.status!=='Waiting'?<span className={attention?'text-attention':''}>{life.status}</span>:life?.lastAt?<span className="tabular-nums">{r.action.kind==='notify'?'Alerted':'Ran'} {ago(life.lastAt)}</span>:null;
    return <li key={r.id}><button type="button" data-rule-id={r.id} onClick={()=>show({kind:'rules',ruleId:r.id})} className={`${rowClass} group`}>
     <span className={`mt-1.5 size-2 shrink-0 rounded-full ${off?'bg-destructive':attention||removed?'bg-attention':'bg-success'}`} aria-hidden="true"/>
     <span className="min-w-0 flex-1"><span className={`block truncate font-medium group-hover:underline ${removed?'text-muted-foreground line-through':off?'text-muted-foreground':''}`}>{r.name}</span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{ruleSummary(r,view)}</span></span>
     <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
    </button></li>;})}</ul>}
   {proposal&&<button type="button" onClick={()=>show({kind:'review'})} className={`${rowClass} items-center text-attention`}><span className="size-2 shrink-0 rounded-full bg-attention" aria-hidden="true"/><span className="min-w-0 flex-1">{changes.length||1} proposed {(changes.length||1)===1?'change':'changes'} from chat{changes.some(c=>c.permission)?' · permission change':''}</span><span className="shrink-0 font-medium">Review</span></button>}
   {view.stale&&!proposal&&<p role="status" className="border-t border-border py-3 text-xs text-attention">Take or sources changed. Ask chat to update these rules.</p>}
   <RulesDialog open={open} onOpenChange={setOpen} takeId={takeId} strategyId={strategyId} title={title} view={view} mode={mode} setMode={setMode} readOnly={readOnly} onView={setView}/>
  </>}
 </section>;
}

/** Rule and agent trades waiting for the member, the same on every venue. */
function TradeApprovals({takeId,readOnly}:{takeId:string;readOnly:boolean}){
 const [items,setItems]=useState<RuleTradeApproval[]>([]),[busy,setBusy]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let live=true;const load=()=>void window.dataSources.configure({action:'rule-trade-approvals',takeId}).then(v=>{if(live)setItems(v as RuleTradeApproval[]);}).catch(()=>{});
  load();const timer=setInterval(load,3000);window.addEventListener('take-rules-changed',load);return()=>{live=false;clearInterval(timer);window.removeEventListener('take-rules-changed',load);};},[takeId]);
 async function decide(requestId:string,approve:boolean){setBusy(requestId);setError('');try{await window.dataSources.configure({action:'rule-trade-decide',takeId,requestId,approve});setItems(old=>old.filter(i=>i.requestId!==requestId));rulesChanged();}catch(e){setError(e instanceof Error?e.message:'Could not save your decision.');}finally{setBusy('');}}
 if(!items.length)return null;
 const what=(a:RuleTradeApproval)=>a.kind==='reduce'?`reduce by ${money(a.amount)}`:a.kind==='deploy_cash'?`invest ${money(a.amount)} of the Take’s cash`:'rebalance';
 return <div aria-label="Trades waiting for approval">{items.map(a=><div key={a.requestId} role="region" aria-label="Trade approval" className="border-t border-border py-3">
  <p className="flex items-center gap-2 font-medium"><span className="size-2 shrink-0 rounded-full bg-attention" aria-hidden="true"/>Rule “{a.ruleName??'Rule'}” wants to {what(a)}</p>
  <p className="mt-0.5 pl-4 text-xs text-muted-foreground">{a.venue==='coinbase'?'Coinbase':'Robinhood'} · {a.orders.map(o=>`${o.side==='buy'?'Buy':'Sell'} ${o.symbol}${o.amountUsd?` ${money(o.amountUsd)}`:''}`).join(', ')}</p>
  {a.venue==='robinhood'&&<p className="mt-0.5 pl-4 text-[11px] text-muted-foreground">Estimated; the orders are sized again when placed.</p>}
  <div className="mt-2 flex gap-2 pl-4"><button type="button" disabled={readOnly||!!busy} onClick={()=>void decide(a.requestId,true)} className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background disabled:opacity-40">{busy===a.requestId?'Saving…':'Approve'}</button>
   <button type="button" disabled={readOnly||!!busy} onClick={()=>void decide(a.requestId,false)} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">Decline</button></div>
 </div>)}{error&&<p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}</div>;
}

/** "Below 80,000 → notify me": the trigger and what happens, short enough for one line. */
function ruleSummary(rule:StrategyRule,view:RuleReview){
 const t=rule.trigger,number=(v:string)=>Number(v).toLocaleString('en-US',{maximumFractionDigits:8});
 const when=t.kind==='threshold'?<>{t.operator.endsWith('below')?'Below':'Above'} <span className="font-mono">{number(t.value)}</span></>:whenText(rule,view.inputs);
 return <>{when} → {actionSummary(rule,view)}</>;
}
function actionSummary(rule:StrategyRule,view:RuleReview){
 const a=rule.action,granted=!!view.tradingRuleIds?.includes(rule.id),asks=rule.policy.approval==='ask'||!!view.confirmTrades;
 const how=granted?asks?', asks first':', no asking':', preview only';
 if(a.kind==='notify')return 'notify me';
 if(a.kind==='request_review')return 'ask me to review';
 if(a.kind==='agent')return a.capabilities.actions.includes('rebalance_to_target')?`agent checks, may rebalance${how}`:'agent checks';
 return `${a.kind==='rebalance_to_target'?'rebalance':a.kind.replaceAll('_',' ')}${how}`;
}

export function RuleProposalCards({messageId,running}:{messageId:string;running:boolean}){
 const [items,setItems]=useState<RuleProposal[]>([]);
 const pending=items.some(item=>item.status==='pending');
 const announced=useRef(new Set<string>());
 // A new pending proposal is announced once, so the Rules section shows it without waiting for its poll.
 useEffect(()=>{let live=true;const load=()=>void window.dataSources.configure({action:'rule-message-proposals',messageId}).then(rows=>{if(!live)return;const list=rows as RuleProposal[];setItems(list);
  const fresh=list.filter(p=>p.status==='pending'&&!announced.current.has(p.id));fresh.forEach(p=>announced.current.add(p.id));if(fresh.length)rulesChanged();}).catch(()=>{});load();const timer=running||pending?setInterval(load,running?1000:3000):undefined;window.addEventListener('take-rules-changed',load);return()=>{live=false;clearInterval(timer);window.removeEventListener('take-rules-changed',load);};},[messageId,running,pending]);
 const line='flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground';
 return <>{items.map(p=><aside key={p.id} aria-label="Rule proposal status" className={line}>
 {p.status==='pending'?<><StatusDot tone="attention"/><span>Rule changes proposed · waiting for you</span><button type="button" onClick={()=>openTakeRules(p.takeId,true)} className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">Review changes</button></>
 :p.status==='accepted'?<><StatusDot tone="success"/><span>Rule changes accepted</span><button type="button" onClick={()=>openTakeRules(p.takeId)} className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">Open rules</button></>
 :p.status==='dismissed'?<><StatusDot tone="muted"/><span>Proposal dismissed</span></>
 :<><StatusDot tone="muted"/><span><s>Earlier proposal</s> superseded by a newer one</span></>}
 </aside>)}</>;
}
