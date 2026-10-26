import {MixedInvestment} from './MixedInvestment';
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import type { TakeAccountPlan as Plan, TakePlanAccount } from '../../../shared/strategy-account-plan';
import { RobinhoodLogoTile } from '../logos';
import { CoinbaseCapital } from './CoinbaseCapital';

const formatBalance = (balance: TakePlanAccount['balances'][number]) => `${balance.asset} ${new Intl.NumberFormat('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(balance.amount))}`;
const totalBalance = (account: TakePlanAccount) => account.balances?.map(formatBalance).join(' · ') || 'Balance unavailable';
const unavailable = (account: TakePlanAccount) => account.disabledReason || (!account.available ? 'Account disconnected' : null);

/** Account routes identify the destination; investing remains a separate action. */
export function TakeAccountPlan({ takeId, showInvestment = true, onStatusVisible }: { takeId: string; showInvestment?: boolean; onStatusVisible?:(value:boolean)=>void }) {
 const [plan,setPlan]=useState<Plan|null>(null),[expanded,setExpanded]=useState<Record<string,boolean>>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const mounted=useRef(true),saving=useRef(false);
 useEffect(()=>{
  mounted.current=true;let active=true;
  const load=()=>{if(!saving.current)window.strategies.accountPlan(takeId).then(next=>{if(active&&!saving.current)setPlan(next);}).catch(()=>{if(active)setError('Could not load accounts.');});};
  load();window.addEventListener('focus',load);
  return()=>{active=false;mounted.current=false;window.removeEventListener('focus',load);};
 },[takeId]);
 const reload=async()=>{try{const next=await window.strategies.accountPlan(takeId);if(mounted.current)setPlan(next);}catch{if(mounted.current)setError('Could not load accounts.');}};
 const choose=async(venue:string,accountId:string)=>{
  if(!plan||saving.current||!plan.editable)return;
  if(plan.routes.find(r=>r.venue===venue)?.accountId===accountId){setExpanded(old=>({...old,[venue]:false}));return;}
  saving.current=true;setBusy(true);setError('');
  try{
   const next=await window.strategies.saveAccountPlan({takeId,draftRevision:plan.draftRevision,revision:plan.revision,routes:plan.routes.flatMap(route=>{
    const id=route.venue===venue?accountId:route.accountId;
    return id&&(route.venue==='coinbase'||route.venue==='robinhood')?[{venue:route.venue,accountId:id}]:[];
   })});
   if(mounted.current){setPlan(next);setExpanded(old=>({...old,[venue]:false}));}
  }catch(e){if(mounted.current){setError(e instanceof Error?e.message:'Could not save account choice.');await reload();}}
  finally{saving.current=false;if(mounted.current)setBusy(false);}
 };
 const accountsSection=<section aria-label="Accounts for this take" aria-busy={busy} className="space-y-5 border-t border-border pt-4">
  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Where this take lives</h3>
  {!plan&&!error&&<p className="text-xs text-muted-foreground">Loading accounts…</p>}
  {plan?.routes.map(route=>{
   const accounts=plan.accounts.filter(a=>a.venue===route.venue);
   const selected=accounts.find(a=>a.id===route.accountId);
   const open=plan.editable&&(expanded[route.venue]||!route.accountId);
   const platform=route.venue==='coinbase'?'Coinbase':route.venue==='robinhood'?'Robinhood':route.venue;
   return <div key={`${route.venue}:${route.accountId}`} className="space-y-2" role="group" aria-label={`${platform} account`}>
    {!open?<div className="flex items-start gap-3 py-2">
     {route.venue==='robinhood'?<RobinhoodLogoTile className="size-7" markClassName="size-4"/>:<span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[#0052ff]"><span className="size-3 rounded-full bg-white"/></span>}
     <div className="min-w-0 flex-1"><p className="break-words text-sm row-title">{selected?.label??'Account unavailable'}</p>
      <p className="text-xs text-muted-foreground">{platform}</p>
      <p className={`mt-1 font-mono text-[11px] tabular-nums ${selected&&unavailable(selected)?'text-destructive':'text-muted-foreground'}`}>{selected?(unavailable(selected)||totalBalance(selected)):'Reconnect this account in Settings.'}</p>
     </div>
     {plan.editable&&accounts.length>1&&<button type="button" className="shrink-0 rounded-md px-1 py-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled={busy} onClick={()=>setExpanded(old=>({...old,[route.venue]:true}))} aria-label={`Change ${platform} account`}>Change</button>}
    </div>:<>
     <p className="text-xs font-medium">Choose a {platform} account</p>
     <div role="radiogroup" aria-label={`${platform} accounts`} className="max-h-64 divide-y divide-border overflow-y-auto overscroll-contain">
      {accounts.map(account=>{
       const checked=account.id===route.accountId,blocked=unavailable(account);
       const status=blocked?.includes('read-only')?'Key is read-only':blocked;
       return <button key={account.id} type="button" role="radio" aria-checked={checked} aria-label={account.label} disabled={busy||!plan.editable||!!blocked} onClick={()=>void choose(route.venue,account.id)} className={`flex w-full items-center gap-3 px-1 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed ${blocked?'text-muted-foreground':'hover:bg-muted/40'}`}>
        <span className="min-w-0 flex-1">
         <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><span className="break-words text-sm row-title">{account.label}</span>{status&&<span className="text-[10px] text-destructive">{status}</span>}</span>
         <span className={`mt-1 block font-mono text-[11px] tabular-nums ${blocked?'text-muted-foreground/60':'text-muted-foreground'}`}>{totalBalance(account)}</span>
        </span>
        <span aria-hidden="true" className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${checked?'border-foreground bg-foreground text-background':blocked?'border-border bg-muted/50':'border-border'}`}>{checked&&<Check className="size-3"/>}</span>
       </button>;
      })}
     </div>
     {route.accountId&&<button type="button" disabled={busy} className="text-xs text-muted-foreground hover:text-foreground" onClick={()=>setExpanded(old=>({...old,[route.venue]:false}))}>Cancel</button>}
    </>}
    {!accounts.some(a=>!unavailable(a))&&<Link to="/settings" search={{section:'connections'}} className="inline-block text-xs underline underline-offset-4">Manage connections</Link>}
   </div>;
  })}
  {plan?.reason&&plan.reason!=='Funded Takes keep their existing account allocations.'&&<p className="text-xs text-muted-foreground">{plan.reason}</p>}
  {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  {busy&&<p role="status" className="text-xs text-muted-foreground">Saving account…</p>}

 </section>;
 const mixed=plan?.routes.some(r=>r.venue==='coinbase')&&plan.routes.some(r=>r.venue==='robinhood');
 if(mixed)return showInvestment&&plan?<MixedInvestment takeId={takeId} plan={plan} accounts={accountsSection} onChanged={()=>void reload()}/>:accountsSection;
 return showInvestment&&plan?.routes.some(r=>r.venue==='coinbase'&&r.accountId)?<fieldset disabled={busy} className="min-w-0"><CoinbaseCapital onStatusVisible={onStatusVisible} accounts={accountsSection} plannedAssets={plan.routes.find(r=>r.venue==='coinbase')?.assets} key={plan.revision??takeId} takeId={takeId} onChanged={()=>void reload()}/></fieldset>:accountsSection;
}
