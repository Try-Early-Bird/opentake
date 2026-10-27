import type { ReasoningEffort } from '../../../shared/ai-models';
import { availableChatSelection } from '../../../shared/chat-selection';
import { TakeLoading } from '../components/TakeLoading';
import { registerSearchNavigationGuard } from '../search-state';
import { isPdfFile, documentLimits, type DocumentAttachment } from '../../../shared/chat-documents';
import { ReferenceDocument } from '../components/chat/ReferenceDocument';
import { chatLimits } from '../../../shared/chat-limits';
import { appendChatFileText, chatTextFilePattern, readChatTextFiles } from '../../../shared/chat-file-input';
import { BasketPanel } from '../strategies/BasketPanel';
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from '../components/ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip';
import { mergeMessages,reconcileTake } from '../../../shared/take-snapshots';
import { ToastProvider, useToasts } from '../components/ui/toast';
import { Approvals } from '../components/chat/Approvals';
import type { ModelProvider, ModelResult } from '../../../shared/ai-models';
import type { AiConnectionState } from '../../../shared/ai-connections';
import type { ImageAttachment, InstructionProfile, Take, TakeSummary, TakeSnapshot } from '../../../shared/takes';
import { visibleMessages } from '../../../shared/takes';
import { Select } from '../components/ui/select';
import { checkAiConnections } from '../ai-connection-status';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TakeTools } from '../components/TakeTools';
import { StatusDot } from '../components/chat/StatusDot';
import { partOfDay } from '../lib/part-of-day';
import { ArrowDown, ArrowUp, ArrowUpRight, Plus, Square, PanelLeft, Paperclip, ChevronLeft, FileText, FileDown, Shield, FilePenLine, ChartPie, Wallet, Archive, ArchiveRestore, Trash2, LoaderCircle, Wrench } from 'lucide-react';
import { Link, useSearch, useNavigate } from '@tanstack/react-router';
import { AiPicker, providerLabels } from '../components/chat/AiPicker';
import { AiConnectDialog } from '../components/AiConnectDialog';
import { Conversation } from '../components/chat/Conversation';
import { ReferenceImage } from '../components/chat/ReferenceImage';
const starters=['US manufacturing is coming home','AI will reshape how we work','Nuclear power will fuel the next decade'];
function TakeHistoryItem({ take, selected, working, onSelect }: { take: TakeSummary; selected: boolean; working: boolean; onSelect: () => void }) {
 const status = take.strategy ? take.strategy.invested ? 'Invested' : take.strategy.status === 'committed' ? 'Live' : 'Draft' : null;
 const Icon = status === 'Invested' ? Wallet : status === 'Live' ? ChartPie : FilePenLine;
 const description = status === 'Invested' ? 'Invested · Active, paused, or diverged allocation' : status === 'Live' ? 'Live · Committed version' : 'Draft · Not yet committed';
 const activityLabel = [working ? 'Working…' : null, status].filter(Boolean).join(' · ');
 const button = <button type="button" onClick={onSelect} aria-current={selected ? 'page' : undefined} aria-label={activityLabel ? `${take.title} — ${activityLabel}` : undefined} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'bg-muted' : ''}`}>
  <span className="min-w-0 flex-1 truncate">{take.title}</span>
  {working && <LoaderCircle size={15} className="shrink-0 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden="true" />}
  {status && <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
 </button>;
 return status || working ? <Tooltip><TooltipTrigger render={button} /><TooltipContent side="right">{working?`Working…${status?` · ${description}`:''}`:description}</TooltipContent></Tooltip> : button;
}
/** Re-read each minute, so a home screen left open greets the new part of day. */
function usePartOfDay() {
 const [part, setPart] = useState(() => partOfDay(new Date().getHours()));
 useEffect(() => { const timer = setInterval(() => setPart(partOfDay(new Date().getHours())), 60_000); return () => clearInterval(timer); }, []);
 return part;
}
export function Home() { return <ToastProvider><HomeContent/></ToastProvider>; }
function HomeContent() {
 const [historyOpen,setHistoryOpen]=useState(false);
 const [toolsOpen,setToolsOpen]=useState(false);
 const navigate = useNavigate();
 const requestedTake = useSearch({ from: '/', select: search => search.takeId });
 const notifications=useToasts();
 const [error,setError]=useState('');

 const [instructionProfiles,setInstructionProfiles]=useState<InstructionProfile[]>([]);const [instructionProfileId,setInstructionProfileId]=useState<string|null>(null);
 useEffect(()=>{let active=true;const load=()=>void window.takes.instructionProfiles().then(value=>{if(active)setInstructionProfiles(value);}).catch(()=>{if(active)setError('Could not load instruction sets.');});load();window.addEventListener('focus',load);return()=>{active=false;window.removeEventListener('focus',load);};},[]);
 const [effort,setEffort]=useState<ReasoningEffort>();const [model,setModel]=useState('');const [provider,setProvider]=useState<ModelProvider>('claude');const [connections,setConnections]=useState<AiConnectionState[]>([]);
 const [catalogs,setCatalogs]=useState<Partial<Record<ModelProvider,ModelResult>>>({});const [connectTarget,setConnectTarget]=useState<ModelProvider>();const [refreshModels,setRefreshModels]=useState(0);
 const connected=connections.some(c=>c.provider===provider&&c.status==='connected');
 const connectedProviders=connections.filter(c=>c.status==='connected').map(c=>c.provider).sort().join(',');
 const catalog=catalogs[provider];const loadingModels=connected&&!catalog;
 const selectedLabel=providerLabels[provider];
 const [takes,setTakes]=useState<TakeSummary[]>([]);const [take,setTake]=useState<Take|null>(null);const [selected,setSelected]=useState<string|null>(requestedTake??null);const [archived,setArchived]=useState(false);
 const [editTarget,setEditTarget]=useState<HTMLDivElement|null>(null);
 const [basketTarget,setBasketTarget]=useState<string|null>(selected);
 const reviewBasket=useCallback((id:string)=>{setBasketTarget(id);},[]);
 useEffect(()=>{setBasketTarget(selected);},[selected]);
 const [activeTakeIds,setActiveTakeIds]=useState<string[]>([]);
 const [loadFailed,setLoadFailed]=useState(false);
 const [draft,setDraft]=useState('');const [images,setImages]=useState<ImageAttachment[]>([]);const [busy,setBusy]=useState(false);const [running,setRunning]=useState(false);const [uploading,setUploading]=useState(false);const [ready,setReady]=useState(false);const [away,setAway]=useState(false);
 const [documents,setDocuments]=useState<DocumentAttachment[]>([]);const [uploadProgress,setUploadProgress]=useState('');
 const draftRef=useRef(draft);draftRef.current=draft;
 // The composer prompt an "other" reply button sets; cleared on send or when the take changes.
 const [hint,setHint]=useState<string>();useEffect(()=>setHint(undefined),[selected]);const composer=useRef<HTMLDivElement>(null);const input=useRef<HTMLTextAreaElement>(null);const picker=useRef<HTMLInputElement>(null);const bottom=useRef<HTMLDivElement>(null);const scroller=useRef<HTMLDivElement>(null);const current=useRef(selected);current.current=selected;
 const [messagesNext,setMessagesNext]=useState<string|null>(null),[takesNext,setTakesNext]=useState<string|null>(null),[loadingEarlier,setLoadingEarlier]=useState(false),[loadingTakes,setLoadingTakes]=useState(false);
 const takeRef=useRef(take);takeRef.current=take;const archiveRef=useRef(archived);archiveRef.current=archived;const anchor=useRef<{id:string;top:number;added:string}>();
 const revision=useRef('');const draftDirty=useRef(false);const restored=useRef<string|null>(null);const draftSave=useRef<ReturnType<typeof setTimeout>>();
 function applySnapshot(result:TakeSnapshot){
  const incoming=result.revision.split(':'),known=revision.current.split(':');if(incoming[0]===known[0]&&Number(incoming[1])<Number(known[1]))return;
  const previous=revision.current&&revision.current.split(':')[0]!==result.revision.split(':')[0]?null:takeRef.current;const next=reconcileTake(previous,result.take,result.mode);if(previous?.id!==next?.id||previous?.headId!==next?.headId)anchor.current=undefined;takeRef.current=next;setTake(old=>reconcileTake(previous?old:null,result.take,result.mode));
  if(result.mode!=='merge'&&(previous?.id!==next?.id||previous?.headId!==next?.headId||!previous?.messages.length))setMessagesNext(result.messagesNext??null);
  setTakes(old=>result.mode==='merge'?[...result.takes,...old.filter(t=>!result.takes.some(n=>n.id===t.id))]:result.takes);
  if(result.mode!=='merge')setTakesNext(result.takesNext??null);
  setRunning(result.running);setActiveTakeIds(result.activeTakeIds??(result.activeTakeId?[result.activeTakeId]:[]));revision.current=result.revision;
 }
 async function earlier(){const prior=takeRef.current;if(!prior||!messagesNext||loadingEarlier)return;const hostEpoch=revision.current.split(':')[0];setError('');setLoadingEarlier(true);try{const page=await window.takes.messagesPage(prior.id,messagesNext);if(current.current!==prior.id||takeRef.current?.headId!==prior.headId||revision.current.split(':')[0]!==hostEpoch)return;const oldest=visibleMessages(prior)[0];const el=oldest?scroller.current?.querySelector(`[data-message-id="${oldest.id}"]`):null;if(el&&page.messages.length)anchor.current={id:oldest.id,top:el.getBoundingClientRect().top,added:page.messages[0].id};setTake(old=>old&&old.id===prior.id&&old.headId===prior.headId?{...old,messages:mergeMessages(page.messages,old.messages)}:old);setMessagesNext(page.next);}catch(e){if(current.current!==prior.id)return;setError(e instanceof Error?e.message:'Could not load earlier messages.');if(e instanceof Error&&/cursor|branch changed/.test(e.message)){try{const fresh=await window.takes.snapshot(prior.id,archiveRef.current);if(current.current===prior.id&&fresh){takeRef.current=null;applySnapshot(fresh);}}catch{}}}finally{setLoadingEarlier(false);}}
 async function olderTakes(){if(!takesNext||loadingTakes)return;const mode=archived,hostEpoch=revision.current.split(':')[0];setLoadingTakes(true);try{const page=await window.takes.takesPage(mode,takesNext);if(archiveRef.current!==mode||revision.current.split(':')[0]!==hostEpoch)return;notifications.recover('take-pages');setTakes(old=>[...old,...page.items.filter(t=>!old.some(o=>o.id===t.id))]);setTakesNext(page.next);}catch{if(archiveRef.current!==mode)return;notifications.error('take-pages','Could not load older takes. Refreshing the list so you can retry.');try{await refresh();}catch{}}finally{setLoadingTakes(false);}}
 function restoreAnchor(){const a=anchor.current,el=scroller.current;if(!a||!el||!el.querySelector(`[data-message-id="${a.added}"]`))return;const row=el.querySelector(`[data-message-id="${a.id}"]`);if(row)el.scrollTop+=row.getBoundingClientRect().top-a.top;anchor.current=undefined;}
 useLayoutEffect(()=>{const el=scroller.current;if(!el)return;const observer=new MutationObserver(restoreAnchor);observer.observe(el,{childList:true,subtree:true});return()=>observer.disconnect();},[]);
 useLayoutEffect(restoreAnchor,[take?.messages.length]);
 const refresh=async()=>{const id=current.current;const result=await window.takes.snapshot(id,archived);if(result&&current.current===id&&archiveRef.current===archived){applySnapshot(result);}};
 useEffect(()=>{let active=true;let timer:ReturnType<typeof setTimeout>;revision.current='';const poll=async()=>{try{const value=await window.takes.snapshot(selected,archived,revision.current);if(active&&value){applySnapshot(value);if(value.take&&restored.current!==value.take.id){restored.current=value.take.id;setDraft(value.take.draft);setImages(value.take.draftImages);setDocuments(value.take.draftDocuments??[]);setProvider(value.take.selection.provider);setModel(value.take.selection.model);setEffort(value.take.selection.effort);setInstructionProfileId(value.take.instructionProfileId??null);}}if(active){setReady(true);setLoadFailed(false);notifications.recover('takes-poll');}}catch{if(active){setLoadFailed(true);notifications.error('takes-poll','Could not load takes. Retrying…',true);}}if(active)timer=setTimeout(poll,400);};void poll();return()=>{active=false;clearTimeout(timer);};},[selected,archived,notifications]);
 useEffect(()=>{let active=true;const check=()=>void checkAiConnections(window.aiConnections).then(r=>{if(active)setConnections(r.ok?r.states:[]);});check();const t=setInterval(check,5000);return()=>{active=false;clearInterval(t);};},[]);
 useEffect(()=>{let active=true;setCatalogs({});for(const id of connectedProviders.split(',').filter(Boolean) as ModelProvider[]){void window.chat.models(id,refreshModels>0).catch(():ModelResult=>({ok:false,message:'Could not load models. Refresh to retry.'})).then(result=>{if(active)setCatalogs(old=>({...old,[id]:result}));});}return()=>{active=false;};},[connectedProviders,refreshModels]);
 useEffect(()=>{if(running)return;const next=availableChatSelection({provider,model,effort},connections,catalogs);if(next){setProvider(next.provider);setModel(next.model);setEffort(next.effort);}},[provider,model,effort,connections,catalogs,running]);
 useEffect(()=>{if(uploading||!draftDirty.current||!selected)return;clearTimeout(draftSave.current);draftSave.current=setTimeout(()=>{void window.takes.update(selected,{draft,draftImages:images.map(i=>i.id),draftDocuments:documents.map(d=>d.id)}).then(()=>{draftDirty.current=false;}).catch(()=>setError('Draft could not be saved.'));},350);return()=>clearTimeout(draftSave.current);},[draft,images,documents,selected,uploading]);
 useEffect(()=>{if(catalog&&!catalog.ok&&connected)notifications.error('chat-models',catalog.message,true);else notifications.recover('chat-models');},[catalog,connected,notifications]);
 const messages=take?visibleMessages(take):[];
 useEffect(()=>{if(!away&&!anchor.current)bottom.current?.scrollIntoView({block:'nearest'});},[messages.at(-1)?.text,away]);
 const saveDraft=async()=>{clearTimeout(draftSave.current);if(selected&&draftDirty.current){await window.takes.update(selected,{draft,draftImages:images.map(i=>i.id),draftDocuments:documents.map(d=>d.id)});draftDirty.current=false;}};
 async function select(id:string|null){try{await saveDraft();restored.current=null;setHistoryOpen(false);current.current=id;takeRef.current=null;setTake(null);setSelected(id);setRunning(id!==null&&activeTakeIds.includes(id));setInstructionProfileId(null);setDraft('');setImages([]);setDocuments([]);setError('');setAway(false);await navigate({to:'/',search:{takeId:id??undefined},replace:true});}catch{setError('Save the current draft before switching takes.');}}
 useEffect(()=>{if(requestedTake && requestedTake!==current.current)void select(requestedTake);},[requestedTake]);
 useEffect(() => registerSearchNavigationGuard(async () => {
  if (busy || uploading) throw new Error('Wait for the current edit to finish.');
  if (!draftDirty.current) return;
  const text = draftRef.current;
  const attachments = images.map(image => image.id);
  const id = current.current ?? await ensureTake();
  clearTimeout(draftSave.current);
  await window.takes.update(id, { draft: text, draftImages: attachments, draftDocuments:documents.map(d=>d.id) });
  draftDirty.current = false;
 }));
 async function ensureTake(){if(current.current)return current.current;const id=await window.takes.create();restored.current=id;current.current=id;setSelected(id);return id;}
 async function send(text=draft,parent=take?.headId??null,ids=images.map(i=>i.id),regenerate=false,documentIds=documents.map(d=>d.id),keepDraft=false){if(busy||running||uploading||!connected||loadingModels||!model)return;if(!regenerate&&!text.trim()&&!ids.length&&!documentIds.length)return;setBusy(true);setError('');setHint(undefined);try{const id=await ensureTake();clearTimeout(draftSave.current);await window.takes.send({requestId:crypto.randomUUID(),takeId:id,parentId:parent,text,images:ids,documents:documentIds,selection:{provider,model,...(effort?{effort}:{})},instructionProfileId,regenerate,keepDraft});if(!keepDraft){draftDirty.current=false;setDraft('');setImages([]);setDocuments([]);}setAway(false);await refresh();}catch(e){setError(e instanceof Error?e.message:'Could not send message.');throw e;}finally{setBusy(false);}}
 const canAttach=catalog?.ok&&catalog.models.find(m=>m.value===model)?.imageInput===true;
 async function attach(files:File[]){
  if(uploading||busy||running||!files.length)return;
  const origin=current.current;
  setUploading(true);setUploadProgress('Preparing attachments…');setError('');
  const addedDocuments:DocumentAttachment[]=[];
  try{
   const pdfFiles=files.filter(isPdfFile);
   const textFiles=files.filter(f=>!isPdfFile(f)&&chatTextFilePattern.test(f.name));
   const imageFiles=files.filter(f=>!isPdfFile(f)&&!chatTextFilePattern.test(f.name));
   if(imageFiles.some(f=>!['image/png','image/jpeg','image/webp'].includes(f.type)))throw new Error('Use PDF, PNG, JPEG, WebP, CSV, TSV, TXT, Markdown, or JSON files.');
   if(imageFiles.length&&!canAttach)throw new Error('Image support is not verified for this model. PDFs are supported separately.');
   if(images.length+imageFiles.length>chatLimits.imagesPerMessage)throw new Error('Attach up to eight images per message.');
   if(imageFiles.some(f=>f.size>2*1024*1024))throw new Error('Images must be 2 MB or smaller.');
   const pending:{name:string;base64:string}[]=[];
   let text=await readChatTextFiles(textFiles);
   // Validate the combined text before any upload, so an over-limit batch
   // never leaves PDFs or page images behind.
   appendChatFileText(draftRef.current,text);
   if(!pdfFiles.length&&!imageFiles.length){
    // Text-only files edit the local draft; they do not create a take.
    if(text){const next=appendChatFileText(draftRef.current,text);draftDirty.current=true;draftRef.current=next;setDraft(next);}
    return;
   }
   if(documents.length+pdfFiles.length>documentLimits.attachments)throw new Error('Attach up to ten PDFs per message.');
   if(pdfFiles.some(file=>file.size>documentLimits.bytes))throw new Error('PDFs must be 50 MB or smaller.');
   if(current.current!==origin)throw new Error('The chat changed. Attach the files again in the intended chat.');
   const id=await ensureTake();
   for(const file of pdfFiles){
    const {uploadChatPdf}=await import('../lib/pdf-input');
    addedDocuments.push(await uploadChatPdf(file,id,setUploadProgress));
    if(current.current!==id)throw new Error('The chat changed. Attach the files again in the intended chat.');
   }
   for(const file of imageFiles){
    const base64=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('Could not read image'));r.readAsDataURL(file);});
    pending.push({name:file.name,base64});
   }
   if(current.current!==id)throw new Error('The chat changed. Attach the files again in the intended chat.');
   const added:ImageAttachment[]=[];
   for(const image of pending)added.push(await window.takes.upload(id,image.name,image.base64));
   if(current.current!==id)throw new Error('The chat changed. Attach the files again in the intended chat.');
   const next=appendChatFileText(draftRef.current,text);
   clearTimeout(draftSave.current);
   await window.takes.update(id,{draft:next,draftImages:[...images,...added].map(image=>image.id),draftDocuments:[...documents,...addedDocuments].map(doc=>doc.id)});
   if(current.current!==id)return;
   draftDirty.current=false;draftRef.current=next;setDraft(next);
   if(added.length)setImages(old=>[...old,...added]);
   if(addedDocuments.length)setDocuments(old=>[...old,...addedDocuments]);
  }catch(e){for(const doc of addedDocuments)await window.takes.document('discard',{id:doc.id}).catch(()=>{});setError(e instanceof Error?e.message:'Could not attach files.');}finally{setUploading(false);}
 }

 const historyContent=<> <button onClick={()=>{setArchived(false);void select(null);}} className="flex items-center gap-2 rounded-lg bg-muted px-3 py-3 text-sm font-medium"><Plus size={17}/>New Take</button>
 {archived&&<div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><button type="button" aria-label="Back to takes" title="Back to takes" onClick={()=>setArchived(false)} className="rounded p-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronLeft size={16} aria-hidden="true"/></button><span>Archived</span></div>}
 <nav aria-label={archived?'Archived':'Takes'} className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">{!ready&&<TakeLoading failed={loadFailed}/>} {takes.map(t=><TakeHistoryItem key={t.id} take={t} selected={selected===t.id} working={activeTakeIds.includes(t.id)} onSelect={()=>void select(t.id)}/>)}{takesNext&&<button type="button" disabled={loadingTakes} onClick={()=>void olderTakes()} className="w-full py-2 text-xs text-muted-foreground">{loadingTakes?'Loading takes…':'Load older takes'}</button>}</nav>
 <div className="mt-4 flex flex-col items-start gap-3 text-sm text-muted-foreground">
 <button type="button" onClick={()=>setArchived(true)} aria-current={archived?'page':undefined} className={`hover:text-foreground ${archived?'text-foreground':''}`}>Archived</button>
 <button type="button" onClick={()=>void window.takes.importFile().then(r=>{if(r.status==='imported'){setArchived(false);void select(r.takeId);}}).catch(e=>setError(e instanceof Error?e.message:'Could not import this take.'))} className="hover:text-foreground">Import take…</button>
 <Link to="/settings" search={{section:'connections'}} className="hover:text-foreground">Manage connections ↗</Link></div></>;
 const part=usePartOfDay();
 return <div className="flex h-[calc(100dvh-76px)] min-h-0 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-ring">
 <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{running?'AI response in progress.':messages.at(-1)?.role==='assistant'?`Response ${messages.at(-1)?.state}.`: ''}</p>
 <aside aria-label="Take history" className="hidden w-60 shrink-0 flex-col border-r border-border bg-muted/20 p-4 xl:flex">
{historyContent}</aside>
 <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
 <div className="flex min-h-0 min-w-0 flex-1 flex-col">
 <div className="flex items-center justify-between px-6 pt-2 xl:hidden"><Dialog open={historyOpen} onOpenChange={setHistoryOpen}><DialogTrigger aria-label="Open take history" className="rounded p-2"><PanelLeft size={20} aria-hidden="true"/></DialogTrigger><DialogContent className="flex h-[min(36rem,calc(100dvh-2rem))] flex-col"><DialogTitle>Take history</DialogTitle>{historyContent}</DialogContent></Dialog><button aria-label="New Take" className="rounded p-2" onClick={()=>{setArchived(false);void select(null);}}><Plus size={20} aria-hidden="true"/></button></div>
 {take&&<div className="flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground"><input aria-label="Take title" key={take.id} defaultValue={take.title} className="min-w-0 flex-1 bg-transparent text-sm text-foreground" maxLength={120} onBlur={e=>{if(e.target.value.trim()&&e.target.value!==take.title)void window.takes.update(take.id,{title:e.target.value}).then(refresh).catch(()=>setError('Could not rename take.'));}}/><div ref={setEditTarget} className="shrink-0"/>
 <div className="ml-auto flex shrink-0 items-center gap-1">{activeTakeIds.includes(take.id)&&<Tooltip><TooltipTrigger render={<span tabIndex={0} role="img" aria-label="Agent working" className="rounded p-2"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true"/></span>}/><TooltipContent>Working…</TooltipContent></Tooltip>}<Tooltip><TooltipTrigger render={<button type="button" aria-label="Tools & history" className="rounded p-2 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>setToolsOpen(true)}><Wrench size={16} aria-hidden="true"/></button>}/><TooltipContent>Tools & history</TooltipContent></Tooltip><TakeTools key={take.id} takeId={take.id} open={toolsOpen} onOpenChange={setToolsOpen}/><Tooltip><TooltipTrigger render={<button type="button" aria-label="Export take" className="rounded p-2 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>void window.takes.exportFile(take.id).catch(e=>setError(e instanceof Error?e.message:'Could not export this take.'))}><FileDown size={16} aria-hidden="true"/></button>}/><TooltipContent>Export take</TooltipContent></Tooltip><Tooltip><TooltipTrigger render={<button type="button" aria-label={take.archivedAt?'Unarchive take':'Archive take'} className="rounded p-2 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>void window.takes.update(take.id,{archived:!take.archivedAt}).then(()=>select(null)).catch(()=>setError('Could not update take archive status.'))}>{take.archivedAt?<ArchiveRestore size={16} aria-hidden="true"/>:<Archive size={16} aria-hidden="true"/>}</button>}/><TooltipContent>{take.archivedAt?'Unarchive take':'Archive take'}</TooltipContent></Tooltip>{!take.archiveOnly&&<Tooltip><TooltipTrigger render={<button type="button" aria-label="Delete take" className="rounded p-2 hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>{if(window.confirm('Delete this take and its attachments permanently?'))void window.takes.remove(take.id).then(()=>select(null)).catch(()=>setError('Could not delete take.'));}}><Trash2 size={16} aria-hidden="true"/></button>}/><TooltipContent>Delete take</TooltipContent></Tooltip>}</div></div>}
 <div ref={scroller} role="region" aria-label="Conversation" tabIndex={0} onScroll={e=>{const el=e.currentTarget;setAway(el.scrollHeight-el.scrollTop-el.clientHeight>100);}} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 focus-visible:outline-2 focus-visible:outline-ring md:px-10">
 {!ready&&!take?<TakeLoading failed={loadFailed}/>:take?.messages.length?<div className="mx-auto max-w-3xl py-8"><div className="mb-4">{messagesNext&&<button type="button" disabled={loadingEarlier} onClick={()=>void earlier()} className="flex w-full items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border hover:text-foreground disabled:opacity-60">{loadingEarlier?'Loading earlier messages…':'Load earlier messages'}</button>}</div><Conversation key={take.id} take={take} catalogs={catalogs} running={running} onReviewBasket={reviewBasket} onSend={send} onCompose={hint=>{setHint(hint);input.current?.focus();}} onBranch={id=>void window.takes.update(take.id,{headId:id}).then(refresh).catch(e=>setError(e.message))} onError={setError}/><div ref={bottom}/></div>:<div className="mx-auto max-w-3xl pt-12 pb-8 lg:pt-20"><p key={part} className="mb-8 text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-700 ease-out motion-reduce:animate-none">Good {part}.</p><h1 className="max-w-xl font-serif text-4xl leading-tight tracking-tight lg:text-5xl">Your money’s story starts<br className="hidden sm:block"/> with one belief.</h1><p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground">Say what you believe. Explore the companies, trends, and risks behind your take with your connected AI.</p><div className="mt-12 space-y-1"><p className="mb-4 text-xs font-medium tracking-widest text-muted-foreground uppercase">What’s your take?</p>{starters.map(text=><button key={text} onClick={()=>{setDraft(text);draftDirty.current=true;input.current?.focus();}} className="flex w-full items-center justify-between gap-4 rounded-lg py-3 text-left text-sm hover:bg-muted/50 sm:px-3">{text}<ArrowUpRight size={17}/></button>)}</div></div>}
 </div>
 {away&&<button className="flex items-center gap-1.5 self-center rounded-full border border-border bg-muted px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-muted/70" onClick={()=>{setAway(false);bottom.current?.scrollIntoView({block:'nearest'});}}><ArrowDown size={13} aria-hidden="true"/>Jump to latest</button>}
 <div className="max-h-[35dvh] shrink-0 overflow-y-auto px-6"><Approvals /></div><div className="px-6 pt-4 pb-6 md:px-10"><form onSubmit={e=>{e.preventDefault();void send().catch(()=>{});}} className="mx-auto max-w-3xl">


 {error&&<p role="alert" className="mb-3 flex items-center gap-2.5 text-sm text-destructive"><StatusDot tone="destructive"/>{error}</p>}
 <div ref={composer} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void attach(Array.from(e.dataTransfer.files));}} className="rounded-3xl border border-border bg-muted/20 p-3 shadow-sm focus-within:ring-1 focus-within:ring-ring">
 {!!documents.length&&<div className="mb-2 flex flex-wrap gap-2">{documents.map(doc=><ReferenceDocument key={doc.id} document={doc} onRemove={uploading?undefined:()=>{draftDirty.current=true;setDocuments(old=>old.filter(d=>d.id!==doc.id));}}/>)}</div>}
 {!!images.length&&<div className="mb-2 flex flex-wrap gap-2">{images.map(image=><ReferenceImage key={image.id} image={image} onRemove={uploading?undefined:()=>{draftDirty.current=true;setImages(old=>old.filter(i=>i.id!==image.id));}}/>)}</div>}
 <p id="composer-help" className="sr-only">Enter sends your message. Shift+Enter inserts a new line.</p>
 {uploading&&<p role="status" className="flex items-center gap-2.5 px-2 pb-1 text-xs text-muted-foreground"><StatusDot tone="attention"/>{uploadProgress}</p>}
 <textarea ref={input} readOnly={uploading} aria-describedby="composer-help" aria-label={`Message ${selectedLabel}`} value={draft} maxLength={12000} onChange={e=>{draftDirty.current=true;setDraft(e.target.value);}} onPaste={e=>{const files=Array.from(e.clipboardData.files);if(files.length){e.preventDefault();void attach(files);}}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send().catch(()=>{});}}} rows={2} placeholder={hint??'What do you believe? Start with a take…'} className="w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none"/>
 <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1"><div className="flex min-w-0 flex-wrap items-center gap-1.5">
 <input ref={picker} type="file" accept="application/pdf,.pdf,image/png,image/jpeg,image/webp,.csv,.tsv,.txt,.md,.json" multiple className="hidden" onChange={e=>{void attach(Array.from(e.target.files??[]));e.target.value='';}}/>
 <button type="button" aria-label="Attach files" title={canAttach?'Attach PDFs, images, or text files':'Attach PDFs or text files'} disabled={busy||running||uploading} onClick={()=>picker.current?.click()}><Paperclip size={16}/></button>
                <label htmlFor="chat-instructions" className="sr-only">AI instructions</label>
                <Select renderValue={value=><span className="flex min-w-0 items-center gap-1.5"><FileText size={12} className="shrink-0" aria-hidden="true"/><span className="truncate">{instructionProfiles.find(p=>p.id===value)?.published?.name??'General'}</span></span>} id="chat-instructions" value={instructionProfileId??'default'} disabled={busy||running} onValueChange={value=>{const id=value==='default'?null:value;setBusy(true);void (async()=>{try{if(current.current)await window.takes.update(current.current,{instructionProfileId:id});setInstructionProfileId(id);}catch{setError('Could not select instructions.');}finally{setBusy(false);}})();}} className="min-h-7 max-w-52 rounded-full border-0 bg-transparent px-2.5 py-1 text-xs hover:bg-muted [&>span:first-child]:truncate" items={[{value:'default',label:'General'},...instructionProfiles.filter(p=>p.published&&!p.builtin).map(p=>({value:p.id,label:p.published!.name}))]} header={<Link to="/settings" search={{section:'ai'}} className="text-xs text-muted-foreground hover:text-foreground">Manage instructions ↗</Link>}/>
                <label htmlFor="chat-permissions" className="sr-only">Tool approvals</label>
                <Select id="chat-permissions" renderValue={value=><span className="flex items-center gap-1.5"><Shield size={12} aria-hidden="true"/>{value==='ask'?'Ask':'Auto'}</span>} value={take?.id===selected?take.permissionMode??'auto':'auto'} disabled={!ready||busy||running||uploading||!!take?.archivedAt} onValueChange={value=>{setBusy(true);setError('');void (async()=>{try{const id=await ensureTake();await window.takes.update(id,{permissionMode:value as 'auto'|'ask'});await refresh();}catch{setError('Could not change tool approvals. Try again.');}finally{setBusy(false);}})();}} className="min-h-7 rounded-full border-0 bg-transparent px-2.5 py-1 text-xs hover:bg-muted" items={[{value:'auto',label:'Auto'},{value:'ask',label:'Ask'}]} renderItem={value=><span className="flex max-w-64 flex-col gap-1"><span>{value==='ask'?'Ask':'Auto'}</span><span className="text-xs text-muted-foreground">{value==='ask'?'Ask before every tool call in this take.':'Use saved permissions. Required approvals still apply.'}</span></span>}/>
 </div><div className="ml-auto flex min-w-0 items-center gap-2"><AiPicker anchor={composer} provider={provider} model={model} effort={effort} connections={connections} catalogs={catalogs} disabled={busy||running||uploading} onSelect={(next,value,nextEffort)=>{setProvider(next);setModel(value);setEffort(nextEffort);setError('');}} onRefresh={()=>setRefreshModels(value=>value+1)} onConnect={setConnectTarget}/>
 {running?<button type="button" aria-label="Stop response" disabled={!take} onClick={()=>{if(take)void window.takes.stop(take.id).catch(()=>setError('Could not stop response.'));}} className="rounded-full bg-foreground p-2 text-background"><Square size={16}/></button>:<button type="submit" aria-label="Send message" disabled={!ready||busy||uploading||(!draft.trim()&&!images.length&&!documents.length)||!connected||loadingModels||!model||!!take?.archivedAt} className="rounded-full bg-foreground p-2 text-background disabled:opacity-30"><ArrowUp size={18}/></button>}</div></div></div></form></div>
 </div><BasketPanel editTarget={basketTarget===take?.id?editTarget:null} key={basketTarget??'new'} takeId={basketTarget} profileId={basketTarget===take?.id?instructionProfileId:undefined} archived={basketTarget===take?.id&&!!take.archivedAt}/>
 </div><AiConnectDialog open={!!connectTarget} start={connectTarget} onClose={()=>setConnectTarget(undefined)}/></div>;
}
