import {normalizeDustThreshold} from '../../shared/crypto-dust';
export {normalizeDustThreshold,isCryptoDust} from '../../shared/crypto-dust';
import { useSyncExternalStore } from 'react';
const key='earlybird-crypto-hide-dust';
const thresholdKey='earlybird-crypto-dust-threshold';
let thresholdSession:string|undefined;
const listeners=new Set<()=>void>();
let session:boolean|undefined;
export function getHideCryptoDust():boolean {
 if(session!==undefined)return session;
 try{return localStorage.getItem(key)!=='false';}catch{return true;}
}
export function setHideCryptoDust(value:boolean):void {
 session=value;try{localStorage.setItem(key,String(value));}catch{/* Keep the session preference. */}
 for(const listener of listeners)listener();
}
export function useHideCryptoDust():boolean {
 return useSyncExternalStore(listener=>{
  listeners.add(listener);
  const storage=(event:StorageEvent)=>{if(event.key===key){session=undefined;listener();}};
  window.addEventListener('storage',storage);
  return()=>{listeners.delete(listener);window.removeEventListener('storage',storage);};
 },getHideCryptoDust);
}
export function getCryptoDustThreshold():string {
 if(thresholdSession!==undefined)return thresholdSession;
 try{return normalizeDustThreshold(localStorage.getItem(thresholdKey)??'')??'0.10';}catch{return '0.10';}
}
export function setCryptoDustThreshold(value:string):void {
 const normalized=normalizeDustThreshold(value);
 if(normalized===null)throw new Error('Enter a non-negative dollar amount with up to two decimal places.');
 thresholdSession=normalized;
 try{localStorage.setItem(thresholdKey,normalized);}catch{/* Keep the session preference. */}
 for(const listener of listeners)listener();
}
export function useCryptoDustThreshold():string {
 return useSyncExternalStore(listener=>{
  listeners.add(listener);
  const storage=(event:StorageEvent)=>{if(event.key===thresholdKey){thresholdSession=undefined;listener();}};
  window.addEventListener('storage',storage);
  return()=>{listeners.delete(listener);window.removeEventListener('storage',storage);};
 },getCryptoDustThreshold);
}
