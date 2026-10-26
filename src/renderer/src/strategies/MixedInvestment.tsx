import {MixedWithdrawal} from './MixedWithdrawal';
import {assetAmount} from '../portfolio/format';
import {createPreviewQueue} from './preview-queue';
import {InvestmentVenuePanel} from './InvestmentVenuePanel';
import {investmentVenues,type InvestmentVenue} from '../../../shared/investment-venues';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '../components/ui/app-dialog';
import {useCallback,useEffect,useRef,useState} from 'react';
import {InvestmentSummaryCollector,type InvestmentSummaryData} from './InvestmentSummary';
import {MixedInvestmentSummary} from './MixedInvestmentSummary';
import type {MixedPreview,MixedExecution} from '../../../shared/mixed-execution';
import type {TakeAccountPlan} from '../../../shared/strategy-account-plan';
import {InvestmentAmountForm} from './InvestmentAmountForm';
import {RobinhoodLogoTile} from '../logos';
import {Button} from '../components/ui/button';
const usd=(value:string)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value));
/** Existing investment form, with one funding row per selected venue. */
export function MixedInvestment({takeId,plan,onChanged,accounts}:{takeId:string;plan:TakeAccountPlan;onChanged:()=>void;accounts?:React.ReactNode}){
 const [withdrawalActive,setWithdrawalActive]=useState(false);
 const [depositing,setDepositing]=useState(false);
 const [managing,setManaging]=useState<InvestmentVenue|null>(null);
 const [summaries,setSummaries]=useState<Partial<Record<InvestmentVenue,InvestmentSummaryData>>>({});
 const report=useCallback((venue:InvestmentVenue,data:InvestmentSummaryData)=>setSummaries(previous=>({...previous,[venue]:data})),[]);
 const [amount,setAmount]=useState(''),[currency,setCurrency]=useState<'USDC'|'USD'>('USDC');
 const [preview,setPreview]=useState<{key:string;value:MixedPreview}|null>(null),[run,setRun]=useState<MixedExecution|null>(null);
 const [retry,setRetry]=useState(0);
 const [waiting,setWaiting]=useState(false);
 const [pending,setPending]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 const operation=useRef<{preview:string;id:string}|null>(null),active=useRef(true),queue=useRef(createPreviewQueue()),submitting=useRef(false);
 const key=JSON.stringify([takeId,plan.revision,amount,currency]);
 const valid=/^\d+(\.\d{1,2})?$/.test(amount)&&Number(amount)>0;
 useEffect(()=>{active.current=true;let cancelled=false;const load=()=>window.strategies.mixedInvestment(takeId).then(value=>{if(!cancelled&&!submitting.current){setRun(value);setLoaded(true);}}).catch(()=>{if(!cancelled)setError('Could not load this investment.');});void load();const timer=setInterval(()=>{void load();},5000);return()=>{active.current=false;cancelled=true;clearInterval(timer);};},[takeId]);
 useEffect(()=>{
  let cancelled=false;setPreview(null);setError('');setWaiting(false);
  if(!loaded||(run&&!depositing)||!valid){setPending(false);return;}
  setPending(true);
  const timer=setTimeout(()=>{
   const operationId=crypto.randomUUID();
   void queue.current(()=>window.strategies.mixedPreview({takeId,operationId,amountUsd:amount,coinbaseCurrency:currency}),()=>!cancelled,()=>{if(!cancelled)setWaiting(true);})
    .then(value=>{if(!cancelled&&value)setPreview({key,value});})
    .catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:'Could not prepare this investment.');})
    .finally(()=>{if(!cancelled){setPending(false);setWaiting(false);}});

  },400);
  return()=>{cancelled=true;clearTimeout(timer);};
 },[key,loaded,!!run,depositing,retry]);
 const current=preview?.key===key?preview.value:null;
 async function invest(){
  if(busy||!current||current.state==='blocked')return;
  if(Date.parse(current.expiresAt)<=Date.now()){setRetry(value=>value+1);return;}
  submitting.current=true;setBusy(true);setError('');
  if(operation.current?.preview!==current.id)operation.current={preview:current.id,id:crypto.randomUUID()};
  try{const next=await window.strategies.mixedInvest({operationId:operation.current.id,previewId:current.id});if(active.current){setRun(next);setDepositing(false);setAmount('');onChanged();}}
  catch(e){
   const saved=await window.strategies.mixedInvestment(takeId).catch(()=>null);
   if(active.current){
    if(saved?.id===operation.current?.id){setRun(saved);setDepositing(false);setAmount('');onChanged();}
    else setError(e instanceof Error?e.message:'Could not start this investment.');
   }
  }
  finally{submitting.current=false;if(active.current)setBusy(false);}
 }
 const venueLogo=(venue:string)=>venue==='robinhood'?<RobinhoodLogoTile className="size-6" markClassName="size-3.5"/>:<span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[#0052ff]"><span className="size-3 rounded-full bg-white"/></span>;
 const form=<section className="mt-5"><InvestmentAmountForm title={run?null:undefined} actionLabel={run?'Deposit':undefined} amount={amount} onAmountChange={setAmount} inputDisabled={busy} disabled={!loaded||pending||busy||!current||current.state==='blocked'} busyLabel={busy?(run?'Depositing…':'Investing…'):pending?(waiting?'Waiting for Coinbase…':'Checking accounts…'):undefined} onInvest={()=>void invest()} currencyControl={<div className="flex items-center gap-3 text-xs"><span className="text-muted-foreground">Pay with</span>{(['USDC','USD'] as const).map(value=><button key={value} disabled={busy} aria-pressed={currency===value} onClick={()=>setCurrency(value)} className={`border-b pb-0.5 ${currency===value?'border-foreground':'border-transparent text-muted-foreground'}`}>{value}</button>)}</div>} summary={<>{current&&<div className="mt-4 space-y-3"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Funded from</p>{current.legs.map(leg=><div key={leg.venue}><div className="flex items-start gap-2.5">{venueLogo(leg.venue)}<div className="flex-1"><p className="text-sm">{plan.accounts.find(a=>a.id===leg.accountId)?.label??leg.venue}</p><p className="text-xs capitalize text-muted-foreground">{leg.venue}</p></div><span className="font-mono text-xs">{assetAmount(leg.quantity, leg.currency)}</span></div>{leg.state==='waiting_market'&&<p className="mt-2 text-xs text-muted-foreground">Buys at the next Robinhood trading session.</p>}{leg.reason&&<p role="alert" className="mt-2 text-xs text-error">{leg.reason}</p>}</div>)}<p className="text-xs text-muted-foreground">Buys favor underweight holdings within each account. Available cash already in the Take may also be invested.</p><p className="pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">This buys</p>{current.legs.flatMap(leg=>leg.orders.map(order=><div key={`${leg.venue}:${order.symbol}`} className="flex justify-between text-xs"><span>{order.symbol}<span className="ml-2 capitalize text-muted-foreground">{leg.venue}</span></span><span className="font-mono">{usd(order.notional)}</span></div>))}</div>}{error&&<div className="mt-3"><p role="alert" className="text-xs text-error">{error}</p><button type="button" disabled={busy||pending} className="mt-2 text-xs underline" onClick={()=>setRetry(value=>value+1)}>Retry preview</button></div>}</>}/></section>;
 if(!run)return <>{accounts}{form}</>;
 const openDeposit=()=>{if(withdrawalActive)return;setAmount('');setPreview(null);setError('');setDepositing(true);};
 return <section className="mt-5 space-y-4">
  <MixedInvestmentSummary plan={plan} run={run} summaries={summaries} onManage={setManaging}/>
  {run.legs.map(leg=><UnifiedVenue key={run.id+':'+leg.venue} venue={leg.venue} report={report}>
   <Dialog open={managing===leg.venue} onOpenChange={open=>setManaging(open?leg.venue:null)}>
    <DialogContent keepMounted className="max-h-[85vh] overflow-y-auto">
     <DialogHeader><DialogTitle>Manage {investmentVenues[leg.venue].label}</DialogTitle><DialogDescription>{plan.accounts.find(a=>a.id===leg.accountId)?.label??investmentVenues[leg.venue].label}</DialogDescription></DialogHeader>
    <div className="venue-management space-y-3">
     {leg.state==='attention'&&<p role="alert" className="text-error">{leg.message??'This account needs attention.'}</p>}
     <InvestmentVenuePanel venue={leg.venue} takeId={takeId} strategyId={plan.strategyId} onDeposit={openDeposit} onChanged={onChanged}/>
    </div>
    </DialogContent>
   </Dialog>
  </UnifiedVenue>)}
  <div className="flex flex-wrap gap-2">{run.state==='completed'&&<Button variant="outline" disabled={withdrawalActive} onClick={openDeposit}>Deposit</Button>}
  <MixedWithdrawal takeId={takeId} title="this Take" hasHoldings={Object.values(summaries).some(s=>Number(s?.value)>0)} disabled={run.state!=='completed'} onChanged={onChanged} onActive={setWithdrawalActive}/></div>
  {error&&!depositing&&<p role="alert" className="text-xs text-error">{error}</p>}
  <Dialog open={depositing} onOpenChange={open=>{if(!busy)setDepositing(open);}}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>Deposit</DialogTitle><DialogDescription>Fund this Take from its existing Coinbase and Robinhood accounts.</DialogDescription></DialogHeader>{form}</DialogContent></Dialog>
 </section>;

}

function UnifiedVenue({venue,report,children}:{venue:InvestmentVenue;report:(venue:InvestmentVenue,data:InvestmentSummaryData)=>void;children:React.ReactNode}){
 const collect=useCallback((data:InvestmentSummaryData)=>report(venue,data),[venue,report]);
 return <InvestmentSummaryCollector.Provider value={collect}>{children}</InvestmentSummaryCollector.Provider>;
}
