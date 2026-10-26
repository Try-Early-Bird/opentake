import type {Take,TakeMessage} from './takes';
export function mergeMessages(previous:TakeMessage[],incoming:TakeMessage[]):TakeMessage[]{
 const byId=new Map(previous.map(m=>[m.id,m]));for(const m of incoming)byId.set(m.id,m);return [...byId.values()];
}
export function reconcileTake(previous:Take|null,incoming:Take|null,mode?:'replace'|'merge'):Take|null{
 if(!incoming)return null;
 if(previous?.id!==incoming.id)return incoming;
 if(mode==='merge'||previous.headId===incoming.headId)return {...incoming,messages:mergeMessages(previous.messages,incoming.messages)};
 return incoming;
}
