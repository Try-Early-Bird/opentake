import {mkdir,readFile,rename,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {createConnections} from '../connections';
import type {MarketDetail} from '../../shared/market-series';

// Instrument facts for the market page and holding logos. Names come from
// Robinhood `search`, fundamentals from `get_equity_fundamentals`. Logos are fetched once per ticker from Financial
// Modeling Prep's public image endpoint, validated as an image and kept in
// the profile; a miss is remembered so an unknown ticker is not re-fetched on
// every render. The renderer only ever sees a data: URL.

const TICKER=/^[A-Z][A-Z0-9.-]{0,11}$/u;
const UPSTREAM_ORIGIN='https://financialmodelingprep.com/image-stock/';
export const LOGO_MISS_TTL_MS=7*24*60*60*1_000;
const MAXIMUM_LOGO_BYTES=512*1_024;
const FACTS_TTL_MS=10*60_000;

function records(value:unknown,depth=0):Record<string,unknown>[]{
 if(depth>8||value===null||typeof value!=='object')return [];
 if(Array.isArray(value))return value.flatMap(item=>records(item,depth+1));
 const record=value as Record<string,unknown>;
 return [record,...Object.values(record).flatMap(item=>records(item,depth+1))];
}
function stringField(record:Record<string,unknown>,...fields:string[]){
 for(const field of fields){const value=record[field];if(typeof value==='string'&&value.trim().length>0)return value.trim();}
 return undefined;
}
function symbolField(record:Record<string,unknown>){
 const value=stringField(record,'symbol','ticker','chain_symbol')?.toUpperCase();
 return value!==undefined&&/^[A-Z][A-Z0-9.-]{0,15}$/u.test(value)?value:undefined;
}

const imageTypes:{contentType:string;matches:(b:Uint8Array)=>boolean}[]=[
 {contentType:'image/png',matches:b=>b.length>=8&&[0x89,0x50,0x4e,0x47].every((v,i)=>b[i]===v)},
 {contentType:'image/jpeg',matches:b=>b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff},
 {contentType:'image/webp',matches:b=>b.length>=12&&Buffer.from(b.subarray(0,4)).toString()==='RIFF'&&Buffer.from(b.subarray(8,12)).toString()==='WEBP'},
];

export function createMarketFacts(
 connections:Pick<ReturnType<typeof createConnections>,'status'|'readTool'>,
 logoDirectory:string,
 upstreamFetch:typeof fetch=fetch,
 clock=()=>Date.now(),
){
 const facts=new Map<string,{at:number;detail:MarketDetail}>();
 const logos=new Map<string,Promise<string|null>>();
 const ticker=(raw:unknown)=>{
  const symbol=typeof raw==='string'?raw.toUpperCase():'';
  if(!TICKER.test(symbol))throw new Error('Invalid symbol');
  return symbol;
 };
 async function loadLogo(symbol:string):Promise<string|null>{
  await mkdir(logoDirectory,{recursive:true,mode:0o700});
  const file=join(logoDirectory,symbol),miss=`${file}.missing`;
  const stored=await readFile(file).catch(()=>null);
  const type=stored&&imageTypes.find(t=>t.matches(stored));
  if(stored&&type)return `data:${type.contentType};base64,${stored.toString('base64')}`;
  const missed=await stat(miss).catch(()=>null);
  if(missed&&clock()-missed.mtimeMs<LOGO_MISS_TTL_MS)return null;
  let response:Response;
  try{response=await upstreamFetch(`${UPSTREAM_ORIGIN}${encodeURIComponent(symbol)}.png`,{redirect:'follow',signal:AbortSignal.timeout(10_000)});}
  catch{return null;} // Transient upstream trouble: do not remember it as a miss.
  if(response.status>=500)return null;
  const body=response.ok?new Uint8Array(await response.arrayBuffer()):new Uint8Array();
  const found=body.length<=MAXIMUM_LOGO_BYTES?imageTypes.find(t=>t.matches(body)):undefined;
  if(!found){await writeFile(miss,'').catch(()=>{});return null;}
  await writeFile(`${file}.partial`,body,{mode:0o600});await rename(`${file}.partial`,file);
  return `data:${found.contentType};base64,${Buffer.from(body).toString('base64')}`;
 }
 const fundamentalsCache=new Map<string,{at:number;record:Record<string,unknown>}>();
 async function read(name:string,args:Record<string,unknown>):Promise<{ok:true;value:unknown}|{ok:false}>{
  try{return {ok:true,value:await connections.readTool(name,args,undefined,AbortSignal.timeout(20_000))};}catch{return {ok:false};}
 }

 async function fundamentalsOf(symbols:string[]):Promise<Map<string,Record<string,unknown>>>{
  const result=new Map<string,Record<string,unknown>>();
  const missing:string[]=[];
  for(const symbol of symbols){const hit=fundamentalsCache.get(symbol);if(hit&&clock()-hit.at<FACTS_TTL_MS)result.set(symbol,hit.record);else missing.push(symbol);}
  for(let start=0;start<missing.length;start+=10){
   const batch=missing.slice(start,start+10);
   const response=await read('get_equity_fundamentals',{symbols:batch});
   if(!response.ok)continue;
   // The first record naming a symbol is its snapshot; nested blocks carry no symbol of their own.
   for(const record of records(response.value)){
    const symbol=symbolField(record);
    if(symbol===undefined||!batch.includes(symbol)||result.has(symbol))continue;
    result.set(symbol,record);fundamentalsCache.set(symbol,{at:clock(),record});
   }
  }
  while(fundamentalsCache.size>500)fundamentalsCache.delete(fundamentalsCache.keys().next().value!);
  return result;
 }
 return {
  /** The market page's name and fundamentals, from the selected connection. */
  async detail(raw:unknown):Promise<MarketDetail>{
   const symbol=ticker(raw);
   const cached=facts.get(symbol);
   if(cached&&clock()-cached.at<FACTS_TTL_MS)return cached.detail;
   if((await connections.status()).status!=='connected')return {symbol,displayName:symbol,fundamentals:null};
   const search=await read('search',{query:symbol,asset_type:'instrument',limit:5});
   const match=search.ok?records(search.value).find(r=>symbolField(r)===symbol&&stringField(r,'instrument_id','instrument_ref')):undefined;
   const loaded=await fundamentalsOf([symbol]);
   const detail={symbol,displayName:match?stringField(match,'simple_name','display_name','name')??symbol:symbol,fundamentals:loaded.get(symbol)??null};
   if(search.ok&&loaded.has(symbol)){facts.set(symbol,{at:clock(),detail});while(facts.size>200)facts.delete(facts.keys().next().value!);}
   return detail;
  },
  /** Instruments matching a query, from Robinhood `search`, for the benchmark picker. */
  async search(raw:unknown):Promise<{symbol:string;displayName:string}[]>{
   const query=typeof raw==='string'?raw.trim().slice(0,64):'';
   if(!query||(await connections.status()).status!=='connected')return [];
   const response=await read('search',{query,asset_type:'instrument',limit:10});
   if(!response.ok)return [];
   const seen=new Map<string,{symbol:string;displayName:string}>();
   for(const record of records(response.value)){
    const symbol=symbolField(record);
    if(symbol===undefined||!stringField(record,'instrument_id','instrument_ref')||seen.has(symbol))continue;
    seen.set(symbol,{symbol,displayName:stringField(record,'simple_name','display_name','name')??symbol});
   }
   return [...seen.values()];
  },
  /** Raw get_equity_fundamentals records per symbol, ten per request; symbols that fail are absent. */
  async fundamentals(raw:unknown):Promise<Map<string,Record<string,unknown>>>{
   if(!Array.isArray(raw))throw new Error('Invalid symbols');
   if((await connections.status()).status!=='connected')return new Map();
   return fundamentalsOf([...new Set(raw.map(ticker))]);
  },
  /** The ticker's issuer logo as a data: URL, or null when there is none. */
  async logo(raw:unknown):Promise<string|null>{
   const symbol=ticker(raw);
   let pending=logos.get(symbol);
   if(!pending){pending=loadLogo(symbol).catch(()=>null);logos.set(symbol,pending);void pending.then(url=>{if(url===null)logos.delete(symbol);});}
   return pending;
  },
 };
}
