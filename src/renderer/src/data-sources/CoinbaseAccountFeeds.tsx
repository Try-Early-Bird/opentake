import {MappingRow} from './MappingField';
import {useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '../components/ui/dialog';
import type {CoinbaseAccountSourceSetting,CoinbaseAccountSourceConfig} from '../../../shared/coinbase-field-mappings';
const feeds:Array<{id:keyof CoinbaseAccountSourceConfig['reads'];name:string;mapping:string}>=[
 {id:'portfolio',name:'Balances and holdings',mapping:'Portfolio balances → account totals; spot positions → assets, quantities and values'},
 {id:'positionDetails',name:'Position details',mapping:'Cost basis and average entry price → holding cost information'},
 {id:'orders',name:'Orders',mapping:'Order ID, product, side and status → account order activity'},
 {id:'fills',name:'Fills',mapping:'Execution ID, quantity, price and fees → account execution activity'},
 {id:'history',name:'Transaction history',mapping:'Deposits, withdrawals and transactions → capital history and historical valuation'},
];
export function CoinbaseAccountFeeds({accountId,accountLabel}:{accountId:string;accountLabel:string}){
 const [open,setOpen]=useState(false),[setting,setSetting]=useState<CoinbaseAccountSourceSetting>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function show(){setOpen(true);setSetting(undefined);setError('');setBusy(true);try{setSetting(await window.dataSources.configure({action:'coinbase-account-source',accountId}) as CoinbaseAccountSourceSetting);}catch{setError('Could not load account feeds. Close and retry.');}finally{setBusy(false);}}
 function toggle(id:keyof CoinbaseAccountSourceConfig['reads'],enabled:boolean){setSetting(old=>old?{...old,config:{reads:{...old.config.reads,[id]:enabled,...(id==='portfolio'&&!enabled?{positionDetails:false,history:false}:{})}}}:old);}
 async function save(){if(!setting)return;setBusy(true);setError('');try{setSetting(await window.dataSources.configure({action:'coinbase-account-save',setting:{accountId:setting.accountId,revision:setting.revision,config:setting.config}}) as CoinbaseAccountSourceSetting);setOpen(false);}catch{setError('Could not save feeds. Sync may be running or the settings changed. Close and reopen to retry.');}finally{setBusy(false);}}
 return <><button type="button" onClick={()=>void show()} className="text-xs underline underline-offset-4">Choose feeds</button>{open&&<Dialog open onOpenChange={value=>{if(!busy)setOpen(value);}}><DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto" showCloseButton={!busy}><DialogTitle>Choose Coinbase feeds</DialogTitle><DialogDescription>Background collection for {accountLabel}. Coinbase field mappings are configured for you.</DialogDescription>
 <fieldset disabled={busy||!setting} className="divide-y divide-border">{feeds.map(feed=><label key={feed.id} className="flex items-start gap-3 py-4"><input type="checkbox" className="mt-1" checked={setting?.config.reads[feed.id]??false} disabled={!setting||((feed.id==='positionDetails'||feed.id==='history')&&!setting.config.reads.portfolio)} onChange={event=>toggle(feed.id,event.target.checked)}/><MappingRow label={feed.name}><p className="text-xs text-muted-foreground">{feed.mapping}</p></MappingRow></label>)}</fieldset>
 <p className="text-xs text-muted-foreground">Position details and history require balances and holdings. Turning off a feed keeps previously saved data; it stops background updates. Manual refresh, recovery and trading-required reads may still fetch required data.</p>
 {setting?.unreadable&&<p role="status" className="text-xs text-destructive">Saved feed choices couldn’t be read. All feeds are on until you save.</p>}
 {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}<footer className="flex justify-end gap-3"><button disabled={busy} onClick={()=>setOpen(false)} className="rounded-full border border-border px-4 py-2 text-sm">Cancel</button><button disabled={busy||!setting} onClick={()=>void save()} className="rounded-full bg-foreground px-4 py-2 text-sm text-background disabled:opacity-40">{busy?'Working…':'Save feeds'}</button></footer>
 </DialogContent></Dialog>}</>;
}
