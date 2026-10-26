import {useState} from 'react';
import type {CoinbaseCapitalView} from '../../../shared/coinbase-capital';
import {Button} from '../components/ui/button';
import {Select} from '../components/ui/select';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '../components/ui/dialog';

export function CoinbaseRiskSettings({takeId,view,onSaved}:{takeId:string;view:CoinbaseCapitalView;onSaved:(view:CoinbaseCapitalView)=>void}) {
 const [editing,setEditing]=useState<CoinbaseCapitalView|null>(null),[currency,setCurrency]=useState('USDC');
 const [daily,setDaily]=useState(''),[loss,setLoss]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 if(!view.risk)return null;
 const begin=()=>{setEditing(view);setCurrency(view.risk!.policy.currency??'USDC');setDaily(view.risk!.policy.maxDailyNotional??'');setLoss(view.risk!.policy.maxLoss??'');setError('');};
 const save=async()=>{
  if(!editing?.risk)return;
  setBusy(true);setError('');
  try{
   const next=await window.strategies.saveCoinbaseRisk({takeId,accountId:editing.accountId,allocationId:editing.risk.allocationId,expected:editing.risk.policy,policy:{currency:currency as 'USD'|'USDC',maxDailyNotional:daily.trim()||null,maxLoss:loss.trim()||null}});
   onSaved(next);setEditing(null);
  }catch(e){setError(e instanceof Error?e.message:'Could not save limits.');}finally{setBusy(false);}
 };
 return <>
  <Button size="sm" variant="outline" onClick={begin}>Risk limits</Button>
  <Dialog open={editing!==null} onOpenChange={open=>{if(!open&&!busy)setEditing(null);}}>
   <DialogContent showCloseButton={!busy}>
    <DialogHeader><DialogTitle>Allocation risk limits</DialogTitle><DialogDescription>{editing?.takeTitle} · {editing?.accountLabel}. These limits apply only to this Take’s allocation in this account.</DialogDescription></DialogHeader>
    <div className="space-y-4">
     <div className="space-y-2"><label htmlFor="coinbase-risk-currency" className="text-sm">Limit currency</label><Select id="coinbase-risk-currency" ariaLabel="Limit currency" value={currency} items={[{value:'USDC',label:'USDC'},{value:'USD',label:'USD'}]} disabled={busy} onValueChange={setCurrency}/><p className="text-xs text-muted-foreground">Orders must use this quote currency while a limit is set.</p></div>
     <div className="space-y-2"><label htmlFor="coinbase-risk-daily" className="text-sm">Daily trading amount</label><input id="coinbase-risk-daily" className="h-10 w-full rounded-lg bg-muted/60 px-3 text-sm tabular-nums outline-none focus:ring-1 focus:ring-border" inputMode="decimal" placeholder="No limit" value={daily} disabled={busy} onChange={e=>setDaily(e.target.value)}/><p className="text-xs text-muted-foreground">Combined buy and sell order value, including pending reservations. Resets at midnight UTC.</p></div>
     <div className="space-y-2"><label htmlFor="coinbase-risk-loss" className="text-sm">Maximum allocation loss</label><input id="coinbase-risk-loss" className="h-10 w-full rounded-lg bg-muted/60 px-3 text-sm tabular-nums outline-none focus:ring-1 focus:ring-border" inputMode="decimal" placeholder="No limit" value={loss} disabled={busy} onChange={e=>setLoss(e.target.value)}/><p className="text-xs text-muted-foreground">Compares current allocation value with net assigned capital in this currency. This is a total loss limit, not a daily limit.</p></div>
     <p className="text-xs text-muted-foreground">Leave a field empty for no limit. Exceeding a limit blocks new orders; it does not sell holdings or cancel existing orders.</p>
    </div>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setEditing(null)}>Cancel</Button><Button disabled={busy} onClick={()=>void save()}>{busy?'Saving…':'Save limits'}</Button></DialogFooter>
   </DialogContent>
  </Dialog>
 </>;
}
