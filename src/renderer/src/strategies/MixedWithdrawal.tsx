import {useEffect,useRef,useState} from 'react';
import type {MixedWithdrawal as Withdrawal} from '../../../shared/mixed-withdrawal';
import {Button} from '../components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '../components/ui/app-dialog';
import {ClosePositionsTable} from '../components/ClosePositionsDialog';
import {TakeMoneyOutMenu} from './TakeMoneyOutMenu';
import {ReducePositionsForm,type ReductionBand} from './ReducePositionsForm';
import {createPreviewQueue} from './preview-queue';
const money=(v:string)=>Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
export function MixedWithdrawal({takeId,title,hasHoldings,disabled,onChanged,onActive}:{takeId:string;title:string;hasHoldings:boolean;disabled:boolean;onChanged:()=>void;onActive:(active:boolean)=>void}){
 const [menu,setMenu]=useState(false),[mode,setMode]=useState<'reduce'|'close'|null>(null),[amount,setAmount]=useState(''),[quote,setQuote]=useState<'USD'|'USDC'>('USDC');
 const [selection,setSelection]=useState<string[]|undefined>(),[review,setReview]=useState<Withdrawal|null>(null),[run,setRun]=useState<Withdrawal|null>(null),[band,setBand]=useState<ReductionBand|null>(null);
 const [error,setError]=useState(''),[pending,setPending]=useState(false),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
 const queue=useRef(createPreviewQueue()).current,confirming=useRef(false),alive=useRef(true);
 const currentKey=JSON.stringify([takeId,mode,amount,quote,selection]);
 const [reviewKey,setReviewKey]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{let active=true;let timer:ReturnType<typeof setTimeout>;async function load(){try{const value=await window.strategies.mixedWithdrawal(takeId);if(active&&!confirming.current)setRun(value);}catch{/* Preserve known status across a temporary read failure. */}finally{if(active)timer=setTimeout(load,5000);}}void load();return()=>{active=false;clearTimeout(timer);};},[takeId]);
 const running=run?.state==='running'||run?.state==='attention';
 useEffect(()=>{onActive(running);},[running,onActive]);
 useEffect(()=>{if(run?.state==='completed')onChanged();},[run?.id,run?.state]);
 useEffect(()=>{if(mode!=='reduce')return;let active=true;setBand(null);void queue(()=>window.strategies.mixedWithdrawalLimits(takeId,quote),()=>active).then(v=>{if(active&&v)setBand(v);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not load withdrawal limits.');});return()=>{active=false;};},[mode,quote,takeId,retry]);
 useEffect(()=>{
  let active=true;setReview(null);setError('');setPending(false);
  if(!mode||(mode==='reduce'&&(!band?.possible||!Number(amount))))return;
  setPending(true);
  const timer=setTimeout(()=>{void queue(()=>window.strategies.mixedWithdrawalPreview({takeId,kind:mode,coinbaseCurrency:quote,...(mode==='reduce'?{amountUsd:amount}:{sellSymbols:selection})}),()=>active)
   .then(value=>{if(active&&value){setReview(value);setReviewKey(currentKey);}}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not preview this withdrawal.');}).finally(()=>{if(active)setPending(false);});},400);
  return()=>{active=false;clearTimeout(timer);};
 },[currentKey,band,retry]);
 const valid=review&&reviewKey===currentKey&&!pending;
 async function confirm(id?:string){
  const target=id??(valid?review?.id:undefined);if(!target||busy)return;
  if(!id&&review&&Date.parse(review.expiresAt)<=Date.now()){setRetry(v=>v+1);setError('Updating the expired review. Check the new amounts before confirming.');return;}
  setBusy(true);confirming.current=true;setError('');
  try{const next=await window.strategies.mixedWithdrawalConfirm(target);if(alive.current){setRun(next);if(next.state==='expired'){setRetry(v=>v+1);setError(next.message??'Preview again.');}else {setMode(null);onChanged();}}}
  catch(e){if(alive.current){setError(e instanceof Error?e.message:'Could not continue the withdrawal.');const saved=await window.strategies.mixedWithdrawal(takeId).catch(()=>null);if(saved?.id===target){setRun(saved);setMode(null);}}}
  finally{confirming.current=false;if(alive.current)setBusy(false);}
 }
 const open=(kind:'reduce'|'close')=>{setAmount('');setSelection(undefined);setReview(null);setError('');setMode(kind);};
 const currency=<div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">Crypto proceeds</span><div className="flex gap-4">{(['USDC','USD'] as const).map(q=><button key={q} disabled={busy} aria-pressed={quote===q} className={`border-b pb-1 ${quote===q?'border-foreground':'border-transparent text-muted-foreground'}`} onClick={()=>setQuote(q)}>{q}</button>)}</div></div>;
 const proceeds=review&&<div className="space-y-2 border-t border-border py-3"><p className="text-xs text-muted-foreground">Back to your accounts, after estimated fees</p>{review.legs.map(l=><div key={l.venue} className="flex justify-between gap-2 text-xs"><span>{l.accountLabel} · <span className="capitalize">{l.venue}</span></span><span className="font-mono">≈ {money(l.estimatedProceeds)} {l.currency}</span></div>)}</div>;
 return <>
  {hasHoldings&&!running&&<Button variant="outline" disabled={disabled} onClick={()=>setMenu(true)}>Take money out</Button>}
  {running&&<div className="space-y-2 border-t border-border py-3"><p className="text-sm font-medium">{run.kind==='close'?'Close this Take':'Take money out'}</p>{run.legs.map(l=><div key={l.venue} className="text-xs"><span className="capitalize">{l.venue} · {l.state.replaceAll('_',' ')}</span>{l.message&&<p className="mt-1 text-muted-foreground">{l.message}</p>}</div>)}{run.state==='attention'&&<><p className="text-xs text-muted-foreground">{run.message}</p><Button variant="outline" size="sm" disabled={busy} onClick={()=>void confirm(run.id)}>Check and continue</Button><Button variant="ghost" size="sm" disabled={busy} onClick={()=>{setBusy(true);void window.strategies.mixedWithdrawalEnd(run.id).then(v=>{setRun(v);setError('');onChanged();}).catch(e=>setError(e instanceof Error?e.message:'Could not end withdrawal.')).finally(()=>setBusy(false));}}>End this attempt</Button></>}</div>}
  {!mode&&error&&<p role="alert" className="text-xs text-error">{error}</p>}
  <TakeMoneyOutMenu open={menu} title={title} onOpenChange={setMenu} onReduce={()=>open('reduce')} onClosePositions={()=>open('close')}/>
  <Dialog open={mode!==null} onOpenChange={open=>{if(!open&&!busy)setMode(null);}}><DialogContent className="max-h-[85vh] max-w-md overflow-y-auto" showCloseButton={!busy}>
   <DialogHeader><DialogTitle>{mode==='close'?'Close this Take':'Take money out'}</DialogTitle><DialogDescription>{mode==='close'?'Choose what to sell across both accounts. Unchecked holdings and cash return to their original accounts.':'Sell a proportional slice across both accounts. Proceeds return to each original account; Robinhood sells during market hours.'}</DialogDescription></DialogHeader>
   {mode==='reduce'?<ReducePositionsForm amount={amount} onAmountChange={setAmount} currency="USD" band={band} preview={valid?{ok:true,legs:review.legs.flatMap(l=>l.orders.map(o=>({symbol:o.symbol,notional:o.notional,quantity:o.quantity??undefined,venue:l.venue,currency:l.currency}))),remainingValue:String(Math.max(0,Number(band?.holdingsValue??0)-Number(amount))),reasons:[]}:null} proceedsSummary={proceeds} busy={busy} loading={pending} error={error} onRetry={()=>setRetry(v=>v+1)} currencyControl={currency} onCancel={()=>setMode(null)} onConfirm={()=>void confirm()}/>:<>
    {pending&&<p role="status" className="text-xs text-muted-foreground">Checking both accounts…</p>}
    {currency}
    {valid&&review.legs.map(l=><section key={l.venue}><p className="mt-2 text-xs text-muted-foreground">{l.accountLabel} · <span className="capitalize">{l.venue}</span></p><ClosePositionsTable crypto={l.venue==='coinbase'} accountName={l.accountLabel} cashRows={l.cashRows} holding={{valuation:{complete:true,currency:l.currency,cash:l.cashReturned,totalValue:null},positions:l.orders.map(o=>({symbol:o.symbol,quantity:o.quantity??'0',value:o.notional,unrealized:null,sellable:o.sellable}))}} selected={new Set(l.orders.filter(o=>o.selected).map(o=>o.symbol))} disabled={busy} onChange={next=>setSelection(review.legs.flatMap(a=>a.venue===l.venue?[...next].map(s=>`${a.venue}:${s}`):a.orders.filter(o=>o.selected).map(o=>`${a.venue}:${o.symbol}`)))} estimatedProceeds={String(Math.max(0,Number(l.estimatedProceeds)-Number(l.cashReturned)))}/></section>)}
    {error&&<div><p role="alert" className="text-xs text-error">{error}</p><button className="mt-1 text-xs underline" onClick={()=>setRetry(v=>v+1)}>Retry preview</button></div>}
    <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={()=>setMode(null)}>Keep Take</Button><Button disabled={busy||pending||!valid||!!error} onClick={()=>void confirm()}>{busy?'Closing…':review?.legs.some(l=>l.orders.some(o=>o.selected))?'Sell and close':'Keep assets and close'}</Button></div>
   </>}
  </DialogContent></Dialog>
 </>;
}
