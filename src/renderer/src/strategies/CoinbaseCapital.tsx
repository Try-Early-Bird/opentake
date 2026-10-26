import {InvestAvailableCash} from './InvestAvailableCash';
import {assetAmount} from '../portfolio/format';
import {CoinbaseLifecyclePanel} from './CoinbaseLifecyclePanel';
import {createPreviewQueue} from './preview-queue';
import {confirmWithdrawalReview} from './withdrawal-confirmation';
import {ReducePositionsForm,type ReductionBand} from './ReducePositionsForm';
import {ClosePositionsTable} from '../components/ClosePositionsDialog';
import {TakeMoneyOutMenu} from './TakeMoneyOutMenu';
import {InvestmentControls} from './InvestmentControls';
import type {ReactNode} from 'react';
import {InvestmentSummary} from './InvestmentSummary';
import {cryptoLogo} from '../crypto-logos';
const quantity=(value:string)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:8}).format(Number(value));
import {Link} from '@tanstack/react-router';
import {InstructionCard} from './InstructionCard';
import {CoinbaseApprovalCard} from './CoinbaseApprovalCard';
import {coinbaseInstruction} from './coinbase-instruction';
import type {CoinbasePreflight} from '../../../shared/coinbase-preflight';
import {PreflightSummary} from './PreflightSummary';
import {useEffect,useRef,useState} from 'react';
import type {CoinbaseCapitalView} from '../../../shared/coinbase-capital';
import type {CoinbaseInvestmentView} from '../../../shared/coinbase-investment';
import {FailedInvestment} from './FailedInvestment';
import {InvestmentAmountForm} from './InvestmentAmountForm';
import type {CoinbaseOrderReview} from '../../../shared/coinbase-orders';
import {Button} from '../components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '../components/ui/app-dialog';

export function CoinbaseCapital({takeId,onChanged,assets,plannedAssets=[],accounts,onStatusVisible,mixedDeposit}:{takeId:string;onChanged:()=>void;assets?:string;plannedAssets?:{symbol:string;bps:number}[];accounts?:ReactNode;onStatusVisible?:(value:boolean)=>void;mixedDeposit?:()=>void}){
 const [view,setView]=useState<CoinbaseCapitalView|null>(null),[investment,setInvestment]=useState<CoinbaseInvestmentView|null>(null);
 const [amount,setAmount]=useState(''),[asset,setAsset]=useState<'USD'|'USDC'>('USDC'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [lifecycleBlocked,setLifecycleBlocked]=useState(false);
 const [lifecycleRevision,setLifecycleRevision]=useState(0);
 const [depositing,setDepositing]=useState(false);
 const [busyLabel,setBusyLabel]=useState('Investing via Coinbase…');
 const [previewRetry,setPreviewRetry]=useState(0);
 const [choosing,setChoosing]=useState(false);
 const [closingTake,setClosingTake]=useState(false);
 const previewQueue=useRef(createPreviewQueue()).current;
 const [withdrawBand,setWithdrawBand]=useState<ReductionBand|null>(null);
 const [bandError,setBandError]=useState('');

 const [closeSelection,setCloseSelection]=useState<string[]|null>(null);
 const [closeDisplay,setCloseDisplay]=useState<CoinbaseOrderReview|null>(null);
 const [withdrawAsset,setWithdrawAsset]=useState<'USD'|'USDC'>('USDC');
 const [withdrawing,setWithdrawing]=useState(false),[withdrawAmount,setWithdrawAmount]=useState('');
 useEffect(()=>{setWithdrawBand(null);setBandError('');if(!withdrawing||closingTake)return;let active=true;previewQueue(()=>window.strategies.coinbaseWithdrawalBand({takeId,quote:withdrawAsset}),()=>active).then(band=>{if(active&&band)setWithdrawBand(band);}).catch(e=>{if(active)setBandError(e instanceof Error?e.message:'Could not load withdrawal limits.');});return()=>{active=false;};},[withdrawing,closingTake,withdrawAsset,takeId,previewRetry]);
 const [withdrawNotice,setWithdrawNotice]=useState('');
 const [withdrawal,setWithdrawal]=useState<CoinbaseOrderReview|null>(null),[withdrawPreview,setWithdrawPreview]=useState<CoinbaseOrderReview|null>(null),[withdrawError,setWithdrawError]=useState('');
 useEffect(()=>{setWithdrawal(null);let active=true;window.strategies.coinbaseOrders(takeId).then(review=>{if(active&&(review?.withdrawal||review?.rebalance))setWithdrawal(review);}).catch(error=>{if(active)setError(error instanceof Error?error.message:'Could not load order status.');});return()=>{active=false;};},[takeId]);
 useEffect(()=>{
  if(!withdrawal||window.location.hash!=='#order-review')return;
  const frame=requestAnimationFrame(()=>document.getElementById('order-review')?.scrollIntoView({block:'center'}));
  return()=>cancelAnimationFrame(frame);
 },[withdrawal?.id]);
 const withdrawalAmountError=!closingTake&&withdrawBand?.possible&&Number(withdrawAmount)>0
  ?Number(withdrawAmount)<Number(withdrawBand.minimumAmount)?`Enter at least ${assetAmount(withdrawBand.minimumAmount,withdrawAsset)}.`
   :Number(withdrawAmount)>Number(withdrawBand.maximumAmount)?`Enter no more than ${assetAmount(withdrawBand.maximumAmount,withdrawAsset)}.`:'' :'';
 useEffect(()=>{
  setWithdrawPreview(null);setWithdrawError('');setWithdrawNotice('');
  if(!withdrawing||withdrawalAmountError||(!closingTake&&(!withdrawBand?.possible||!Number.isFinite(Number(withdrawAmount))||Number(withdrawAmount)<=0)))return;
  let active=true;
  const timer=setTimeout(()=>{void previewQueue(()=>window.strategies.previewCoinbaseOrders({takeId,quote:withdrawAsset,...(closingTake?{close:true as const,...(closeSelection===null?{}:{sellSymbols:closeSelection})}:{withdrawAmount})}),()=>active)
   .then(result=>{if(active&&result){setWithdrawPreview(result);if(result.withdrawal?.close)setCloseDisplay(result);}})
   .catch(e=>{if(active)setWithdrawError(e instanceof Error?e.message:'Could not preview this withdrawal.');});},400);
  return()=>{active=false;clearTimeout(timer);};
 },[withdrawing,closingTake,withdrawAmount,withdrawAsset,closeSelection,takeId,previewRetry,withdrawBand,withdrawalAmountError]);
 const [sizing,setSizing]=useState<{key:string;value:CoinbasePreflight}|null>(null);
 const funded=!!view?.balances.some(b=>Number(b.quantity)>0||Number(b.reserved)>0);
 const sizingKey=JSON.stringify([takeId,view?.accountId,view?.balances.map(b=>[b.asset,b.quantity,b.reserved]),funded,asset,amount,depositing,previewRetry]);
 useEffect(()=>{
  if(!view||(!depositing&&view.balances.some(b=>Number(b.quantity)>0)))return;
  let active=true;
  const quantity=/^(0|[1-9]\d*)(\.\d+)?$/.test(amount)?amount:'0';
  const timer=setTimeout(()=>{previewQueue(()=>window.strategies.coinbasePreflight({takeId,quote:asset,quantity}),()=>active).then(value=>{if(active&&value)setSizing({key:sizingKey,value});}).catch(()=>{if(active)setSizing({key:sizingKey,value:{ok:false,amount:quantity,minimumAmount:null,legs:[],retainedCash:'0',reason:'Could not load the purchase preview. Please retry.'}});});},300);
  return()=>{active=false;clearTimeout(timer);};
 },[sizingKey]);
 const preflight=sizing?.key===sizingKey?sizing.value:null;
 const operation=useRef<string|null>(null);
 // A settled history remains available after closing; it is not an active investment.
 const canInvest=!funded&&(!investment||investment.review?.state==='settled'||investment.review?.state==='cancelled'||(investment.state==='cancelled'&&!investment.review))&&withdrawal?.state!=='confirmed';
 useEffect(()=>{if(canInvest)operation.current=null;},[canInvest,takeId]);
 const adopt=(next:CoinbaseInvestmentView)=>{setInvestment(next);setView(next.capital);setError(next.error??'');setDepositing(false);if(next.state==='cancelled')operation.current=null;};
 useEffect(()=>{let live=true;Promise.all([window.strategies.coinbaseCapital(takeId),window.strategies.coinbaseInvestment(takeId)]).then(([capital,current])=>{if(live){setView(capital);setInvestment(current);setAsset(current?.review?.quote??(capital.balances.some(b=>b.asset==='USD')&&!capital.balances.some(b=>b.asset==='USDC')?'USD':'USDC'));}}).catch(e=>{if(live)setError(e instanceof Error?e.message:'Could not load this investment.');});return()=>{live=false;};},[takeId]);
 const run=async(label:string,work:()=>Promise<CoinbaseInvestmentView>)=>{if(busy)return;setBusyLabel(label);setBusy(true);setError('');try{adopt(await work());onChanged();}catch(e){setError(e instanceof Error?e.message:'Could not invest.');try{const current=await window.strategies.coinbaseInvestment(takeId);if(current){setInvestment(current);setView(current.capital);}}catch{}}finally{setBusy(false);}};
 const invest=(quantity=amount)=>{if(!view)return;operation.current??=crypto.randomUUID();void run(depositing?'Depositing via Coinbase…':'Investing via Coinbase…',()=>window.strategies.investCoinbase({operationId:operation.current!,takeId,accountId:view.accountId,asset,quantity}));};
 const act=(action:'continue'|'confirm'|'cancel'|'refresh')=>{if(investment)void run(({continue:'Retrying Coinbase investment…',confirm:'Submitting Coinbase orders…',cancel:'Cancelling Coinbase orders…',refresh:'Refreshing Coinbase orders…'})[action],()=>window.strategies.actCoinbaseInvestment(investment.id,action));};
 // Read the host's reconciled state while orders are working, as the equity panel does.
 // This never submits, retries, cancels, or starts another provider sync.
 useEffect(()=>{
  if(busy)return;
  let active=true,reading=false;
  const refresh=async()=>{
   if(reading)return;reading=true;
   try{
    const [current,orders]=await Promise.allSettled([window.strategies.coinbaseInvestment(takeId),window.strategies.coinbaseOrders(takeId)]);
    if(!active)return;
    if(current.status==='fulfilled'&&current.value){setInvestment(current.value);if(current.value.review?.state==='confirmed'||investment?.review?.state==='confirmed')setView(current.value.capital);if(current.value.review?.state!==investment?.review?.state)onChanged();}
    if(orders.status==='fulfilled'&&(orders.value?.withdrawal||orders.value?.rebalance)){setWithdrawal(orders.value);if(orders.value.state!==withdrawal?.state){const capital=await window.strategies.coinbaseCapital(takeId);if(active){setView(capital);onChanged();}}}
   }finally{reading=false;}
  };
  const timer=setInterval(()=>void refresh(),5000);
  const focus=()=>void refresh();window.addEventListener('focus',focus);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',focus);};
 },[takeId,busy,investment?.review?.state,withdrawal?.state]);
 useEffect(()=>{
  if(busy||investment?.review?.state!=='settled')return;
  let active=true,reading=false;
  const refresh=async()=>{if(reading)return;reading=true;try{const capital=await window.strategies.coinbaseCapital(takeId);if(active)setView(capital);}catch{/* Keep the last successful read. */}finally{reading=false;}};
  void refresh();
  const timer=setInterval(()=>void refresh(),60000);const focus=()=>void refresh();window.addEventListener('focus',focus);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',focus);};
 },[takeId,busy,investment?.review?.state]);
 const validWithdrawal=withdrawPreview?.takeId===takeId&&withdrawPreview.quote===withdrawAsset&&(closingTake?withdrawPreview.withdrawal?.close:!withdrawPreview.withdrawal?.close&&withdrawPreview.withdrawal?.requestedAmount===withdrawAmount);
 const withdraw=async()=>{
  if(!withdrawPreview||!validWithdrawal||busy)return;
  setBusy(true);setError('');setWithdrawError('');setWithdrawNotice('');
  let attempted=withdrawPreview;
  try{
   const {review:current,confirmation}=await confirmWithdrawalReview(withdrawPreview,{
    refresh:()=>window.strategies.previewCoinbaseOrders({takeId,quote:withdrawAsset,...(closingTake?{close:true as const,...(closeSelection===null?{}:{sellSymbols:closeSelection})}:{withdrawAmount})}),
    confirm:id=>window.strategies.confirmCoinbaseOrders(id),
    onRefresh:next=>{attempted=next;setWithdrawPreview(next);if(next.withdrawal?.close)setCloseDisplay(next);},
   });
   if(!confirmation){setWithdrawNotice('Preview updated. Review the amounts and confirm again.');return;}
   const result=confirmation.needsConfirmation?confirmation:await window.strategies.submitCoinbaseOrders(current.id);
   setWithdrawal(result);setWithdrawing(false);setView(await window.strategies.coinbaseCapital(takeId));onChanged();
  }catch(e){
   const message=e instanceof Error?e.message:'Could not withdraw.';
   const current=await window.strategies.coinbaseOrders(takeId).catch(()=>null);
   if(current?.id===attempted.id&&current.withdrawal&&['confirmed','settled'].includes(current.state)){setWithdrawal(current);setWithdrawing(false);setError(message);}
   else{setWithdrawPreview(null);setWithdrawError(message);}
  }finally{setBusy(false);}
 };
 const retryWithdrawal=async()=>{
  if(!withdrawal||busy||coinbaseInstruction(withdrawal,null,withdrawal.needsConfirmation).waitingFor!=='retry_required')return;
  setBusy(true);setError('');
  try{
   const previous=withdrawal;
   const cancelled=await window.strategies.cancelCoinbaseOrders(previous.id);
   setWithdrawal(cancelled);
   if(!['settled','cancelled'].includes(cancelled.state))throw Error('Waiting for the previous withdrawal to resolve.');
   setView(await window.strategies.coinbaseCapital(takeId));
   setClosingTake(!!previous.withdrawal?.close);setWithdrawAmount(previous.withdrawal?.requestedAmount??'');setWithdrawAsset(previous.quote);
   setCloseSelection(previous.withdrawal?.close?previous.orders.map(o=>o.product.split('-')[0]):null);
   setCloseDisplay(null);setWithdrawPreview(null);setWithdrawError('');setWithdrawing(true);onChanged();
  }catch(e){setError(e instanceof Error?e.message:'Could not prepare another withdrawal.');}
  finally{setBusy(false);}
 };
 // A rule's trade waiting for approval is approved or declined through the shared rule-trade approvals
 // (one approval flow), as on the Rules card; this card then shows the review as it now stands.
 const waitingRuleTrade=async(requestId:string|undefined)=>!!requestId&&((await window.dataSources.configure({action:'rule-trade-approvals',takeId})) as {requestId:string}[]).some(a=>a.requestId===requestId);
 const decideRuleTrade=async(requestId:string,approve:boolean)=>{await window.dataSources.configure({action:'rule-trade-decide',takeId,requestId,approve});window.dispatchEvent(new Event('take-rules-changed'));return (await window.strategies.coinbaseOrders(takeId))??withdrawal!;};
 const actWithdrawal=async(action:'refresh'|'cancel'|'confirm')=>{if(!withdrawal||busy)return;setBusy(true);setError('');try{const rule=withdrawal.rebalance?.ruleRequestId;const result=await(action!=='refresh'&&await waitingRuleTrade(rule)?decideRuleTrade(rule!,action==='confirm'):action==='confirm'?window.strategies.submitCoinbaseOrders(withdrawal.id):action==='refresh'?window.strategies.refreshCoinbaseOrders(withdrawal.id):window.strategies.cancelCoinbaseOrders(withdrawal.id));setWithdrawal(result);if(result.reconfirmationRequired)setError('Order amounts or prices changed. Review the updated orders and confirm again.');setView(await window.strategies.coinbaseCapital(takeId));onChanged();}catch(e){setError(e instanceof Error?e.message:'Could not update withdrawal.');const current=await window.strategies.coinbaseOrders(takeId).catch(()=>null);if((current?.withdrawal||current?.rebalance))setWithdrawal(current);}finally{setBusy(false);}};
 if(!view)return <>{accounts}<p role={error?'alert':'status'} className="text-xs text-muted-foreground">{error||'Loading investment…'}</p></>;
 const cashOnly=!view.balances.some(b=>!['USD','USDC'].includes(b.asset)&&Number(b.quantity)>0);
 const review=investment?.review;
 const sent=review?.orders.some(o=>o.execution&&o.execution.state!=='reserved');
 const pending=investment&&investment.state!=='cancelled'&&!sent&&review?.state!=='cancelled'&&review?.state!=='settled';
 const failedPreparation=!!investment&&!review&&['started','funded'].includes(investment.state)&&(!mixedDeposit||!!investment.error);
 const withdrawalInstruction=withdrawal?coinbaseInstruction(withdrawal,withdrawal.withdrawal?.requestedAmount??null,withdrawal.needsConfirmation):null;
 const showWithdrawal=withdrawalInstruction&&withdrawalInstruction.status!=='cancelled'&&(withdrawalInstruction.status!=='settled'||withdrawalInstruction.pendingReason==='partial_completion');
 const withdrawalPending=!!withdrawal&&(withdrawal.state==='confirmed'||withdrawalInstruction?.waitingFor==='reconciliation_required');
 const settled=!pending&&!withdrawalPending&&(!investment||!['started','funded','ready'].includes(investment.state))&&(!review||['cancelled','settled'].includes(review.state));
 const currencyControl=(_id:string)=><div role="group" aria-label="Investment currency" className="flex gap-3">{(['USDC','USD'] as const).map(value=><button key={value} type="button" aria-pressed={asset===value} disabled={busy} className={`border-b pb-0.5 text-xs ${asset===value?'border-foreground text-foreground':'border-transparent text-muted-foreground'}`} onClick={()=>{setAsset(value);operation.current=null;}}>{value}</button>)}</div>;
 const funding={accountName:view.accountLabel,platform:'Coinbase' as const,assets,currency:asset,buyingPower:view.buyingPower};
 const maxAmount=view.buyingPower?.find(balance=>balance.asset===asset)?.amount??null;
 const minimum=preflight?.minimumAmount?`Minimum ${assetAmount(preflight.minimumAmount,asset)}`:undefined;
 const summary=!(Number(amount)>0)?null:preflight?<><PreflightSummary currency={asset} minimumShown preflight={{...preflight,kind:depositing?'contribution':'subscription',minimumAmount:preflight.minimumAmount??'0',retainedCash:'0',reasons:preflight.reason?[{code:'coinbase_sizing',symbols:[],message:preflight.reason}]:[],modelValuedOn:null,expectedValuedOn:null}}/>{preflight.ok&&<p className="mt-1 text-[11px] text-muted-foreground">Estimate before trading fees.</p>}{!preflight.ok&&preflight.reason&&<button type="button" className="mt-2 text-xs underline underline-offset-4" disabled={busy} onClick={()=>setPreviewRetry(value=>value+1)}>Retry preview</button>}</>:Number(amount)>0?<p role="status" className="text-xs text-muted-foreground">Checking the purchase…</p>:null;
 const receiveCurrencyControl=<div role="group" aria-label="Receive currency" className="flex w-full items-baseline gap-3 text-[11px] text-muted-foreground">
    <span className="mr-auto">Receive as</span>
    {(['USDC','USD'] as const).map(currency=><span key={currency} className="inline-flex items-baseline gap-1">

     <button type="button" aria-pressed={withdrawAsset===currency} disabled={busy}
      className={`border-b pb-0.5 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${withdrawAsset===currency?'border-foreground text-foreground':'border-transparent hover:text-foreground'}`}
      onClick={()=>{if(currency!==withdrawAsset){setWithdrawPreview(null);setCloseDisplay(null);setWithdrawAsset(currency);}}}>{currency}</button>
    </span>)}
   </div>;
 return <section aria-label="Coinbase investment" className="space-y-3">
   {(!funded||failedPreparation)&&accounts}
   {<CoinbaseLifecyclePanel onStatusVisible={onStatusVisible} key={takeId+':'+lifecycleRevision} takeId={takeId} onBlocked={setLifecycleBlocked} onChanged={()=>{void window.strategies.coinbaseCapital(takeId).then(setView);setLifecycleRevision(v=>v+1);onChanged();}} onCloseTake={()=>{setCloseSelection(null);setCloseDisplay(null);setClosingTake(true);setWithdrawAsset('USDC');setWithdrawPreview(null);setWithdrawError('');setError('');setWithdrawing(true);}}/>}
   {!failedPreparation&&!investment?.review&&investment?.cashStatus&&<p role="status" className="text-xs text-muted-foreground">{investment.cashStatus}</p>}
  {failedPreparation&&investment?<FailedInvestment accountName={view.accountLabel} amount={investment.requestedAmount} currency={investment.asset??asset} assets={plannedAssets} error={error||investment.error} busy={busy} busyLabel={busyLabel} onRetry={()=>act('continue')} onDismiss={()=>act('cancel')}/>:canInvest&&!lifecycleBlocked&&!mixedDeposit?<InvestmentAmountForm minimum={minimum} summary={summary} funding={funding} maxAmount={maxAmount} amount={amount} onAmountChange={value=>{setAmount(value);operation.current=null;}} disabled={busy||!amount||preflight?.ok!==true} busyLabel={busy?busyLabel:undefined} onInvest={()=>invest()}
   footnote={`Money stays in ${view.accountLabel}. Investing assigns it to the take and starts the first orders.`} currencyControl={currencyControl('coinbase-investment-currency')}/>
  :<>
   {(mixedDeposit||view.balances.some(b=>!['USD','USDC'].includes(b.asset)&&Number(b.quantity)>0))?<InvestmentSummary value={view.valuation?.value??null} currency={view.valuation?.currency??'USD'} gain={view.pnl&&view.pnl.currency===view.valuation?.currency?Number(view.pnl.gain):null} returnPercent={view.pnl&&view.pnl.returnPercent!==null&&view.pnl.currency===view.valuation?.currency?Number(view.pnl.returnPercent):null} positions={view.balances.filter(b=>!['USD','USDC'].includes(b.asset)&&Number(b.quantity)>0).map(b=>({symbol:b.asset,quantity:quantity(b.quantity),price:b.price,value:b.value,logo:cryptoLogo(b.asset)?<img src={cryptoLogo(b.asset)!} alt="" className="size-8 rounded-full"/>:undefined,name:<Link to="/coinbase/$product" params={{product:`${b.asset}-${view.valuation?.currency??'USD'}`}} search={{accountId:view.accountId}} className="inline-flex items-center gap-2 row-title hover:underline">{b.asset}</Link>}))} cash={view.balances.filter(b=>['USD','USDC'].includes(b.asset)&&Number(b.quantity)>0).map(b=>({currency:b.asset,value:b.value??null,quantity:b.quantity,reserved:b.reserved}))}/>:<div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Your investment</p>{view.balances.filter(b=>['USD','USDC'].includes(b.asset)&&Number(b.quantity)>0).map(b=><div key={b.asset} className="mt-3 flex justify-between gap-3 text-sm"><span>Uninvested cash · {b.asset}</span><span className="tabular-nums">{quantity(b.quantity)}</span></div>)}</div>}
   {review&&investment&&<>
    {!(review.state==='settled'&&review.orders.every(o=>o.execution?.state==='filled'))&&<InstructionCard instruction={coinbaseInstruction(review,investment.requestedAmount??null,investment.needsConfirmation,investment.state==='cancelled')} currency={review.quote} platform="Coinbase" busy={busy} onConfirm={()=>act('confirm')} onCancel={()=>act('cancel')} onRefresh={review.state==='confirmed'?()=>act('refresh'):undefined}/>}
    {!mixedDeposit&&settled&&!lifecycleBlocked&&!depositing&&!withdrawing&&view.balances.some(b=>b.asset===asset&&Number(b.quantity)>Number(b.reserved))&&!review.orders.every(o=>o.execution?.state==='filled')&&<InvestAvailableCash key={JSON.stringify([takeId,asset,view.balances.map(b=>[b.asset,b.quantity,b.reserved]),withdrawal?.id,withdrawal?.state])} takeId={takeId} quote={asset} disabled={busy} onInvest={()=>{operation.current=null;invest('0');}}/>}
   </>}
   {funded&&<InvestmentControls accounts={accounts}
    deposit={!mixedDeposit&&settled&&!lifecycleBlocked?{disabled:busy,onClick:()=>{operation.current=null;setError('');setAmount('');setDepositing(true);}}:undefined}
    withdraw={!mixedDeposit&&settled&&funded&&!lifecycleBlocked?{disabled:busy,onClick:()=>{setChoosing(true);setError('');}}:undefined}/>}

  </>}
  {withdrawal&&!withdrawal.closed&&showWithdrawal&&<div id="order-review" aria-label={withdrawal.rebalance?"Rebalance status":"Withdrawal status"}>{withdrawal.needsConfirmation?<CoinbaseApprovalCard review={withdrawal} busy={busy} onConfirm={()=>void actWithdrawal('confirm')} onCancel={()=>void actWithdrawal('cancel')} onRefresh={()=>void actWithdrawal('refresh')}/>:<InstructionCard instruction={coinbaseInstruction(withdrawal,withdrawal.withdrawal?.requestedAmount??null,withdrawal.needsConfirmation)} currency={withdrawal.quote} platform="Coinbase" busy={busy} onRetry={()=>void retryWithdrawal()} onConfirm={()=>void actWithdrawal('confirm')} onCancel={()=>void actWithdrawal('cancel')} onRefresh={withdrawalPending?()=>void actWithdrawal('refresh'):undefined}/>}</div>}
  {error&&!failedPreparation&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <Dialog open={depositing} onOpenChange={open=>{if(!busy)setDepositing(open);}}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>Deposit</DialogTitle><DialogDescription>Add cash from your Coinbase portfolio to this Take and invest toward its target weights.</DialogDescription></DialogHeader><InvestmentAmountForm title={null} actionLabel="Deposit" amountLabel="Amount to deposit in dollars" minimum={minimum} summary={summary} funding={funding} maxAmount={maxAmount} amount={amount} onAmountChange={v=>{setAmount(v);operation.current=null;}} disabled={busy||!amount||preflight?.ok!==true} busyLabel={busy?busyLabel:undefined} onInvest={()=>invest()} currencyControl={currencyControl('coinbase-deposit-currency')} footnote={`Money stays in ${view.accountLabel}. Investing assigns it to the take and starts the first orders.`}/>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}</DialogContent></Dialog>
  <TakeMoneyOutMenu cashOnly={cashOnly} open={choosing} title={view.takeTitle} busy={busy}
   canReduce={view.balances.some(b=>!['USD','USDC'].includes(b.asset)&&Number(b.quantity)>0)}
   onOpenChange={setChoosing}
   onReduce={()=>{setClosingTake(false);setWithdrawAmount('');setWithdrawAsset('USDC');setWithdrawPreview(null);setWithdrawError('');setError('');setWithdrawing(true);}}
   onClosePositions={()=>{setCloseSelection(null);setCloseDisplay(null);setClosingTake(true);setWithdrawAmount('');setWithdrawAsset('USDC');setWithdrawPreview(null);setWithdrawError('');setError('');setWithdrawing(true);}}/>
  <Dialog open={withdrawing} onOpenChange={open=>{if(!busy)setWithdrawing(open);}}><DialogContent className="max-w-sm" showCloseButton={!busy}><DialogHeader><DialogTitle>{closingTake?(mixedDeposit?'Close Coinbase holdings':'Close this take'):"Take money out"}</DialogTitle><DialogDescription>{closingTake?(cashOnly?`Release this Take’s uninvested cash in ${view.accountLabel}. No assets need to be sold.`:`Tick what to sell. Anything left unticked stays in ${view.accountLabel} as your own holding.`):"Sells a slice of each holding so the mix stays the same. You keep following with less invested."}</DialogDescription></DialogHeader>{!closingTake&&<ReducePositionsForm crypto accountName={view.accountLabel} holdings={view.balances.map(b=>({symbol:b.asset,quantity:b.quantity}))} amount={withdrawAmount} onAmountChange={next=>{setWithdrawPreview(null);setWithdrawError('');setError('');setWithdrawAmount(next);}} currency={withdrawAsset} band={withdrawBand}
 preview={validWithdrawal&&withdrawPreview?.withdrawal?.remainingValue!==undefined?{ok:true,legs:withdrawPreview.orders.map(o=>({symbol:o.product.split('-')[0],notional:o.notional,quantity:o.baseSize})),remainingValue:withdrawPreview.withdrawal.remainingValue,reasons:[],estimatedProceeds:withdrawPreview.withdrawal.estimatedProceeds,fees:String(withdrawPreview.orders.reduce((sum,o)=>sum+Number(o.fee),0))}:null}
 busy={busy} currencyControl={receiveCurrencyControl} error={withdrawalAmountError||bandError||withdrawError||error} loading={!withdrawalAmountError&&Number(withdrawAmount)>0&&withdrawBand?.possible===true&&!validWithdrawal&&!withdrawError&&!bandError}
 onRetry={withdrawalAmountError?undefined:()=>{setError('');setPreviewRetry(v=>v+1);}} onCancel={()=>setWithdrawing(false)} onConfirm={()=>void withdraw()}/>}{closingTake&&(closeDisplay?.quote===withdrawAsset&&closeDisplay.closePositions?<ClosePositionsTable
 holding={{valuation:{complete:true,currency:withdrawAsset,cash:closeDisplay.closeCash?.find(c=>c.asset===withdrawAsset)?.quantity??'0',totalValue:closeDisplay.valuation??null},positions:closeDisplay.closePositions}}
 selected={new Set(closeSelection??closeDisplay.closePositions.filter(p=>p.sellable).map(p=>p.symbol))}
 onChange={next=>{setWithdrawPreview(null);setCloseSelection([...next]);}}
 accountName={view.accountLabel} estimatedProceeds={validWithdrawal?withdrawPreview?.withdrawal?.estimatedProceeds??null:null} headerControl={cashOnly?undefined:receiveCurrencyControl} crypto disabled={busy} cashRows={closeDisplay.closeCash}/>:<div className="space-y-3">{!cashOnly&&receiveCurrencyControl}<p className="text-xs text-muted-foreground">Loading balances…</p></div>)}{closingTake&&!validWithdrawal&&!withdrawError&&<p role="status" className="text-xs text-muted-foreground">Checking the sale…</p>}{closingTake&&withdrawError&&<div><p role="alert" className="text-xs text-destructive">{withdrawError}</p><button type="button" className="mt-2 text-xs underline underline-offset-4" disabled={busy} onClick={()=>{setError('');setPreviewRetry(value=>value+1);}}>Retry preview</button></div>}{withdrawNotice&&<p role="status" className="text-xs text-muted-foreground">{withdrawNotice}</p>}{closingTake&&<DialogFooter><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setWithdrawing(false)}>{closingTake?'Keep take':'Cancel'}</Button><Button size="sm" className="rounded-full px-5" disabled={busy||!validWithdrawal||!!withdrawError} onClick={()=>void withdraw()}>{busy?'Working…':closingTake?(cashOnly?'Close and release cash':withdrawPreview?.orders.length===0?'Keep assets and close':'Sell and close'):'Take money out'}</Button></DialogFooter>}</DialogContent></Dialog>
 </section>;
}
