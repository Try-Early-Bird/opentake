import { Select } from '../components/ui/select';
import { Button } from '../components/ui/button';
import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { instrumentKey, proposalPayloadSchema, basketSchema, rebalanceSchema, metadataSchema, type ProposalPayload } from '../../../shared/strategies';
import { rowInstrument, allocationTotal, bpsToPercentText, investableBps, parseHoldingsList, parseDelimitedHoldings, parseHoldingsTable, percentToBps, scaleWeightsTo, splitWeightsEvenly, type AllocationRow } from '../../../shared/basket-editor';

// A staged dialog with local draft/revision semantics.
export function BasketEditor({initial,onSave,onCancel,busy,saveError}:{initial?:ProposalPayload;onSave:(p:ProposalPayload)=>Promise<void>;onCancel:()=>void;busy:boolean;saveError?:string}){
 const [step,setStep]=useState(0);
 const steps=['Holdings','Rules','Details','Review'];
 const [unsupportedRequests,setUnsupportedRequests]=useState(initial?.unsupportedRequests??[]);
 const [title,setTitle]=useState(initial?.metadata.title??'');
 const [description,setDescription]=useState(initial?.metadata.description??'');
 const [rationale,setRationale]=useState(initial?.metadata.rationale??'');
 const [rows,setRows]=useState<AllocationRow[]>(initial?.spec.target.weights.map(w=>({...w.instrument,weight:bpsToPercentText(w.bps),reason:initial.metadata.holdings.find(h=>instrumentKey(h.instrument)===instrumentKey(w.instrument))?.reason??''}))??[]);
 const [cash,setCash]=useState(bpsToPercentText(initial?.spec.target.cashBps??0));
 const [rebalance,setRebalance]=useState(initial?.spec.rebalance??{schedule:'never' as const,driftBandPoints:null,driftBandRelative:null});
 const initialVenues=[...new Set(initial?.spec.target.weights.map(w=>w.instrument.venue)??[])];
 const [venue,setVenue]=useState(initialVenues.length===1?initialVenues[0]!:initialVenues.length>1?'':'robinhood'),[symbol,setSymbol]=useState(''),[paste,setPaste]=useState<string|null>(null),[error,setError]=useState('');
 const file=useRef<HTMLInputElement>(null);
 const field='h-10 rounded-lg bg-muted/60 px-3 text-sm outline-none ring-1 ring-transparent transition-colors focus:bg-muted focus:ring-border disabled:opacity-60';
 const total=allocationTotal(rows,cash);
 function importRows(added:ReturnType<typeof parseHoldingsList>){
  if(!venue){setError('Choose a venue for the new holdings.');return;}
  if(!added.length){setError('No symbols found. Paste one symbol and optional percentage per line.');return;}
  setRows(old=>{const result=[...old];for(const r of added)if(!result.some(p=>instrumentKey(p)===instrumentKey({venue,symbol:r.symbol})))result.push({venue,symbol:r.symbol,weight:r.weight??'',reason:''});return result;});setPaste(null);setError('');
 }
 function edit(index:number,patch:Partial<AllocationRow>){setRows(old=>old.map((r,i)=>i===index?{...r,...patch}:r));}
 // The agent's considered candidates carry through manual edits; one added as a holding leaves the list.
 function considered(){return (initial?.metadata.considered??[]).filter(c=>!c.instrument||!rows.some(r=>instrumentKey(r)===instrumentKey(c.instrument!)));}
 function payload(){const kept=considered();return {metadata:{title,description,rationale,holdings:rows.filter(r=>r.reason.trim()).map(r=>({instrument:rowInstrument(r),reason:r.reason})),...(kept.length?{considered:kept}:{})},spec:{schemaVersion:1,kind:'basket',target:{weights:rows.map(r=>({instrument:rowInstrument(r),bps:percentToBps(r.weight)})),cashBps:percentToBps(cash)},rebalance},unsupportedRequests};}
 async function next(){
  setError('');const data=payload();
  const result=step===0?basketSchema.safeParse({...data.spec,rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}}):step===1?rebalanceSchema.safeParse(rebalance):step===2?metadataSchema.safeParse(data.metadata):proposalPayloadSchema.safeParse(data);
  if(!result.success){setError(result.error.issues.map(i=>i.message).join(' '));return;}
  if(step<3){setStep(step+1);return;}
  const complete=proposalPayloadSchema.safeParse(data);
  if(!complete.success){setError(complete.error.issues.map(i=>i.message).join(' '));return;}
  try{await onSave(complete.data);}catch(e){setError(e instanceof Error?e.message:'Could not save draft.');}
 }
 return <Dialog open onOpenChange={open=>{if(!open&&!busy)onCancel();}}>
 <DialogContent className="max-h-[calc(100vh-3rem)] sm:max-w-xl sm:p-7" showCloseButton={!busy}>
 <form aria-label="Take editor" onSubmit={e=>{e.preventDefault();void next();}} className="flex min-w-0 flex-col">
 <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Progress">{steps.map((label,index)=><li key={label} className="flex items-center gap-2">{index>0&&<span className="h-px w-4 bg-border" aria-hidden="true"/>}<button type="button" disabled={busy||index>=step} aria-current={index===step?'step':undefined} onClick={()=>{setStep(index);setError('');}} className={`flex items-center gap-1.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring ${index===step?'font-medium':'text-muted-foreground'}`}><span className={`flex size-4 items-center justify-center rounded-full text-[10px] tabular-nums ${index<step?'bg-foreground text-background':index===step?'border border-foreground':'border border-border'}`}>{index<step?<Check size={10}/>:index+1}</span>{label}</button></li>)}</ol>
 <div className="mt-5 space-y-2"><DialogTitle>{step===0?'Edit take holdings':step===1?'Rebalancing':step===2?'Name and details':'Review your changes'}</DialogTitle><DialogDescription>{step===0?'Adjust the holdings and target weights, or import a list.':step===1?'When should the take pull holdings back to their target weights?':step===2?'Explain the thesis and why these holdings belong together.':'Saving updates the draft. Review and commit it separately in the take panel.'}</DialogDescription></div>
 <fieldset disabled={busy} className="mt-5 min-w-0 space-y-4">
 {step===0&&<>
 <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 text-xs">Venue<input aria-label="Holding venue" value={venue} onChange={e=>setVenue(e.target.value.trim().toLowerCase())} className={`${field} mt-1 block w-36`}/></label><label className="text-xs">Symbol<input aria-label="New holding symbol" value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} className={`${field} mt-1 block w-32`}/></label><button type="button" className={field} onClick={()=>{if(symbol.trim()){importRows([{symbol:symbol.trim(),weight:null}]);setSymbol('');}}}>Add holding</button></div>
 <ul className="max-h-88 divide-y divide-border overflow-y-auto rounded-lg border border-border">
 {rows.map((row,i)=><li key={`${i}-${row.venue}-${row.symbol}`} className="flex flex-col gap-1 px-3 py-2"><div className="flex items-center gap-3"><span className="w-16 shrink-0 text-sm row-title">{row.symbol}</span><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{row.venue}{row.market?' · Crypto':''}</span><span className="flex shrink-0 items-center gap-1.5"><input aria-label={`${row.symbol} weight`} inputMode="decimal" value={row.weight} onChange={e=>edit(i,{weight:e.target.value})} className={`${field} w-20 text-right`}/><span className="text-xs">%</span></span><button type="button" aria-label={`Remove ${row.symbol}`} onClick={()=>setRows(old=>old.filter((_,j)=>j!==i))}>×</button></div><input aria-label={`${row.symbol} rationale`} placeholder="Why this holding? (optional)" maxLength={2000} value={row.reason} onChange={e=>edit(i,{reason:e.target.value})} className="bg-transparent py-1 text-xs"/></li>)}
 <li className="flex items-center gap-3 px-3 py-2"><span className="flex-1 text-sm row-title">Cash</span><input aria-label="Cash weight" inputMode="decimal" value={cash} onChange={e=>setCash(e.target.value)} className={`${field} w-20 text-right`}/><span className="text-xs">%</span><span className="w-2"/></li></ul>
 <div className="flex flex-wrap gap-4 text-xs underline"><button type="button" onClick={()=>file.current?.click()}>Import CSV / TSV</button><button type="button" onClick={()=>setPaste('')}>Paste list</button><button type="button" onClick={()=>setRows(scaleWeightsTo(rows,investableBps(cash)))}>Scale to 100%</button><button type="button" onClick={()=>setRows(splitWeightsEvenly(rows,investableBps(cash)))}>Split equally</button></div>
 <input ref={file} type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;if(f.size>1024*1024){setError('Import a file smaller than 1 MB.');return;}void f.text().then(text=>importRows(parseHoldingsTable(parseDelimitedHoldings(text),venue))).catch(()=>setError('Could not read file.'));}}/>
 {paste!==null&&<div className="space-y-2"><textarea aria-label="Paste holdings" value={paste} onChange={e=>setPaste(e.target.value)} placeholder={'VTI 70\nBND 30'} className={`${field} w-full`}/><button type="button" className={field} onClick={()=>importRows(parseHoldingsList(paste,venue))}>Import pasted holdings</button></div>}
 <div className="h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-foreground" style={{width:`${Math.max(0,Math.min(100,total))}%`}}/></div><p className="text-xs" role="status">Total {total.toFixed(2)}%{total>100?' · Overallocated':total<100?' · Unassigned':''}</p>
 </>}
 {step===1&&<>
 <div className="divide-y divide-border">
 <div className="grid items-center gap-x-4 gap-y-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
 <div><label htmlFor="rebalance-schedule" className="text-sm font-medium">Rebalance schedule</label><p className="mt-0.5 text-xs text-muted-foreground">{rebalance.schedule==='never'?'Checked every 30 seconds while the app is running.':'Rebalance at a set interval regardless of drift.'}</p></div>
 <Select id="rebalance-schedule" ariaLabel="Rebalance schedule" value={rebalance.schedule} disabled={busy} onValueChange={value=>setRebalance({...rebalance,schedule:value as typeof rebalance.schedule})} items={[{value:'never',label:'When holdings drift'},{value:'daily',label:'Daily'},{value:'monthly',label:'Monthly'},{value:'quarterly',label:'Quarterly'},{value:'annual',label:'Annual'}]} className="w-full text-xs sm:w-48"/>
 </div>
 <div className="grid items-center gap-x-4 gap-y-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
 <div><h3 className="text-sm font-medium">When a holding drifts</h3><p className="mt-0.5 text-xs text-muted-foreground">Rebalance once any weight is this far from target</p></div>
 <div className="flex items-center gap-2">{(['driftBandPoints','driftBandRelative'] as const).map((key,index)=><div key={key} className="flex items-center gap-2">{index>0&&<span className="text-xs text-muted-foreground">or</span>}<label className="flex h-9 items-center gap-1 rounded-lg border border-border px-2.5 focus-within:border-foreground focus-within:ring-1 focus-within:ring-ring"><input aria-label={key==='driftBandPoints'?'Drift percentage points':'Relative drift percent'} type="number" inputMode="decimal" step="any" min={key==='driftBandPoints'?1:5} max={key==='driftBandPoints'?25:50} placeholder="Off" value={rebalance[key]??''} onChange={e=>setRebalance({...rebalance,[key]:e.target.value===''?null:Number(e.target.value)})} className="w-8 bg-transparent text-right font-mono text-xs tabular-nums outline-none placeholder:text-muted-foreground [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [appearance:textfield]"/><span className="text-xs text-muted-foreground">{key==='driftBandPoints'?'pts':'%'}</span></label></div>)}</div>
 </div>
 <p className="pt-3 text-xs leading-relaxed text-muted-foreground">{rebalance.schedule==='never'&&rebalance.driftBandPoints===null&&rebalance.driftBandRelative===null&&'Set a drift threshold to enable drift rebalancing. '}{rebalance.driftBandPoints!==null&&rebalance.driftBandPoints>=1&&rebalance.driftBandPoints<=25&&`${rebalance.driftBandPoints} ${rebalance.driftBandPoints===1?'pt':'pts'} means a 50% target triggers below ${Number((50-rebalance.driftBandPoints).toFixed(6))}% or above ${Number((50+rebalance.driftBandPoints).toFixed(6))}%. `}Rules take effect when you commit; active investments may rebalance to the new weights.</p>
 </div>
 </>}
 {step===2&&<>
 <label className="block text-sm">Name<input required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)} className={`${field} mt-1 w-full`}/></label>
 <label className="block text-sm">Description<textarea rows={3} value={description} maxLength={4000} onChange={e=>setDescription(e.target.value)} className={`${field} mt-1 h-auto w-full py-2`}/></label>
 <label className="block text-sm">Rationale<textarea rows={4} value={rationale} maxLength={12000} onChange={e=>setRationale(e.target.value)} className={`${field} mt-1 h-auto w-full py-2`}/></label>
 </>}
 {step===3&&<section className="space-y-4"><div><h3 className="text-lg font-medium">{title}</h3>{description&&<p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{description}</p>}</div><ul className="divide-y divide-border border-y border-border">{rows.map(row=><li key={instrumentKey(row)} className="py-3"><div className="flex items-center gap-3 text-sm"><span className="row-title">{row.symbol}</span><span className="min-w-0 flex-1 truncate text-muted-foreground">{row.venue}{row.market?' · Crypto':''}</span><span className="tabular-nums">{row.weight}%</span></div>{row.reason&&<p className="mt-1 text-xs text-muted-foreground">{row.reason}</p>}</li>)}<li className="flex justify-between py-3 text-sm"><span>Cash</span><span>{cash}%</span></li></ul>{rationale&&<p className="whitespace-pre-wrap text-sm leading-6">{rationale}</p>}<dl className="space-y-2 text-xs"><div className="flex justify-between"><dt>Rebalance schedule</dt><dd className="capitalize">{rebalance.schedule==='never'?'When holdings drift':rebalance.schedule}</dd></div><div className="flex justify-between"><dt>Drift band</dt><dd>{rebalance.driftBandPoints===null?'Off':`${rebalance.driftBandPoints} percentage points`}</dd></div><div className="flex justify-between"><dt>Relative drift</dt><dd>{rebalance.driftBandRelative===null?'Off':`${rebalance.driftBandRelative}%`}</dd></div></dl>{!!unsupportedRequests.length&&<div className="space-y-2"><p className="text-xs text-muted-foreground">Review notes</p>{unsupportedRequests.map((note,index)=><div key={`${index}:${note}`} className="flex items-start gap-2 text-xs"><p className="flex-1">{note}</p><Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove review note ${index+1}`} onClick={()=>setUnsupportedRequests(notes=>notes.filter((_,i)=>i!==index))}>Remove</Button></div>)}</div>}</section>}
 </fieldset>
 {(error||saveError)&&<p role="alert" className="mt-4 text-sm text-destructive">{error||saveError}</p>}
 <div className={`flex items-center justify-between gap-3 ${step===1?'mt-8 pt-1':'mt-6 pt-4'}`}><button type="button" disabled={busy} onClick={()=>{if(step){setStep(step-1);setError('');}else onCancel();}} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50">{step>0&&<ArrowLeft size={14}/>} {step?'Back':'Cancel'}</button><button disabled={busy} className="flex items-center gap-1.5 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background disabled:opacity-50">{busy?'Saving…':step===3?'Save draft':steps[step+1]}{step<3&&<ArrowRight size={14}/>}</button></div>
 </form>
 </DialogContent>
 </Dialog>;
}
