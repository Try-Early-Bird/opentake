import { defaultCoinbaseSubscriptions, type CoinbaseSubscriptions } from '../../../shared/coinbase-source';
import { randomUUID } from 'node:crypto';
import type { DataLease } from '../../../shared/data-sources';
import type { createCoinbaseStreamHost } from './host';
import { createCoinbaseProtocol } from './protocol';

/** Host-owned demand from saved holdings across accounts. No credential or provider reads. */
export function createCoinbaseHoldingsStream(
 stream: Pick<ReturnType<typeof createCoinbaseStreamHost>, 'dispatch'|'dropClient'|'price'> & Partial<Pick<ReturnType<typeof createCoinbaseStreamHost>,'setHoldingAccounts'>>,
 loadProducts: () => Promise<Array<string|{product:string;account:string}>>,
 available: () => boolean,
 policy:()=>{collection:'automatic'|'when-open'|'off';subscriptions:CoinbaseSubscriptions}=()=>({collection:'automatic',subscriptions:defaultCoinbaseSubscriptions}),
) {
 const client=randomUUID(), leases=new Map<string,string>(), usages=new Map<string,string>();
 let timer:ReturnType<typeof setInterval>|undefined, closed=false, running=false, generation=0, policyKey='';
 function clear(){stream.setHoldingAccounts?.([]);generation++;leases.clear();usages.clear();stream.dropClient(client);}
 async function tick(){
  if(closed||running)return;
  if(!available()){clear();return;}
  running=true;const epoch=generation;
  try{
   const settings=policy();
   const nextKey=JSON.stringify(settings);
   if(policyKey!==nextKey){for(const id of leases.values())stream.dispatch({action:'release',ids:[id]},client);leases.clear();usages.clear();policyKey=nextKey;}
   const discovered=settings.collection==='automatic'&&settings.subscriptions.holdings?await loadProducts():[];
   const manual=settings.collection==='automatic'?settings.subscriptions.products:[];
   const products=[...new Set([...discovered.map(item=>typeof item==='string'?item:item.product),...manual])].sort();
   if(closed||epoch!==generation||!available()){clear();return;}
   stream.setHoldingAccounts?.(discovered.flatMap(item=>typeof item==='string'?[]:[item]));
   const wanted=new Set(products.filter(product=>{if(product==='USD-USD'||product==='USDC-USD'&&!manual.includes(product))return false;try{createCoinbaseProtocol([product]);return true;}catch{return false;}}));
   const usage=(product:string)=>discovered.some(item=>(typeof item==='string'?item:item.product)===product)?'holdings':'manual';
   for(const [product,id] of leases)if(!wanted.has(product)||usages.get(product)!==usage(product)){stream.dispatch({action:'release',ids:[id]},client);leases.delete(product);usages.delete(product);}
   const renewed:DataLease[]=[];const existing=[...leases.values()];
   for(let i=0;i<existing.length;i+=32)renewed.push(...stream.dispatch({action:'renew',ids:existing.slice(i,i+32)},client) as DataLease[]);
   const active=new Set(renewed.map(item=>item.leaseId));
   for(const [product,id] of leases)if(!active.has(id)){leases.delete(product);usages.delete(product);}
   for(const product of wanted)if(!leases.has(product)){
    try {const lease=stream.dispatch({action:'acquire',product,mode:'prices',usage:usage(product)},client,true) as DataLease;leases.set(product,lease.leaseId);usages.set(product,usage(product));}
    catch { /* Unsupported, suspended or at capacity: preserve fetched valuation. */ }
   }
  }catch{clear();}finally{running=false;}
 }
 return {
  start(){if(closed||timer)return;void tick();timer=setInterval(()=>void tick(),5000);},
  tick,
  invalidate:clear,
  price(product:string){return !closed&&available()&&leases.has(product)?stream.price(product):null;},
  close(){closed=true;if(timer)clearInterval(timer);timer=undefined;clear();},
 };
}
