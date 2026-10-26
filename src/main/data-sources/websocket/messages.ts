import type { WebsocketMessage, WebsocketMessages } from '../../../shared/websocket-sources';
/** Volatile source/revision journal. Never stores login/ack frames or credentials.
 * Serialized byte cap also bounds IPC responses, even for heavily escaped text. */
export function createWebsocketMessages() {
 let sequence=0;
 const journals=new Map<string,{rows:WebsocketMessage[];bytes:number;total:number;started:number;sequence:number}>();
 const key=(id:string,revision:number)=>`${id}:${revision}`;
 return {
  add(id:string,revision:number,type:WebsocketMessage['type'],text:string) {
   const k=key(id,revision);let journal=journals.get(k);
   if(!journal){if(journals.size>=20)journals.delete(journals.keys().next().value!);journal={rows:[],bytes:0,total:0,started:Date.now(),sequence:0};journals.set(k,journal);}
   if(type==='open'){journal.total=0;journal.started=Date.now();}
   if(type==='json'||type==='text'||type==='notice')journal.total++;
   journal.sequence=++sequence;
   const row={id:journal.sequence,receivedAt:Date.now(),type,text,bytes:Buffer.byteLength(text)};
   const bytes=Buffer.byteLength(JSON.stringify(row));if(bytes>512*1024)return;
   journal.rows.push(row);journal.bytes+=bytes;
   while(journal.rows.length>200||journal.bytes>512*1024)journal.bytes-=Buffer.byteLength(JSON.stringify(journal.rows.shift()));
  },
  read(id:string,revision:number,after=0):WebsocketMessages {
   const j=journals.get(key(id,revision));return {messages:structuredClone(j?.rows.filter(row=>row.id>after)??[]),cursor:j?.sequence??0,total:j?.total??0,startedAt:j?.started??null};
  },
  clear(){journals.clear();},
 };
}
