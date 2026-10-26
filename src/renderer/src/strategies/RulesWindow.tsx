// The Rules window: every accepted rule with its own On/Off, its
// permissions, activity and settings, and the review of chat's proposed changes.
// Rules change only through chat proposals; the member switches, deletes and accepts.
import {useNavigate,Link} from '@tanstack/react-router';
import {Switch} from '@base-ui/react/switch';
import {Fragment,useEffect,useState,type ReactNode} from 'react';
import {ChevronRight,X} from 'lucide-react';
import {assetAmount,money} from '../portfolio/format';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '../components/ui/app-dialog';
import {supportsRuleTrade,type StrategyRule} from '../../../shared/strategy-rules';
import {duration,triggerText} from '../../../shared/rule-display';
import {actionName,actionText} from './rule-action-text';
import type {RuleActivityItem,RuleProposal,RuleReview} from '../../../shared/rule-proposals';
import type {TakeInputsConfig} from '../../../shared/take-inputs';

type ConfigureRequest=Parameters<typeof window.dataSources.configure>[0];
type Limits={durationMs:number;toolCalls:number;modelTurns:number;costUsd:number;outputTokens:number};
export type RulesMode={kind:'rules';ruleId?:string}|{kind:'review';ruleId?:string};
const errorText=(error:unknown)=>error instanceof Error?error.message:'Could not update rules.';
export const rulesChanged=()=>window.dispatchEvent(new Event('take-rules-changed'));

/** Numbers read in monospace, as in the rest of the money UI. */
function Mono({text}:{text:string}){return <>{text.split(/(\$?-?\d+(?:,\d{3})*(?:\.\d+)?%?)/).map((part,i)=>i%2?<span key={i} className="font-mono">{part}</span>:<Fragment key={i}>{part}</Fragment>)}</>;}
export function ago(iso:string,now=Date.now()){const s=Math.max(0,Math.round((now-Date.parse(iso))/1000));return s<60?'now':s<3600?`${Math.floor(s/60)} m`:s<86400?`${Math.floor(s/3600)} h`:`${Math.floor(s/86400)} d`;}
const stamp=(iso:string)=>new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const productOf=(rule:StrategyRule,inputs:TakeInputsConfig)=>inputs.inputs.find(i=>i.key===rule.trigger.input)?.feedId.match(/^price:([A-Z0-9]+)-USD$/)?.[1];
const usd=(value:number|string)=>money(value).replace(/\.00$/,'');
const tokens=(n:number)=>n>=1000?`${Math.round(n/1000)}k`:String(n);
const toolName=(name:string)=>{const s=name.replace(/^opentake_/,'').replaceAll('_',' ');return s.charAt(0).toUpperCase()+s.slice(1);};
export function whenText(rule:StrategyRule,inputs:TakeInputsConfig){const product=productOf(rule,inputs);return triggerText(rule).replace(rule.trigger.input.replaceAll('_',' '),product??rule.trigger.input.replaceAll('_',' '));}
/** How a rule re-arms: short ("above 80,000") and as a clause ("BTC is back above 80,000"). */
function reset(rule:StrategyRule,inputs:TakeInputsConfig){const t=rule.trigger,product=productOf(rule,inputs)??t.input.replaceAll('_',' ');
 if(t.kind==='threshold'){const side=t.operator.endsWith('below')?'above':'below',value=Number(t.resetValue??t.value).toLocaleString('en-US',{maximumFractionDigits:8});return {short:`${side} ${value}`,long:`${product} is back ${side} ${value}`};}
 return t.kind==='event'?{short:`per new ${t.eventIdField}`,long:`a new ${t.eventIdField} arrives`}:{short:'after another change',long:`${product} changes again`};}
const ruleAccounts=(rule:StrategyRule)=>rule.action.kind==='agent'?rule.action.capabilities.accountIds:'scope' in rule.action?[rule.action.scope.accountId]:[];
const trades=(rule:StrategyRule)=>supportsRuleTrade(rule)||rule.action.kind==='agent'&&rule.action.capabilities.actions.some(a=>['buy','trim','exit','rebalance_to_target','deploy_cash'].includes(a));
/** What the rule may do, in the member's words: the grant and confirmation decide it. */
export function abilityText(rule:StrategyRule,view:RuleReview){
 if(rule.action.kind==='notify')return 'notifies you';
 if(rule.action.kind==='request_review')return 'asks you to review';
 if(['buy','trim','exit'].includes(rule.action.kind))return 'suggests a new target';
 const granted=!!view.tradingRuleIds?.includes(rule.id)&&trades(rule);
 if(!granted)return rule.action.kind==='agent'?'agent assesses, no trading':'preview only';
 return rule.policy.approval==='ask'||view.confirmTrades?'trades after you approve':'trades without asking';
}
const shortStatus:Record<string,string>={'Awaiting approval':'Approve','Needs attention':'Attention','In progress':'Running',Finished:'Done',Waiting:''};
/** What keeps a Take at a target a buy/trim/exit rule suggests. */
export function keepersText(view:RuleReview){
 const k=[view.rebalancing&&view.rebalancing.schedule!=='never'?`the ${view.rebalancing.schedule} rebalance`:'',view.rebalancing?.drift?'the drift band':'',
  ...view.config.rules.filter(r=>!isOff(view,r.id)&&(r.action.kind==='rebalance_to_target'||r.action.kind==='agent'&&r.action.capabilities.actions.includes('rebalance_to_target'))).map(r=>`rule “${r.name}”`)].filter(Boolean);
 return k.length?`Once you commit it, ${k.join(', ')} will keep the Take there.`:'This Take does not rebalance by itself; after committing, rebalance it to reach the new target.';
}
export function isOff(view:RuleReview,ruleId:string){return !!view.disabledRuleIds?.includes(ruleId);}
export function changedRules(p:RuleProposal){
 const ids=[...new Set([...p.config.rules.map(r=>r.id),...p.before.rules.map(r=>r.id)])];
 return ids.flatMap(id=>{const before=p.before.rules.find(r=>r.id===id),after=p.config.rules.find(r=>r.id===id);
  if(JSON.stringify(before)===JSON.stringify(after))return [];
  // A trading rule that is new, or whose action or approval changed, changes what may trade.
  const permission=!!after&&trades(after)&&(!before||JSON.stringify(before.action)!==JSON.stringify(after.action)||before.policy.approval!==after.policy.approval);
  return [{id,before,after,kind:!before?'Added' as const:!after?'Removed' as const:'Edited' as const,permission}];
 });
}

function Toggle({label,checked,disabled,onChange}:{label:string;checked:boolean;disabled?:boolean;onChange:(value:boolean)=>void}){
 return <Switch.Root aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} className="inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-muted p-0.5 data-checked:bg-primary disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring"><Switch.Thumb className="size-4 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-4 data-checked:bg-primary-foreground"/></Switch.Root>;
}
function Rows({rows}:{rows:[string,ReactNode][]}){
 return <dl className="divide-y divide-border text-sm">{rows.map(([name,value])=><div key={name} className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 py-2.5"><dt className="text-muted-foreground">{name}</dt><dd className="min-w-0 break-words [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>;
}

/** One line for a firing: what happened, and whether it needs the member. */
export function activityLine(item:RuleActivityItem):{text:string;tone:'ok'|'attention'|'muted'}{
 const reason=(item.job?.reason??item.trade?.reason??'').replaceAll('_',' ');
 if(item.job?.state==='blocked'&&item.job.reason==='token_limit_required')return {text:'Didn’t run · needs a token limit set',tone:'attention'};
 if(item.job?.state==='blocked'&&item.job.reason==='rule_off')return {text:'Didn’t run · the rule was off',tone:'muted'};
 if(item.job?.state==='blocked'||item.job?.state==='failed')return {text:`Didn’t run · ${reason||'blocked'}`,tone:'attention'};
 if(item.trade?.state==='attention'||item.job?.state==='needs_attention')return {text:`Needs attention · ${reason||'check the order'}`,tone:'attention'};
 if(item.fills.length)return {text:`Rebalanced · ${item.fills.map(f=>`${f.side==='sell'?'sold':'bought'} ${assetAmount(f.quantity,f.product.replace(/-USDC?$/,''))}`).join(', ')}, filled`,tone:'ok'};
 if(item.trade?.state==='completed')return {text:item.trade.reason==='already_on_target'?'Already on target · nothing to trade':'Rebalanced',tone:'ok'};
 if(item.job?.kind==='agent_run'&&item.job.state==='succeeded')return {text:'Agent ran · read its answer in the thread',tone:'ok'};
 if(item.job?.state==='running'||item.trade?.state==='working')return {text:'Running',tone:'ok'};
 if(item.job?.state==='waiting')return {text:`Waiting · ${(item.job.waitingFor??'').replaceAll('_',' ')}`,tone:'muted'};
 const status:Record<string,[string,'ok'|'attention'|'muted']>={executed:[item.actionKind==='notify'?'Alerted you':'Done','ok'],shadow:[item.actionKind==='notify'?'Alerted you':'Matched','ok'],superseded:['Replaced before it ran','muted'],expired:['Expired before a decision','muted'],conditions_false:['Matched · conditions not met','muted'],context_failed:['Matched · context unavailable','attention'],context_pending:['Gathering context','muted'],action_blocked:['Didn’t run · blocked','attention']};
 const [text,tone]=status[item.status]??[item.status.replaceAll('_',' '),'muted'];return {text,tone};
}

export function RulesDialog({open,onOpenChange,takeId,strategyId,title,view,mode,setMode,readOnly,onView}:{open:boolean;onOpenChange:(open:boolean)=>void;takeId:string;strategyId:string;title:string;view:RuleReview;mode:RulesMode;setMode:(mode:RulesMode)=>void;readOnly:boolean;onView:(view:RuleReview)=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function call(request:ConfigureRequest){setBusy(true);setError('');try{const next=await window.dataSources.configure(request) as RuleReview;onView(next);rulesChanged();return next;}catch(e){setError(errorText(e));return null;}finally{setBusy(false);}}
 const proposal=view.proposals[0];
 const review=mode.kind==='review'&&proposal;
 return <Dialog open={open} onOpenChange={next=>{if(!busy)onOpenChange(next);}}>
  <DialogContent showCloseButton={false} className="flex h-[min(720px,calc(100vh-4rem))] w-[min(980px,calc(100vw-4rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
   {review?<ReviewPane view={view} proposal={proposal} title={title} busy={busy||readOnly} error={error} selected={mode.ruleId} select={ruleId=>setMode({kind:'review',ruleId})} close={()=>onOpenChange(false)}
     back={()=>setMode({kind:'rules'})} decide={async decision=>{const next=await call({action:'rule-proposal-decide',id:proposal.id,decision});if(next)setMode({kind:'rules'});}}/>
   :<RulesPane view={view} takeId={takeId} strategyId={strategyId} title={title} busy={busy} readOnly={readOnly} error={error} selected={mode.ruleId} select={ruleId=>setMode({kind:'rules',ruleId})}
     close={()=>onOpenChange(false)} openReview={()=>setMode({kind:'review'})} call={call}/>}
  </DialogContent>
 </Dialog>;
}

function Header({title,subtitle,children,close}:{title:string;subtitle:ReactNode;children?:ReactNode;close:()=>void}){
 return <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
  <div className="min-w-0"><DialogTitle className="text-base font-semibold">{title}</DialogTitle><DialogDescription className="mt-1 truncate text-xs">{subtitle}</DialogDescription></div>
  <div className="flex shrink-0 items-center gap-4">{children}<button type="button" aria-label="Close" onClick={close} className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><X size={16} aria-hidden="true"/></button></div>
 </header>;
}

function RulesPane({view,takeId,strategyId,title,busy,readOnly,error,selected,select,close,openReview,call}:{view:RuleReview;takeId:string;strategyId:string;title:string;busy:boolean;readOnly:boolean;error:string;selected?:string;select:(id:string)=>void;close:()=>void;openReview:()=>void;call:(request:ConfigureRequest)=>Promise<RuleReview|null>}){
 const rules=view.config.rules,proposal=view.proposals[0];
 const changes=proposal?changedRules(proposal):[];
 const rule=rules.find(r=>r.id===selected)??rules[0];
 const on=rules.filter(r=>!isOff(view,r.id)).length;
 const [tab,setTab]=useState<'Overview'|'Permissions'|'Activity'|'Settings'>('Overview');
 const [deleting,setDeleting]=useState(false);
 useEffect(()=>{setTab('Overview');},[rule?.id]);
 return <>
  <Header title="Rules" subtitle={<>{title} · {on} on{rules.length-on?` · ${rules.length-on} off`:''}</>} close={close}>
   {proposal&&<button type="button" onClick={openReview} className="flex items-center gap-1.5 text-xs font-medium text-attention hover:underline"><span className="size-1.5 rounded-full bg-attention" aria-hidden="true"/>{changes.length} {changes.length===1?'change':'changes'} to review</button>}
  </Header>
  {error&&<p role="alert" className="border-b border-border px-6 py-2 text-xs text-destructive">{error}</p>}
  {view.stale&&<p role="status" className="border-b border-border px-6 py-2 text-xs text-attention">The Take or its sources changed. Ask chat to update these rules.</p>}
  {!rule?<div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">No rules yet. Ask chat what this Take should watch for.</div>:
  <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
   <nav aria-label="Rules" className="min-h-0 overflow-y-auto border-r border-border p-2">
    {rules.map(r=>{const life=view.lifecycle?.[r.id],removed=changes.some(c=>c.id===r.id&&c.kind==='Removed'),pending=changes.some(c=>c.id===r.id);
     return <button key={r.id} type="button" data-rule-id={r.id} aria-current={r.id===rule.id?'true':undefined} onClick={()=>select(r.id)}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/60 ${r.id===rule.id?'bg-muted':''}`}>
      <span className={`min-w-0 flex-1 truncate ${removed?'text-muted-foreground line-through':isOff(view,r.id)?'text-muted-foreground':''}`}>{r.name}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
       {pending&&<span className="size-1.5 rounded-full bg-attention" title="Pending change" aria-label="Pending change"/>}
       {isOff(view,r.id)?'Off':life?.status&&life.status!=='Waiting'?<span className={life.status==='Needs attention'||life.status==='Awaiting approval'?'text-attention':''}>{shortStatus[life.status]}</span>:life?.lastAt?<span className="tabular-nums">{ago(life.lastAt)}</span>:null}
      </span>
     </button>;})}
   </nav>
   <section aria-label={rule.name} className="flex min-h-0 flex-col">
    <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5">
     <div className="min-w-0"><h3 className="truncate text-base font-semibold">{rule.name}</h3>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><span className={`size-1.5 rounded-full ${isOff(view,rule.id)?'bg-muted-foreground/50':view.lifecycle?.[rule.id]?.status==='Needs attention'?'bg-attention':'bg-success'}`} aria-hidden="true"/>{isOff(view,rule.id)?'Off':'On'} · {abilityText(rule,view)}{view.lifecycle?.[rule.id]?.status&&view.lifecycle[rule.id].status!=='Waiting'?` · ${view.lifecycle[rule.id].status}`:''}</p></div>
     <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">{isOff(view,rule.id)?'Off':'On'}<Toggle label={`${rule.name} on`} checked={!isOff(view,rule.id)} disabled={busy||readOnly||view.stale} onChange={enabled=>void call({action:'rule-set-enabled',takeId,ruleId:rule.id,enabled})}/></label>
    </div>
    <div role="tablist" aria-label="Rule details" className="mt-4 flex shrink-0 gap-5 border-b border-border px-6">
     {(['Overview','Permissions','Activity','Settings'] as const).map(name=><button key={name} type="button" role="tab" aria-selected={tab===name} onClick={()=>setTab(name)} className={`-mb-px border-b-2 pb-2 text-sm ${tab===name?'border-foreground font-medium text-foreground':'border-transparent text-muted-foreground hover:text-foreground'}`}>{name}</button>)}
    </div>
    <div role="tabpanel" aria-label={tab} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
     {tab==='Overview'&&<Overview rule={rule} view={view} takeId={takeId} showActivity={()=>setTab('Activity')}/>}
     {tab==='Permissions'&&<Permissions rule={rule} view={view} close={close}/>}
     {tab==='Activity'&&<Activity rule={rule} view={view} takeId={takeId} strategyId={strategyId} close={close}/>}
     {tab==='Settings'&&<Settings rule={rule} view={view}/>}
    </div>
    <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-6 py-3 text-xs">
     <button type="button" disabled={busy||readOnly} onClick={()=>setDeleting(true)} className="font-medium text-destructive hover:underline disabled:opacity-40">Delete rule</button>
     <span className="text-muted-foreground">To change this, ask chat — edits come back as a proposal.</span>
    </footer>
   </section>
  </div>}
  {rule&&<DeleteRule open={deleting} rule={rule} view={view} busy={busy} onOpenChange={setDeleting} confirm={async()=>{const next=await call({action:'rule-remove',takeId,ruleId:rule.id});if(next){setDeleting(false);if(next.config.rules[0])select(next.config.rules[0].id);}}}/>}
 </>;
}

function useActivity(takeId:string,ruleId:string,revision:number){
 const [items,setItems]=useState<RuleActivityItem[]|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{let live=true;setItems(null);setFailed(false);
  const load=()=>void window.dataSources.configure({action:'rule-activity',takeId,ruleId}).then(rows=>{if(live)setItems(rows as RuleActivityItem[]);}).catch(()=>{if(live)setFailed(true);});
  load();const timer=setInterval(load,5000);return()=>{live=false;clearInterval(timer);};},[takeId,ruleId,revision]);
 return {items,failed};
}

function Overview({rule,view,takeId,showActivity}:{rule:StrategyRule;view:RuleReview;takeId:string;showActivity:()=>void}){
 const {items}=useActivity(takeId,rule.id,view.revision);
 const last=items?.[0],line=last&&activityLine(last),runs=view.lifecycle?.[rule.id]?.runs??0;
 const a0=rule.action,targetMove=a0.kind==='trim'?`Suggest ${a0.market.reference.split('-')[0]} at ${a0.toWeightBps/100}% of the Take`:a0.kind==='exit'?`Suggest ${a0.market?a0.market.reference.split('-')[0]+' at 0%':'everything in cash'}`:a0.kind==='buy'?`Suggest more ${a0.market.reference.split('-')[0]} from the Take’s cash`:null;
 const then=targetMove?`${targetMove}. ${keepersText(view)}`:rule.action.kind==='agent'?rule.action.instructions.text:rule.action.kind==='notify'||rule.action.kind==='request_review'?`${rule.action.kind==='notify'?'Notify me':'Ask me to review'}: ${rule.action.message}`:actionText(rule.action)+(view.tradingRuleIds?.includes(rule.id)?'':' · preview only');
 return <div className="space-y-5">
  <div><p className="text-xs text-muted-foreground">When</p><p className="mt-1 text-sm"><Mono text={whenText(rule,view.inputs)}/></p></div>
  <div><p className="text-xs text-muted-foreground">Then{rule.action.kind==='agent'?' the agent':''}</p><p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm">{then}</p></div>
  <Rows rows={[
   ['Last run',last&&line?<button type="button" onClick={showActivity} className="flex items-center gap-1 text-left hover:underline"><span><span className="tabular-nums">{ago(last.at)}</span>{ago(last.at)==='now'?'':' ago'} · <span className={line.tone==='attention'?'text-attention':''}>{line.text}</span></span><ChevronRight size={13} className="shrink-0 text-muted-foreground" aria-hidden="true"/></button>:items?'Not yet':'…'],
   ['Runs',<><span className="tabular-nums">{runs} of {rule.policy.maxRuns}</span> · resets {reset(rule,view.inputs).short}</>],
   ['After a match',rule.policy.cooldownMs?`Waits ${duration(rule.policy.cooldownMs)}`:'No wait'],
   ['Checks',`${sourceText(rule,view.inputs)} · ${rule.trigger.kind==='event'?'on each event':'every second'}`],
  ]}/>
 </div>;
}
function sourceText(rule:StrategyRule,inputs:TakeInputsConfig){const binding=inputs.inputs.find(i=>i.key===rule.trigger.input);const product=productOf(rule,inputs);return product?`Live ${product} price`:binding?`${binding.feedId.replaceAll(/[:_-]/g,' ')}`:'Source';}

function Permissions({rule,view,close}:{rule:StrategyRule;view:RuleReview;close:()=>void}){
 const [global,setGlobal]=useState<Limits|null>(null);
 useEffect(()=>{if(rule.action.kind!=='agent')return;let live=true;void window.takes.automaticLimits().then(v=>{if(live)setGlobal(v as Limits);}).catch(()=>{});return()=>{live=false;};},[rule.action.kind]);
 const accounts=ruleAccounts(rule).map(id=>{const a=view.accounts?.[id];return a?`${a.label} · ${a.venue.charAt(0).toUpperCase()+a.venue.slice(1)}`:'Unavailable account';});
 const granted=!!view.tradingRuleIds?.includes(rule.id)&&trades(rule),asks=rule.policy.approval==='ask'||!!view.confirmTrades;
 const how=granted?asks?', after you approve':', without asking':trades(rule)?' · preview only, not granted':'';
 const a=rule.action;
 const can=a.kind==='agent'?a.capabilities.actions.map(actionName).join(' · '):a.kind==='notify'?'Notify you':actionName(a.kind);
 const rows:[string,ReactNode][]=[['Can',can+how]];
 if(accounts.length)rows.push(['On',accounts.join(', ')]);
 if(a.kind==='agent'&&a.capabilities.maxTradeNotionalUsd)rows.push(['Up to',<><span className="tabular-nums">{usd(a.capabilities.maxTradeNotionalUsd)}</span> per trade</>]);
 if(a.kind==='agent')rows.push(['Tools',a.capabilities.tools.length?a.capabilities.tools.map(toolName).join(' · '):'None']);
 const b=a.kind==='agent'?a.budget:null;
 const limit=(rule?:number,app?:number)=>rule===undefined?app:app===undefined?rule:Math.min(rule,app);
 return <div className="space-y-5"><Rows rows={rows}/>
  {b&&<p className="text-xs leading-5 text-muted-foreground">Each run: {global?<span className="tabular-nums text-foreground">{[`${Math.round(limit(b.maxDurationMs,global.durationMs)!/60000)} min`,`${limit(b.maxToolCalls,global.toolCalls)} tool calls`,`${limit(b.maxTurns,global.modelTurns)} turns`,`${tokens(limit(b.maxOutputTokens,global.outputTokens)!)} tokens`,usd(limit(b.maxCostUsd===undefined?undefined:Number(b.maxCostUsd),global.costUsd)!)].join(' · ')}</span>:'…'} — whichever is lower here or in <Link to="/settings" search={{section:'ai-settings'}} onClick={close} className="underline underline-offset-2 hover:text-foreground">AI settings</Link>.</p>}
 </div>;
}

function Activity({rule,view,takeId,strategyId,close}:{rule:StrategyRule;view:RuleReview;takeId:string;strategyId:string;close:()=>void}){
 const {items,failed}=useActivity(takeId,rule.id,view.revision);const navigate=useNavigate();
 const runs=view.lifecycle?.[rule.id]?.runs??0;
 function open(item:RuleActivityItem){
  if(item.runId){close();window.dispatchEvent(new CustomEvent('take-rule-run-open',{detail:{requestId:item.requestId}}));return;}
  if(item.trade){close();void navigate({to:'/strategies/$strategyId',params:{strategyId},hash:'order-review'});}
 }
 return <div className="space-y-4">
  <p className="text-sm"><span className="tabular-nums">{runs} of {rule.policy.maxRuns}</span> {rule.policy.maxRuns===1?'run':'runs'} used · resets when {reset(rule,view.inputs).long}</p>
  {failed&&<p role="alert" className="text-xs text-destructive">Could not load activity.</p>}
  {!items?<p className="text-xs text-muted-foreground">Loading…</p>:!items.length?<p className="text-xs text-muted-foreground">No runs yet.</p>:
  <ul className="divide-y divide-border">{items.map(item=>{const line=activityLine(item),link=!!item.runId||!!item.trade;
   const body=<><span className={`size-1.5 shrink-0 rounded-full ${line.tone==='attention'?'bg-attention':line.tone==='ok'?'bg-success':'bg-muted-foreground/50'}`} aria-hidden="true"/><span className="w-32 shrink-0 text-xs tabular-nums text-muted-foreground">{stamp(item.at)}</span><span className={`min-w-0 flex-1 ${line.tone==='attention'?'text-attention':''}`}>{line.text}</span>{link&&<ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true"/>}</>;
   return <li key={item.requestId}>{link?<button type="button" onClick={()=>open(item)} className="flex w-full items-center gap-3 py-2.5 text-left text-sm hover:bg-muted/40">{body}</button>:<div className="flex items-center gap-3 py-2.5 text-sm">{body}</div>}</li>;})}</ul>}
  <Link to="/strategies/$strategyId" params={{strategyId}} onClick={close} className="inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">All activity for this take</Link>
 </div>;
}

function Settings({rule,view}:{rule:StrategyRule;view:RuleReview}){
 const [prompt,setPrompt]=useState(false);const a=rule.action;
 const text=a.kind==='agent'?a.instructions.text:a.kind==='notify'||a.kind==='request_review'?a.message:null;
 const extras=[rule.conditions.all.length?`${rule.conditions.all.length} ${rule.conditions.all.length===1?'condition':'conditions'}`:null,rule.context.length?`${rule.context.length} context ${rule.context.length===1?'step':'steps'}`:null,rule.policy.holdMs?`holds ${duration(rule.policy.holdMs)}`:null].filter(Boolean);
 return <div className="space-y-4"><Rows rows={[
  ['Trigger',<Mono key="t" text={whenText(rule,view.inputs)}/>],
  ['Source',sourceText(rule,view.inputs)],
  ['Repeats',<>After {reset(rule,view.inputs).long} · up to <span className="tabular-nums">{rule.policy.maxRuns}</span> {rule.policy.maxRuns===1?'time':'times'}</>],
  ['Cooldown',rule.policy.cooldownMs?`${duration(rule.policy.cooldownMs)} after a match`:'None'],
  ['Decision',rule.action.kind==='rebalance_to_target'?'Waits until you confirm or cancel':`Expires after ${duration(rule.policy.expiresAfterMs)}`],
  ...(text!==null?[[a.kind==='agent'?'Instructions':'Message',<div key="p"><button type="button" onClick={()=>setPrompt(v=>!v)} className="text-left hover:underline">{prompt?'Hide':'Show'} {a.kind==='agent'?'prompt':'message'} · <span className="tabular-nums">{text.length}</span> characters</button>{prompt&&<p className="mt-2 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs leading-5">{text}</p>}</div>] as [string,ReactNode]]:[]),
 ]}/>
 <p className="text-xs text-muted-foreground">{extras.length?`Also: ${extras.join(' · ')}.`:'No extra conditions, context or hold.'}</p></div>;
}

function DeleteRule({open,rule,view,busy,onOpenChange,confirm}:{open:boolean;rule:StrategyRule;view:RuleReview;busy:boolean;onOpenChange:(open:boolean)=>void;confirm:()=>void}){
 const status=view.lifecycle?.[rule.id]?.status;
 const others=view.config.rules.some(r=>r.id!==rule.id&&view.lifecycle?.[r.id]?.status==='Awaiting approval');
 return <Dialog open={open} onOpenChange={next=>{if(!busy)onOpenChange(next);}}>
  <DialogContent className="max-w-md sm:max-w-md">
   <DialogTitle>Delete “{rule.name}”?</DialogTitle>
   <DialogDescription>It stops now and its permissions go with it. Past runs stay in this Take’s history.</DialogDescription>
   {(status==='Awaiting approval'||status==='In progress')&&<div role="note" className="rounded-md border-l-2 border-attention bg-attention/10 p-3 text-sm"><p className="font-medium text-attention">{status==='Awaiting approval'?'A rebalance is waiting for your approval':'This rule is running'}</p><p className="mt-1">Deleting cancels it and releases any reserved cash. Orders already sent are not affected.</p></div>}
   {others&&<p className="text-xs text-muted-foreground">Approvals waiting for this Take’s other rules are cancelled too; their rules keep running.</p>}
   <div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={()=>onOpenChange(false)} className="rounded-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button><button type="button" disabled={busy} onClick={confirm} className="rounded-full bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40">{busy?'Deleting…':'Delete rule'}</button></div>
  </DialogContent>
 </Dialog>;
}

/** Human rows for a review: only what the member decides on. */
function reviewFields(rule:StrategyRule|undefined,view:RuleReview,inputs:TakeInputsConfig):Record<string,string>{
 if(!rule)return {};const a=rule.action;
 const accounts=ruleAccounts(rule).map(id=>view.accounts?.[id]?`${view.accounts[id].label} · ${view.accounts[id].venue.charAt(0).toUpperCase()+view.accounts[id].venue.slice(1)}`:'Account');
 return {Name:rule.name,When:whenText(rule,inputs),Then:a.kind==='agent'?'Agent assesses':a.kind==='notify'?'Notify me':actionText(a),
  ...(a.kind==='agent'?{Instructions:a.instructions.text,Tools:a.capabilities.tools.map(toolName).join(' · ')||'None','Can do':a.capabilities.actions.map(actionName).join(' · '),'Per trade':a.capabilities.maxTradeNotionalUsd?`Up to ${usd(a.capabilities.maxTradeNotionalUsd)}`:'—',
   'Run limits':[a.budget.maxDurationMs&&`${Math.round(a.budget.maxDurationMs/60000)} min`,a.budget.maxToolCalls&&`${a.budget.maxToolCalls} tool calls`,a.budget.maxTurns&&`${a.budget.maxTurns} turns`,a.budget.maxOutputTokens&&`${tokens(a.budget.maxOutputTokens)} tokens`,a.budget.maxCostUsd&&usd(a.budget.maxCostUsd)].filter(Boolean).join(' · ')||'AI settings'}
   :a.kind==='notify'||a.kind==='request_review'?{Message:a.message}:{}),
  ...(accounts.length?{Accounts:accounts.join(', ')}:{}),
  Trading:trades(rule)?rule.policy.approval==='ask'||view.confirmTrades?'After you approve':'Without asking':'Not allowed',
  Cooldown:duration(rule.policy.cooldownMs),'Up to':`${rule.policy.maxRuns} ${rule.policy.maxRuns===1?'run':'runs'}`,Decision:`Expires after ${duration(rule.policy.expiresAfterMs)}`,
  Extras:[rule.conditions.all.length&&`${rule.conditions.all.length} conditions`,rule.context.length&&`${rule.context.length} context steps`,rule.policy.holdMs&&`hold ${duration(rule.policy.holdMs)}`].filter(Boolean).join(' · ')||'None'};
}

function ReviewPane({view,proposal,title,busy,error,selected,select,close,back,decide}:{view:RuleReview;proposal:RuleProposal;title:string;busy:boolean;error:string;selected?:string;select:(id:string)=>void;close:()=>void;back:()=>void;decide:(decision:'accept'|'dismiss')=>void}){
 const changes=changedRules(proposal);
 const unchanged=proposal.config.rules.filter(r=>!changes.some(c=>c.id===r.id));
 const current=changes.find(c=>c.id===selected)??changes[0];
 const counts=(['Edited','Added','Removed'] as const).map(kind=>[kind,changes.filter(c=>c.kind===kind).length] as const).filter(([,n])=>n).map(([kind,n])=>`${n} ${kind.toLowerCase()}`);
 const bindings=JSON.stringify(proposal.beforeInputs)!==JSON.stringify(proposal.inputs);
 const total=changes.length+(bindings?1:0);
 const permissions=changes.filter(c=>c.permission&&c.after);
 const old=reviewFields(current?.before,view,proposal.beforeInputs),next=reviewFields(current?.after,view,proposal.inputs);
 const keys=[...new Set([...Object.keys(old),...Object.keys(next)])].filter(key=>old[key]!==next[key]);
 const same=current?.before&&current.after?Object.keys(next).filter(key=>old[key]===next[key]&&key!=='Name'):[];
 const kindTag=(kind:string,permission:boolean)=><span className="flex gap-1.5 text-[11px]"><span className="text-muted-foreground">{kind}</span>{permission&&<span className="text-attention">permission</span>}</span>;
 return <>
  <Header title="Review rule changes" subtitle={<>{title} · proposed by {proposal.ruleName?`rule “${proposal.ruleName}”`:'chat'} <span className="tabular-nums">{ago(proposal.createdAt)}</span>{ago(proposal.createdAt)==='now'?'':' ago'}{counts.length?` · ${counts.join(' · ')}`:''}{bindings?' · source bindings':''}</>} close={close}>
   <button type="button" onClick={back} className="text-xs text-muted-foreground hover:text-foreground">Back to rules</button>
  </Header>
  {error&&<p role="alert" className="border-b border-border px-6 py-2 text-xs text-destructive">{error}</p>}
  <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
   <nav aria-label="Proposed changes" className="min-h-0 overflow-y-auto border-r border-border p-2">
    <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Proposed changes</p>
    {changes.map(c=><button key={c.id} type="button" aria-current={c.id===current?.id?'true':undefined} onClick={()=>select(c.id)} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/60 ${c.id===current?.id?'bg-muted':''}`}>
     <span className={`min-w-0 flex-1 truncate ${c.kind==='Removed'?'text-muted-foreground line-through':''}`}>{(c.after??c.before)!.name}</span>{kindTag(c.kind,c.permission)}</button>)}
    {bindings&&<p className="px-3 py-2 text-sm">Source bindings <span className="text-[11px] text-muted-foreground">Edited</span></p>}
    {!!unchanged.length&&<><p className="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Unchanged</p>
     {unchanged.map(r=><p key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><span className="min-w-0 flex-1 truncate">{r.name}</span>{isOff(view,r.id)&&<span className="text-[11px]">Off</span>}</p>)}</>}
   </nav>
   <section aria-label="Change details" className="flex min-h-0 flex-col">
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
     {current?<>
      <div><h3 className="flex items-center gap-2 text-base font-semibold"><span className={current.kind==='Removed'?'line-through':''}>{(current.after??current.before)!.name}</span><span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">{current.kind}</span></h3>
       <p className="mt-1 text-xs text-muted-foreground"><Mono text={`When ${whenText((current.after??current.before)!,current.after?proposal.inputs:proposal.beforeInputs)}, ${(current.after??current.before)!.action.kind==='agent'?'ask the agent to assess':reviewFields(current.after??current.before,view,proposal.inputs).Then.toLowerCase()}.`}/></p></div>
      <table className="w-full table-fixed text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="w-1/5 pb-2 font-normal">Setting</th><th className="pb-2 font-normal">Current</th><th className="pb-2 font-normal">Proposed</th></tr></thead>
       <tbody>{keys.map(key=><tr key={key} className="border-t border-border align-top"><th scope="row" className="py-2.5 pr-3 font-normal text-muted-foreground">{key}</th><td className="py-2.5 pr-3 whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]"><span className="line-clamp-4">{old[key]??'—'}</span></td><td className="py-2.5 whitespace-pre-wrap break-words font-medium [overflow-wrap:anywhere]"><span className="line-clamp-4">{next[key]??'—'}</span></td></tr>)}</tbody></table>
      {!!same.length&&<p className="text-xs text-muted-foreground">Unchanged: {same.map(key=>key.toLowerCase()).join(', ')}.</p>}
     </>:<p className="text-sm text-muted-foreground">Only source bindings change.</p>}
     {bindings&&<details className="text-xs"><summary className="cursor-pointer font-medium">Source bindings change · review mapping and freshness</summary><div className="mt-2 grid grid-cols-2 gap-3"><div><p>Current</p><pre className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{JSON.stringify(proposal.beforeInputs,null,2)}</pre></div><div><p>Proposed</p><pre className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{JSON.stringify(proposal.inputs,null,2)}</pre></div></div></details>}
     {!!permissions.length&&<div role="note" className="rounded-md border-l-2 border-attention bg-attention/10 p-4 text-sm">
      <p className="font-medium text-attention">Permission change · {permissions.length} {permissions.length===1?'rule':'rules'}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">{permissions.map(c=>{const r=c.after!,f=reviewFields(r,view,proposal.inputs);return <li key={c.id}><span className="font-medium">{r.name}</span>: {r.action.kind==='agent'?f['Can do'].toLowerCase():actionText(r.action).toLowerCase()} on {f.Accounts??'its account'}{f['Per trade']&&f['Per trade']!=='—'?`, ${f['Per trade'].toLowerCase()} per trade`:''}, {f.Trading==='Without asking'?'without asking':'asking first'}.</li>;})}</ul>
     </div>}
    </div>
    <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-6 py-3">
     <p className="text-xs text-muted-foreground">Accepting applies {total===1?'this change':`all ${total} changes`} together; changed and added rules turn on.</p>
     <div className="flex shrink-0 items-center gap-2"><button type="button" disabled={busy} onClick={()=>decide('dismiss')} className="rounded-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40">Dismiss all</button>
      <button type="button" disabled={busy} onClick={()=>decide('accept')} className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-40">{busy?'Saving…':`Accept ${total===1?'change':`${total} changes`}`}</button></div>
    </footer>
   </section>
  </div>
 </>;
}
