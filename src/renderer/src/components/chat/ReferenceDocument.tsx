import { useEffect,useState } from 'react';
import { Dialog,DialogContent,DialogTitle,DialogDescription } from '../ui/dialog';
import type { DocumentAttachment,DocumentPage } from '../../../../shared/chat-documents';
/** "2.7 MB", or "891 KB" under a megabyte. */
export const fileSize=(bytes:number)=>bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${Math.ceil(bytes/1024)} KB`;
export function ReferenceDocument({document:doc,onRemove}:{document:DocumentAttachment;onRemove?:()=>void}){
 const [open,setOpen]=useState(false),[page,setPage]=useState(1),[visual,setVisual]=useState(false);
 const [text,setText]=useState<DocumentPage>(),[image,setImage]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false),[offset,setOffset]=useState(0);
 useEffect(()=>{
  if(!open)return;let active=true;setLoading(true);setError('');setImage('');setText(undefined);
  void window.takes.document(visual?'image':'page',{id:doc.id,page,offset}).then(result=>{if(active){if(visual)setImage((result as {image:string}).image);else setText(result as DocumentPage);}}).catch(error=>{if(active)setError(error.message);}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[doc.id,page,open,visual,offset]);
 return <><div className="flex max-w-full items-center gap-2.5 rounded-lg border border-border bg-muted/40 py-1.5 pl-1.5 pr-3 text-sm">
 <span aria-hidden="true" className="grid h-8 w-7 shrink-0 place-items-center rounded bg-muted text-[9px] font-semibold text-muted-foreground">PDF</span>
 <button type="button" className="min-w-0 text-left" aria-label={`Preview ${doc.name}`} onClick={()=>setOpen(true)}><span className="block max-w-60 truncate font-medium">{doc.name}</span><span className="block text-[11px] text-muted-foreground">{doc.pages} pages · {fileSize(doc.bytes)}{doc.scannedPages?<> · <span className="text-attention">{doc.scannedPages} scanned {doc.scannedPages===1?'page':'pages'}</span></>:null}</span></button>
 {onRemove&&<button type="button" aria-label={`Remove ${doc.name}`} className="ml-1 text-muted-foreground hover:text-foreground" onClick={onRemove}>×</button>}</div>
 <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-4xl"><DialogTitle>{doc.name}</DialogTitle><DialogDescription>The original PDF is stored locally. The AI reads relevant pages when needed.</DialogDescription>
 <div className="flex flex-wrap items-center gap-3 text-sm"><label>Page <input aria-label="PDF page" type="number" min={1} max={doc.pages} value={page} className="w-20 rounded border bg-background p-1" onChange={e=>{const value=Number(e.target.value);if(Number.isInteger(value)&&value>=1&&value<=doc.pages){setPage(value);setOffset(0);}}}/></label><span>of {doc.pages}</span><button type="button" onClick={()=>{setVisual(v=>!v);setOffset(0);}}>{visual?'Show text':'Show page image'}</button></div>
 {loading&&<p role="status">Loading page…</p>}{error&&<p role="alert">{error}</p>}
 <div className="max-h-[65vh] overflow-auto">{image?<img src={`data:image/jpeg;base64,${image}`} alt={`${doc.name}, page ${page}`}/>:text&&<pre className="whitespace-pre-wrap text-sm">{text.text||'No extractable text on this page. Use Show page image to inspect it.'}</pre>}</div>
 {text?.nextOffset!==null&&text?.nextOffset!==undefined&&<button type="button" onClick={()=>setOffset(text.nextOffset!)}>Next text section</button>}
 {offset>0&&<button type="button" onClick={()=>setOffset(0)}>Back to start of page</button>}
 </DialogContent></Dialog></>;
}
