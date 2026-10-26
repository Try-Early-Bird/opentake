import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, Copy, Trash2, Check, ChevronRight, Info, LockKeyhole } from 'lucide-react';
import { useBlocker } from '@tanstack/react-router';
import { Tabs } from '@base-ui/react/tabs';
import type { InstructionProfile } from '../../../shared/takes';
import { emptyModeConfig, modePrompt, composeInstructions, type ModeConfig } from '../../../shared/instruction-modes';
import type { ManagedServer, ManagedTool } from '../../../shared/mcp-management';
import { toolLabel } from '../components/McpToolRow';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog';

const button='inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm hover:bg-muted disabled:opacity-40';
const primary=`${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const panel='rounded-3xl border border-border/40 bg-muted/20';

const changed=(p:InstructionProfile)=>!p.published||JSON.stringify([p.name,p.text,p.config,p.builtin&&p.followsDefault])!==JSON.stringify([p.published.name,p.published.text,p.published.config,!!p.published.followsDefault]);

export function AiInstructions() {
 const [profiles,setProfiles]=useState<InstructionProfile[]>([]);
 const [selected,setSelected]=useState<string|null>(null);const [reset,setReset]=useState(0);
 const [defaults,setDefaults]=useState('');const [required,setRequired]=useState('');const [about,setAbout]=useState('');
 const [ready,setReady]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [deleting,setDeleting]=useState(false);
 const flush=useRef<()=>Promise<void>>(async()=>{});
 async function refresh(){const [config,rows]=await Promise.all([window.takes.instructions(),window.takes.instructionProfiles()]);setProfiles(rows);setDefaults(config.defaults);setRequired(config.required);setAbout(config.about);setReady(true);return rows;}
 useEffect(()=>{void refresh().catch(()=>setError('Could not load instructions. Try again.'));},[]);
 useBlocker({shouldBlockFn:async()=>{try{await flush.current();return false;}catch(e){setError(e instanceof Error?e.message:'Could not save changes.');return true;}},enableBeforeUnload:false});
 const current=profiles.find(p=>p.id===selected);
 async function action(fn:()=>Promise<void>){setBusy(true);setError('');try{await flush.current();await fn();}catch(e){setError(e instanceof Error?e.message:'Could not save changes.');}finally{setBusy(false);}}
 async function create(kind:'blank'|'copy'){
  await action(async()=>{
   const rows=await refresh();const source=kind==='copy'?rows.find(p=>p.id===selected):undefined;
   const seed=source??{name:'Untitled instructions',text:'',config:emptyModeConfig};
   const base=seed.name.replace(/ \(\d+\)$/,'').slice(0,72);
   let name=base;let n=2;
   if(source)name=`${base} (${n++})`;
   while(rows.some(p=>p.name.toLowerCase()===name.toLowerCase()))name=`${base} (${n++})`;
   const id=await window.takes.saveInstructionProfile({name,text:seed.text,config:seed.config});await refresh();setSelected(id);
  });
 }
 return <section className="space-y-6">
  {!selected&&<div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-medium">AI instructions</h2><p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">Save how you want the AI to respond, then choose your instructions in chat.</p></div><button disabled={busy||!ready} className={primary} onClick={()=>void create('blank')}><Plus size={16}/>New instructions</button></div>}
  {error&&<p role="alert" className="text-sm text-destructive">{error} <button className="underline" onClick={()=>void action(async()=>{await refresh();})}>Retry</button></p>}
  {!ready&&!error&&<p className="text-sm text-muted-foreground">Loading instructions…</p>}
  {ready&&!selected&&<div className="space-y-7">
   <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">In chat</h3>{profiles.filter(p=>p.published).map(p=><InstructionListRow key={p.id} profile={p} onClick={()=>setSelected(p.id)}/>)}</div>
   {!!profiles.filter(p=>!p.published).length&&<div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Drafts</h3>{profiles.filter(p=>!p.published).map(p=><InstructionListRow key={p.id} profile={p} onClick={()=>setSelected(p.id)}/>)}</div>}
  </div>}
  {current&&<ModeEditor key={`${current.id}:${reset}`} profile={current} defaults={defaults} required={required} about={about} flush={flush} busy={busy} onBack={()=>void action(async()=>{await refresh();setSelected(null);})} onDuplicate={()=>void create('copy')} onDelete={current.builtin?undefined:()=>setDeleting(true)} onRestore={()=>void action(async()=>{await window.takes.restoreDefaultInstructions(current.id);await refresh();setReset(n=>n+1);})} onPublish={()=>void action(async()=>{await window.takes.publishInstructionProfile(current.id);await refresh();})} onSaved={value=>setProfiles(rows=>rows.map(p=>p.id===value.id?{...value,published:p.published}:p))}/>}
  <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent><DialogTitle>Delete {current?.name}?</DialogTitle><DialogDescription>This removes the instruction set and its draft. Chats using it return to General. Past responses retain their original instructions.</DialogDescription><DialogFooter><button disabled={busy} className={button} onClick={()=>setDeleting(false)}>Cancel</button><button disabled={busy} className={`${button} bg-destructive text-destructive-foreground`} onClick={()=>void action(async()=>{if(current)await window.takes.removeInstructionProfile(current.id);setDeleting(false);setSelected(null);await refresh();})}>Delete instructions</button></DialogFooter></DialogContent></Dialog>
 </section>;
}

function ModeEditor({profile,defaults,required,about,flush,busy,onPublish,onSaved,onBack,onDuplicate,onDelete,onRestore}:{profile:InstructionProfile;defaults:string;required:string;about:string;flush:React.MutableRefObject<()=>Promise<void>>;busy:boolean;onBack:()=>void;onDuplicate:()=>void;onDelete?:()=>void;onRestore:()=>void;onPublish:()=>void;onSaved:(profile:InstructionProfile)=>void}) {
 const [draft,setDraft]=useState(profile);const latest=useRef(draft);latest.current=draft;
 const saved=useRef(JSON.stringify([profile.name,profile.text,profile.config]));const queue=useRef(Promise.resolve());
 // Mirrors the host: General stops following the default once saved text differs from it.
 const follows=useRef(profile.followsDefault);
 const [status,setStatus]=useState('Saved');const [error,setError]=useState('');
 const [tab,setTab]=useState('instructions');
 const [catalog,setCatalog]=useState<{servers:ManagedServer[];tools:ManagedTool[]}>();
 const [toolsError,setToolsError]=useState('');
 async function save(){const value=latest.current;const encoded=JSON.stringify([value.name,value.text,value.config]);
  const task=queue.current.catch(()=>{}).then(async()=>{if(saved.current===encoded)return;setStatus('Saving draft…');setError('');try{await window.takes.saveInstructionProfile({id:value.id,name:value.name,text:value.text,config:value.config});saved.current=encoded;follows.current=follows.current&&value.text===defaults;onSaved({...value,followsDefault:follows.current,updatedAt:new Date().toISOString()});setStatus('Saved');}catch(e){setStatus('Draft not saved');setError(e instanceof Error?e.message:'Could not save draft.');throw e;}});queue.current=task;return task;
 }
 flush.current=save;
 useEffect(()=>()=>{flush.current=async()=>{};},[]);
 useEffect(()=>{const timer=setTimeout(()=>void save().catch(()=>{}),500);return()=>clearTimeout(timer);},[draft]);
 useEffect(()=>()=>{void save().catch(()=>{});},[]);

 useEffect(()=>{void window.mcp.list().then(setCatalog).catch(()=>setToolsError('Could not load tools. Reopen the instruction set to retry.'));},[]);
 function config(patch:Partial<ModeConfig>){setDraft(p=>({...p,config:{...p.config,...patch}}));}
 const published=profile.published;const following=profile.builtin&&follows.current&&draft.text===defaults;
 const dirty=!published||JSON.stringify([draft.name,draft.text,draft.config,following])!==JSON.stringify([published.name,published.text,published.config,!!published.followsDefault]);
 const field=(label:string,value:string,update:(value:string)=>void,placeholder:string)=><details className="group py-3" open={label==='Question guidance'?true:undefined}><summary className="flex cursor-pointer list-none items-center gap-3 text-sm row-title [&::-webkit-details-marker]:hidden"><ChevronRight size={15} className="shrink-0 text-muted-foreground group-open:rotate-90"/>{label}<span className="rounded-full bg-muted px-2 text-xs font-normal text-muted-foreground">Optional</span><span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">{value?'Configured':'Not set'}</span></summary><textarea className="mt-3 min-h-32 w-full resize-y rounded-2xl border border-border/50 bg-background/20 p-4 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={label} value={value} maxLength={6000} placeholder={placeholder} onChange={e=>update(e.target.value)} onBlur={()=>void save().catch(()=>{})}/></details>;
 return <fieldset disabled={busy} aria-busy={busy} className="min-w-0 space-y-6">
  <EditorToolbar busy={busy} onBack={onBack} onDuplicate={onDuplicate} onDelete={onDelete} status={status} badge={profile.builtin?'Default':published?'In chat':'Draft'} action={<button className={primary} disabled={busy||!draft.text.trim()||!draft.name.trim()||!dirty} onClick={onPublish}><Check size={15}/>{published?'Apply changes':'Use in chat'}</button>}/>
  {error&&<p role="alert" className="text-sm text-destructive">{error} <button className="underline" onClick={()=>void save().catch(()=>{})}>Retry save</button></p>}
  <div className="space-y-1"><input aria-label="Instruction name" readOnly={profile.builtin} className="w-full rounded bg-transparent text-2xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring" value={draft.name} maxLength={80} onChange={e=>setDraft(p=>({...p,name:e.target.value}))} onBlur={()=>void save().catch(()=>{})}/><input aria-label="Instruction description" className="w-full rounded bg-transparent text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" value={draft.config.description} maxLength={300} placeholder="Add a description — when would you use these?" onChange={e=>config({description:e.target.value})}/></div>
  <Tabs.Root value={tab} onValueChange={value=>setTab(String(value))}>
   <Tabs.List className="flex flex-wrap gap-1 pb-4" aria-label="Instruction editor">{[['instructions','Instructions'],['flow','Conversation'],['tools','Tools'],['preview','Preview']].map(([value,label])=><Tabs.Tab key={value} value={value} className="rounded-full px-4 py-2 text-sm text-muted-foreground data-[active]:bg-muted data-[active]:text-foreground">{label}</Tabs.Tab>)}</Tabs.List>
   <Tabs.Panel value="instructions" className="space-y-3">{profile.builtin&&<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground"><Info size={14} className="shrink-0"/>{following?'Follows the Opentake default, so improvements reach you automatically. Editing makes these your own.':<>Customized from the Opentake default.<button type="button" disabled={busy} className="underline hover:text-foreground disabled:opacity-40" onClick={onRestore}>Restore default</button></>}</p>}<InstructionText value={draft.text} onChange={text=>setDraft(p=>({...p,text}))} onBlur={()=>void save().catch(()=>{})}/></Tabs.Panel>
   <Tabs.Panel value="flow" className={`${panel} px-5 py-3`}>{field('Question guidance',draft.config.guidance,value=>config({guidance:value}),'When should the AI ask a question? What makes a useful choice?')}{field('Details to clarify',draft.config.details,value=>config({details:value}),'e.g. Thesis, angle, scope. Clarify the horizon only when relevant.')}{field('When to finish',draft.config.completion,value=>config({completion:value}),'Describe when there is enough information to summarize or continue.')}<p className="flex items-start gap-2 py-3 text-xs leading-5 text-muted-foreground"><Info size={14} className="mt-0.5 shrink-0"/>These settings guide the conversation without requiring a fixed order. Reply buttons and automatic Take updates are not available here yet.</p></Tabs.Panel>
   <Tabs.Panel value="tools"><InstructionTools catalog={catalog} error={toolsError} selected={draft.config.tools} onChange={tools=>config({tools})}/></Tabs.Panel>
   <Tabs.Panel value="preview"><InstructionPreview dirty={dirty} required={required} about={about} text={modePrompt(draft.text,draft.config)}/></Tabs.Panel>

  </Tabs.Root>
 </fieldset>;
}



function InstructionListRow({profile:p,onClick}:{profile:InstructionProfile;onClick:()=>void}) {
 return <button onClick={onClick} className="flex w-full items-center justify-between gap-4 rounded-lg py-3 text-left hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"><div className="min-w-0"><p className="flex flex-wrap items-center gap-2 text-sm row-title">{p.name}{p.builtin&&<span className="rounded-full bg-success/10 px-2 text-xs text-success">Default</span>}{(!p.published||changed(p))&&<span className="rounded-full bg-attention/10 px-2 text-xs text-attention">{p.published?'Changes saved':'Draft'}</span>}</p><p className="line-clamp-1 text-sm text-muted-foreground">{p.config.description||'No description'}</p></div><ChevronRight size={16} className="shrink-0 text-muted-foreground"/></button>;
}
function EditorToolbar({busy,onBack,onDuplicate,onDelete,status,badge,action}:{busy:boolean;onBack:()=>void;onDuplicate:()=>void;onDelete?:()=>void;status:string;badge:string;action?:React.ReactNode}) {
 return <div className="flex flex-wrap items-center justify-between gap-3"><button disabled={busy} className="flex items-center gap-1 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={onBack}><ArrowLeft size={14}/>All instructions</button><div className="flex flex-wrap items-center gap-3"><span className={`rounded-full px-2 text-xs font-medium ${badge==='Draft'?'bg-attention/10 text-attention':'bg-success/10 text-success'}`}>{badge}</span><span role="status" className="text-xs text-muted-foreground">{status}</span><button disabled={busy} className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Duplicate" title="Duplicate" onClick={onDuplicate}><Copy size={15}/></button>{onDelete&&<button disabled={busy} className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label="Delete instructions" title="Delete instructions" onClick={onDelete}><Trash2 size={15}/></button>}{action}</div></div>;
}
function InstructionText({value,onChange,onBlur}:{value:string;onChange:(value:string)=>void;onBlur:()=>void}) {
 return <div className={`${panel} overflow-hidden`}><textarea aria-label="Instructions" className="block min-h-80 w-full resize-y bg-transparent p-5 text-sm leading-7 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6" maxLength={24000} value={value} placeholder="Describe how the AI should respond…" onChange={e=>onChange(e.target.value)} onBlur={onBlur}/><div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 text-xs text-muted-foreground"><span className="flex items-center gap-2"><Info size={14}/>Required app instructions always apply.</span><span>{value.length.toLocaleString()} / 24,000</span></div></div>;
}
function InstructionPreview({required,about,text,dirty}:{required:string;about:string;text:string;dirty:boolean}) {
 const [copied,setCopied]=useState(false);const [error,setError]=useState('');
 useEffect(()=>{setCopied(false);},[required,about,text]);
 const heading='mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground';
 return <div className={`${panel} space-y-5 p-5 sm:p-6`}><div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{dirty?'Draft preview — these instruction changes are not active in chat. Apply them using the button above.':'Active instructions — used from your next message when this set is selected.'} The preview includes your saved About you text. Tool instructions are listed separately under MCP servers & tools → Guidance & changes and in tool history. The AI provider’s own instructions are not shown. This preview does not send a message.</p><button className={`${button} bg-muted`} onClick={()=>void navigator.clipboard.writeText(composeInstructions(required,about,text)).then(()=>{setCopied(true);setError('');}).catch(()=>setError('Could not copy instructions.'))}><Copy size={14}/>{copied?'Copied':'Copy'}</button></div>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}<div><h4 className={heading}><LockKeyhole size={13}/>Required by Opentake</h4><p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{required}</p></div>{about.trim()&&<div className="border-t border-border/50 pt-5"><h4 className={heading}>About you</h4><p className="whitespace-pre-wrap text-sm leading-7">{about.trim()}</p></div>}<div className="border-t border-border/50 pt-5"><h4 className={heading}>These instructions</h4><p className="whitespace-pre-wrap text-sm leading-7">{text||'No instructions added yet.'}</p></div></div>;
}
function InstructionTools({catalog,error,selected,onChange}:{catalog?:{servers:ManagedServer[];tools:ManagedTool[]};error:string;selected:string[]|null;onChange:(tools:string[]|null)=>void}) {
 const available=(tool:ManagedTool)=>tool.policy!=='blocked'&&!!catalog?.servers.find(s=>s.id===tool.server_id)?.enabled;
 return <div className={`${panel} space-y-4 p-5`}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-1" role="group" aria-label="Tool access">{[{label:'All available tools',all:true},{label:'Only selected',all:false}].map(item=><button key={item.label} type="button" aria-pressed={item.all?selected===null:selected!==null} onClick={()=>{if(item.all!== (selected===null))onChange(item.all?null:[]);}} className={`rounded-full px-3 py-2 text-xs font-medium ${item.all===(selected===null)?'bg-muted text-foreground':'text-muted-foreground hover:text-foreground'}`}>{item.label}</button>)}</div><span className="text-xs text-muted-foreground">{selected===null?'All available':`${selected.length} selected`}</span></div><p className="text-xs leading-5 text-muted-foreground">Pick the tools these instructions can use. Existing permissions still apply. Select none to chat without tools.</p>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{!catalog&&!error&&<p className="text-sm text-muted-foreground">Loading tools…</p>}{catalog?.servers.map(server=>{const tools=catalog.tools.filter(t=>t.server_id===server.id);if(!tools.length)return null;return <div key={server.id}><div className="mb-2 flex items-center justify-between gap-3"><h4 className="flex items-center gap-2 text-xs font-semibold"><span className="flex size-6 items-center justify-center rounded-full bg-muted">{server.config.name.charAt(0).toUpperCase()}</span>{server.config.name}</h4>{selected!==null&&<div className="flex gap-3 text-xs text-muted-foreground"><button aria-label={`Select all ${server.config.name} tools`} onClick={()=>onChange([...new Set([...selected,...tools.filter(available).map(t=>`${t.server_id}/${t.name}`)])])}>Select all</button><button aria-label={`Clear ${server.config.name} tools`} onClick={()=>onChange(selected.filter(key=>!tools.some(t=>key===`${t.server_id}/${t.name}`)))}>None</button></div>}</div>{tools.map(t=>{const key=`${t.server_id}/${t.name}`;const enabled=available(t);return <label key={key} className="flex items-center gap-3 py-2 text-xs"><input type="checkbox" className="size-4 shrink-0 accent-success" disabled={selected===null||(!enabled&&!selected.includes(key))} checked={selected===null?enabled:selected.includes(key)} onChange={e=>{if(selected)onChange(e.target.checked?[...selected,key]:selected.filter(id=>id!==key));}}/><span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="font-medium">{toolLabel(t.name)}</span><code className="break-all text-[10px] text-muted-foreground/70">{t.name}</code></span><span className="shrink-0 text-muted-foreground">{!enabled?'Unavailable':t.policy==='ask'?'Ask':'Allowed'}</span></label>;})}</div>;})}{catalog&&!catalog.tools.length&&<p className="text-sm text-muted-foreground">No tools configured yet.</p>}</div>;
}
