import { documentLimits,type DocumentAttachment } from '../../../shared/chat-documents';

/** Stream small chunks through the bounded host RPC; never copy document text
 * into the message composer or render every page just to attach the file. */
export async function uploadChatPdf(file:File,takeId:string,progress:(text:string)=>void):Promise<DocumentAttachment>{
 if(!file.size||file.size>documentLimits.bytes)throw new Error('PDFs must be between 1 byte and 50 MB.');
 const header=new Uint8Array(await file.slice(0,5).arrayBuffer());
 if(new TextDecoder().decode(header)!=='%PDF-')throw new Error('This file is not a valid PDF.');
 const {id}=await window.takes.document('begin',{takeId,name:file.name.slice(0,200),bytes:file.size}) as {id:string};
 try{
  for(let offset=0,ordinal=0;offset<file.size;offset+=documentLimits.chunkBytes,ordinal++){
   const blob=file.slice(offset,offset+documentLimits.chunkBytes);
   const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read PDF.'));reader.readAsDataURL(blob);});
   await window.takes.document('chunk',{id,ordinal,data});
   progress(`Uploading ${file.name} · ${Math.min(100,Math.round((offset+blob.size)/file.size*100))}%`);
  }
  progress(`Indexing ${file.name}…`);
  return await window.takes.document('finish',{id}) as DocumentAttachment;
 }catch(error){await window.takes.document('discard',{id}).catch(()=>{});throw error;}
}
