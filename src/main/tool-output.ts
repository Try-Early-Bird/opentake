/** Keep binary page images out of persisted replay text. The model can reread
 * their document/page identifiers instead of replaying base64 as text tokens. */
export function replayToolContent(value:unknown):string {
 if(typeof value==='string')return value;
 return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&item.type==='image'
  ?{type:'text',text:'[Page image omitted from replay. Request the same document/page again if needed.]'}:item);
}
/** Audit records keep tool results without page-image payloads, matching replay. */
export const auditToolResult=(value:unknown):unknown=>typeof value==='string'?value:JSON.parse(replayToolContent(value));
export function codexToolOutput(result:{content?:unknown;isError?:boolean}){
 const contentItems:({type:'inputText';text:string}|{type:'inputImage';imageUrl:string})[]=[
  {type:'inputText',text:replayToolContent(result)},
 ];
 if(Array.isArray(result.content))for(const item of result.content){
  if(item?.type==='image'&&/^image\/(png|jpeg|webp)$/.test(item.mimeType)&&typeof item.data==='string'&&item.data.length<=2*1024*1024&&/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)){
   contentItems.push({type:'inputImage',imageUrl:`data:${item.mimeType};base64,${item.data}`});
  }
 }
 return contentItems;
}
