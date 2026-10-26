import {ZodError} from 'zod';
import {CoinbaseError} from './errors';
import {basketSchema,assertInstrumentExecution,type BasketSpec} from '../../shared/strategies';
import {coinbasePreflightRequest,type CoinbasePreflight} from '../../shared/coinbase-preflight';
import type {createDatabaseLifecycle} from '../database';
import type {CoinbaseChatScope} from '../../shared/platform-connections';
import {createCoinbaseAllocations} from './allocations';
import {amount,format,planCoinbaseOrders,productSchema,type Product} from './order-planner';
class MarketPreviewError extends Error {}
const one=10n**36n,cent=one/100n;
const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d;
/** First-purchase floor in cents, including product size/price increments. Fees are reviewed later. */
export function coinbaseMinimum(spec:BasketSpec,quote:string,products:Product[]):string {
 const weights=spec.target.weights.filter(w=>w.instrument.venue==='coinbase'),sum=BigInt(weights.reduce((n,w)=>n+w.bps,0));
 if(!sum||spec.target.cashBps>=10000)throw Error('This Take has no crypto to buy.');
 let required=0n;
 for(const weight of weights){
  if(weight.bps<=0)continue;
  const p=products.find(p=>p.product_id===`${weight.instrument.symbol}-${quote}`);if(!p)throw Error('Market unavailable.');
  const step=amount(p.base_increment),price=amount(p.price)/amount(p.price_increment)*amount(p.price_increment);
  if(price<=0n)throw Error('Market price unavailable.');
  const baseMin=ceil(amount(p.base_min_size),step)*step;
  const quoteMin=ceil(amount(p.quote_min_size)*one,price*step)*step;
  const base=baseMin>quoteMin?baseMin:quoteMin;
  const target=ceil(base*amount(p.price),one);
  const investable=ceil(target*sum,BigInt(weight.bps));
  const total=ceil(investable*10000n,BigInt(10000-spec.target.cashBps));
  if(total>required)required=total;
 }
 return format(ceil(required,cent)*cent);
}
export function createCoinbasePreflight(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,deps:{scope(id:string):Promise<CoinbaseChatScope>;product(scope:CoinbaseChatScope,id:string):Promise<unknown>},clock=()=>Date.now()) {
 const core=createCoinbaseAllocations(database,clock);
 let productQueue:Promise<void>=Promise.resolve();
 const readProduct=(scope:CoinbaseChatScope,id:string)=>{
  const result=productQueue.then(async()=>{
   // The connection is single-flight, including background account sync.
   for(let attempt=0;;attempt++){
    try{return productSchema.parse(await deps.product(scope,id));}
    catch(error){
     if(error instanceof ZodError)throw new MarketPreviewError(`Trading rules for ${id} are unavailable or buying is restricted. Retry the preview.`);
     if(error instanceof CoinbaseError&&error.code!=='busy')throw new MarketPreviewError(`Could not load ${id} market details from Coinbase. Retry the preview.`);
     if(!(error instanceof CoinbaseError)||error.code!=='busy'||attempt>=7)throw error;
     await new Promise(resolve=>setTimeout(resolve,Math.min(250*2**attempt,2000)));
    }
   }
  });
  productQueue=result.then(()=>undefined,()=>undefined);
  return result;
 };
 const cache=new Map<string,{until:number;value:Promise<Product[]>}>();
 return async(raw:unknown):Promise<CoinbasePreflight>=>{
  const input=coinbasePreflightRequest.parse(raw);
  const row=await database.use(async db=>(await db.query<{account_id:string;allocation_id:string|null;version_id:string;spec:BasketSpec}>(`SELECT a.id AS account_id,ca.id AS allocation_id,v.id AS version_id,v.spec
   FROM takes t JOIN strategies s ON s.id=t.strategy_id JOIN local_owners owner ON owner.id=s.owner_id
   JOIN strategy_versions v ON v.id=s.current_version_id AND v.source_proposal_id=s.draft_revision_id
   JOIN strategy_account_routes r ON r.strategy_id=s.id AND r.venue='coinbase'
   JOIN linked_accounts a ON a.id=r.account_id JOIN platform_connections c ON c.id=a.connection_id AND c.owner_id=s.owner_id AND c.venue='coinbase'
   JOIN coinbase_connection_details d ON d.connection_id=c.id
   LEFT JOIN coinbase_allocations ca ON ca.strategy_id=s.id AND ca.account_id=a.id
   WHERE t.id=$1 AND s.status='committed' AND s.archived_at IS NULL AND a.available AND c.status='connected' AND d.can_trade`,[input.takeId])).rows[0]);
  if(!row)throw Error('Choose a trading account for the committed Take.');
  const spec=basketSchema.parse(row.spec);assertInstrumentExecution(spec);
  const snapshot=await core.snapshot(row.account_id);
  const claims=snapshot.claims.filter(c=>c.allocationId===row.allocation_id).map(c=>({...c}));
  const symbols=[...new Set([...spec.target.weights.filter(w=>w.instrument.venue==='coinbase').map(w=>w.instrument.symbol),...claims.filter(c=>!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n).map(c=>c.asset)])];
  if(symbols.length>20)throw Error('At most 20 crypto assets can be previewed.');
  const scope=await deps.scope(row.account_id),key=JSON.stringify([row.account_id,row.version_id,scope.authority,input.quote,symbols]);
  let entry=cache.get(key);
  if(!entry||entry.until<=clock()){
   const value=(async()=>{const products:Product[]=[];for(const symbol of symbols)products.push(await readProduct(scope,`${symbol}-${input.quote}`));return products;})();
   entry={until:clock()+30000,value};cache.set(key,entry);
   if(cache.size>100)cache.delete(cache.keys().next().value!);
   void value.catch(()=>{if(cache.get(key)?.value===value)cache.delete(key);});
  }
  let products:Product[];
  try{products=await entry.value;}catch(error){
   const reason=error instanceof MarketPreviewError?error.message:error instanceof CoinbaseError&&error.code==='busy'?'Coinbase is still syncing. Try the purchase preview again.':error instanceof CoinbaseError&&['authentication','permissions','unavailable'].includes(error.code)?'Check your Coinbase connection and trading permissions, then retry.':'Could not load Coinbase prices and trading rules. Try the purchase preview again.';
   return {ok:false,amount:input.quantity,minimumAmount:null,legs:[],retainedCash:'0',reason};
  }
  const first=!claims.some(c=>!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n);
  const minimumTotal=first?amount(coinbaseMinimum(spec,input.quote,products)):null;
  const existingCash=amount(claims.find(c=>c.asset===input.quote)?.quantity??'0');
  const minimumAmount=minimumTotal===null?null:format(minimumTotal>existingCash?minimumTotal-existingCash:0n);
  const quote=claims.find(c=>c.asset===input.quote);
  if(quote)quote.quantity=format(amount(quote.quantity)+amount(input.quantity));
  else claims.push({accountId:row.account_id,allocationId:row.allocation_id??'preflight',asset:input.quote,quantity:input.quantity,reserved:'0'});
  try{
   const plan=planCoinbaseOrders(spec,input.quote,claims,products,'0',true);
   if(plan.phase==='sell')return {ok:false,amount:input.quantity,minimumAmount,legs:[],retainedCash:'0',reason:'This allocation needs sells before additional buys can be sized.'};
   const spent=plan.orders.reduce((sum,order)=>sum+amount(order.notional),0n);
   const previousValue=amount(plan.value)-amount(input.quantity);
   const favored=plan.orders.filter(order=>{
    const symbol=order.product.split('-')[0],weight=spec.target.weights.find(w=>w.instrument.symbol===symbol)?.bps??0;
    const held=amount(claims.find(c=>c.asset===symbol)?.quantity??'0');
    const price=amount(products.find(p=>p.base_currency_id===symbol)!.price);
    const target=BigInt(weight)*BigInt(10000-spec.target.cashBps)/BigInt(spec.target.weights.reduce((sum,w)=>sum+w.bps,0));
    return held*price/one*10000n<previousValue*target&&amount(order.notional)*10000n>spent*(target+100n);
   }).map(order=>order.product.split('-')[0]);
   const allocationReason=!first&&favored.length?`More goes to ${favored.join(' and ')} because ${favored.length===1?'it is':'they are'} below target weight.`:undefined;
   return {ok:plan.orders.length>0,allocationReason,existingCashUsed:format(spent>amount(input.quantity)?spent-amount(input.quantity):0n),amount:input.quantity,minimumAmount,legs:plan.orders.map(order=>({symbol:order.product.split('-')[0],notional:order.notional,weightPercent:(spec.target.weights.find(w=>w.instrument.venue==='coinbase'&&w.instrument.symbol===order.product.split('-')[0])?.bps??0)/100})),retainedCash:format(amount(plan.cash)>spent?amount(plan.cash)-spent:0n),reason:plan.orders.length?null:'Enter an amount to see what this buys.'};
  }catch(error){return {ok:false,amount:input.quantity,minimumAmount,legs:[],retainedCash:'0',reason:minimumAmount&&amount(input.quantity)<amount(minimumAmount)?null:error instanceof Error?error.message:'Could not size these orders.'};}
 };
}
