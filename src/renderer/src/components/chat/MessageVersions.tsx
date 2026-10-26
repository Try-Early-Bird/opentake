import {useState} from 'react';
import {ChevronLeft,ChevronRight} from 'lucide-react';
/** "‹ 2 / 3 ›": steps between versions of a message; the count opens the full list. */
export function VersionPager({number,count,disabled,busy=false,onStep,onToggle,open}:{number:number;count:number;disabled:boolean;busy?:boolean;onStep:(target:number)=>void;onToggle?:()=>void;open?:boolean}){
 const step='rounded p-0.5 hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent';
 return <div className="flex items-center gap-1 tabular-nums">
  <button type="button" aria-label="Previous version" disabled={disabled||busy||number<=1} onClick={()=>onStep(number-1)} className={step}><ChevronLeft size={14} aria-hidden="true"/></button>
  {onToggle?<button type="button" aria-label={`Version ${number} of ${count}`} aria-expanded={open} onClick={onToggle} className="rounded px-1 hover:text-foreground">{number} / {count}</button>:<span aria-label={`Version ${number} of ${count}`}>{number} / {count}</span>}
  <button type="button" aria-label="Next version" disabled={disabled||busy||number>=count} onClick={()=>onStep(number+1)} className={step}><ChevronRight size={14} aria-hidden="true"/></button>
 </div>;
}
export function MessageVersions({takeId,messageId,number,count,disabled,onBranch}:{takeId:string;messageId:string;number:number;count:number;disabled:boolean;onBranch:(id:string)=>void}){
 const [items,setItems]=useState<{id:string;number:number}[]>([]),[next,setNext]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[open,setOpen]=useState(false);
 async function load(cursor?:string){setBusy(true);try{const page=await window.takes.messageVersions(takeId,messageId,cursor);setItems(old=>cursor?[...old,...page.items]:page.items);setNext(page.next);setError('');return page;}catch{setError('Could not load versions. Try again.');return null;}finally{setBusy(false);}}
 // Versions load newest first in pages: read pages until the neighbour turns up.
 async function step(target:number){
  let found=items.find(v=>v.number===target),cursor=items.length?next:undefined;
  if(!found&&(!items.length||cursor)){setBusy(true);try{let page=cursor===undefined?await window.takes.messageVersions(takeId,messageId):null,loaded=page?.items??[];cursor=page?page.next:cursor;
   while(!loaded.some(v=>v.number===target)&&cursor){page=await window.takes.messageVersions(takeId,messageId,cursor);loaded=[...loaded,...page.items];cursor=page.next;}
   setItems(old=>[...old,...loaded.filter(v=>!old.some(o=>o.id===v.id))]);setNext(cursor??null);setError('');found=loaded.find(v=>v.number===target);}catch{setError('Could not load versions. Try again.');}finally{setBusy(false);}}
  if(found)onBranch(found.id);
 }
 return <div className="flex flex-col items-end gap-2"><VersionPager number={number} count={count} disabled={disabled} busy={busy} onStep={target=>void step(target)} open={open} onToggle={()=>{setOpen(v=>!v);if(!open&&!items.length&&!busy)void load();}}/>
  {open&&<div className="flex flex-wrap justify-end gap-2">{items.map(v=><button type="button" key={v.id} disabled={disabled||v.id===messageId} aria-label={`Choose version ${v.number}`} onClick={()=>onBranch(v.id)} className="rounded bg-muted px-2 py-1">{v.number}</button>)}{next&&<button type="button" disabled={busy} onClick={()=>void load(next)}>Older versions</button>}{busy&&<span role="status">Loading versions…</span>}</div>}
  {error&&<span role="alert">{error}</span>}</div>;
}
