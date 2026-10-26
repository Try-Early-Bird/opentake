import {executionBasket} from '../mixed-execution/basket';
import {basketSchema} from '../../shared/strategies';
import {recoverOrder} from '../trading/recovery';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from '@electric-sql/pglite';
import type { createDatabaseLifecycle } from '../database';
import { decimalToScaledInteger as units, scaledIntegerToDecimal as decimal } from '../allocations/decimal';
import { coinbaseFillMovements, previewCurrencyReservation, reconcileCurrencyClaims, type CurrencyClaim, type CurrencyBalance } from './currency-accounting';
import { walletBalance } from './history-amounts';
import type { CoinbaseHistory } from './history';
import type { CoinbaseOrder, CoinbaseFill } from './activity';
const asset=z.string().regex(/^[A-Z0-9][A-Z0-9._]{0,39}$/);
const positive=z.string().regex(/^(0|[1-9]\d{0,39})(\.\d{1,36})?$/).refine(v=>units(v,36)>0n);
const cause=z.string().min(1).max(200);
const n=(s:string)=>s.startsWith('-')?-units(s.slice(1),36):units(s,36);
const format=(v:bigint)=>v<0n?'-'+decimal(-v,36):decimal(v,36);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value)).digest('hex');
type OrderInput={quoteSized?:boolean;accountId:string;allocationId:string;product:string;side:'buy'|'sell';maxBase:string;debits:{asset:string;quantity:string}[];cause:string};
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Allocation={id:string;account_id:string;strategy_id:string;version_id:string;status:string;restore_required:boolean;created_at:Date};
type Order={quote_sized:boolean;cause:string;id:string;allocation_id:string;account_id:string;client_ref:string;product:string;side:string;max_base:string;provider_order_ref:string|null;state:string;request_hash:string;created_at:Date};

 export async function readCoinbaseClaims(tx:Pick<Transaction, 'query'>,accountId:string):Promise<CurrencyClaim[]> {
  return (await tx.query<CurrencyClaim>(`SELECT a.account_id AS "accountId",a.id AS "allocationId",e.asset,
   sum(e.quantity)::text AS quantity,coalesce((SELECT sum(r.remaining) FROM coinbase_allocation_reservations r WHERE r.allocation_id=a.id AND r.asset=e.asset),0)::text AS reserved
   FROM coinbase_allocations a JOIN coinbase_allocation_entries e ON e.allocation_id=a.id WHERE a.account_id=$1 GROUP BY a.account_id,a.id,e.asset`,[accountId])).rows;
 }
 export async function readCoinbaseBalances(tx:Pick<Transaction, 'query'>,accountId:string,clock:()=>number,maxAgeMs=60000):Promise<CurrencyBalance[]> {
  const row=(await tx.query<{checked_at:Date;data:CoinbaseHistory}>(`SELECT h.checked_at,h.data FROM coinbase_transaction_history h JOIN linked_accounts a ON a.id=h.account_id
   JOIN platform_connections c ON c.id=a.connection_id WHERE h.account_id=$1 AND h.state='complete' AND a.available AND c.status='connected'`,[accountId])).rows[0];
  if(!row||clock()-row.checked_at.getTime()>maxAgeMs||row.checked_at.getTime()>clock()||!row.data.wallets)throw new Error('Fresh complete wallet balances required');
  if((await tx.query(`SELECT 1 FROM coinbase_allocation_orders o JOIN account_orders p ON p.account_id=o.account_id AND p.provider='coinbase' AND p.data->>'clientOrderRef'=o.client_ref::text
   JOIN account_executions e ON e.account_id=p.account_id AND e.provider=p.provider AND e.order_ref=p.provider_ref
   WHERE o.account_id=$1 AND e.attribution_state<>'completed' LIMIT 1`,[accountId])).rows.length)throw new Error('Apply pending allocation fills first');
  // Do not reserve against balances which predate a known execution.
  if((await tx.query(`SELECT 1 FROM account_executions WHERE account_id=$1 AND provider='coinbase' AND occurred_at>$2 LIMIT 1`,[accountId,row.checked_at])).rows.length)throw new Error('Balances predate executions');
  const grouped=new Map<string,{total:bigint;available:bigint|null}>();
  for(const wallet of row.data.wallets){const total=walletBalance(wallet);if(total===null)throw new Error('Missing wallet amount');const old=grouped.get(wallet.asset)??{total:0n,available:0n};old.total+=total;old.available=old.available===null||wallet.available===null?null:old.available+n(wallet.available);grouped.set(wallet.asset,old);}
  return [...grouped].map(([asset,value])=>({asset,total:format(value.total),available:value.available===null?null:format(value.available)}));
 }

/** Display-only cached estimate. Mutations use balances' default freshness limit. */
export async function readCoinbaseFundingRoom(tx:Pick<Transaction, 'query'>,accountId:string,clock=()=>Date.now()) {
 return reconcileCurrencyClaims(accountId,await readCoinbaseBalances(tx,accountId,clock,Infinity),await readCoinbaseClaims(tx,accountId));
}

/** Accounting core. Member capital changes go through a persisted review; no brokerage submission. */
export function createCoinbaseAllocations(database:Database,clock=()=>Date.now()) {
 const now=()=>new Date(clock()).toISOString();
 const atomic=<T>(accountId:string,work:(tx:Transaction)=>Promise<T>)=>database.use(db=>db.transaction(async tx=>{
  z.uuid().parse(accountId);
  if(!(await tx.query(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id WHERE a.id=$1 AND c.venue='coinbase' FOR UPDATE OF a`,[accountId])).rows.length)throw new Error('Coinbase account required');
  return work(tx);
 }));
 async function allocation(tx:Transaction,accountId:string,id:string,active=true,current=true) {
  const row=(await tx.query<Allocation>('SELECT * FROM coinbase_allocations WHERE id=$1 AND account_id=$2',[id,accountId])).rows[0];
  if(!row||row.restore_required||(active&&row.status!=='active'))throw new Error('Active allocation required');
  if(active&&current&&!(await tx.query("SELECT 1 FROM strategies WHERE id=$1 AND current_version_id=$2 AND status='committed' AND archived_at IS NULL",[row.strategy_id,row.version_id])).rows.length)throw new Error('Current committed Take required');
  return row;
 }
 async function append(tx:Transaction,input:{allocationId:string;accountId:string;asset:string;quantity:string;cause:string;requestHash:string;kind:'capital'|'release'|'fill';at:string;orderId?:string;executionRef?:string}) {
  await tx.query(`INSERT INTO coinbase_allocation_entries(id,allocation_id,account_id,asset,quantity,cause,request_hash,kind,order_id,execution_ref,occurred_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),input.allocationId,input.accountId,input.asset,input.quantity,input.cause,input.requestHash,input.kind,input.orderId??null,input.executionRef??null,input.at]);
 }
 async function replay(tx:Transaction,allocationId:string,key:string,requestHash:string) {
  const rows=(await tx.query<{request_hash:string}>('SELECT request_hash FROM coinbase_allocation_entries WHERE allocation_id=$1 AND cause=$2',[allocationId,key])).rows;
  if(rows.some(r=>r.request_hash!==requestHash))throw new Error('Idempotency conflict');return rows.length>0;
 }
 async function prepare(tx:Transaction,input:OrderInput) {
   z.string().regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/).parse(input.product);z.enum(['buy','sell']).parse(input.side);positive.parse(input.maxBase);cause.parse(input.cause);
   if(input.quoteSized!==undefined){z.boolean().parse(input.quoteSized);if(input.quoteSized&&input.side!=='buy')throw Error('Only buys may be cash-sized');}
   if(!input.debits.length||input.debits.length>3||new Set(input.debits.map(d=>d.asset)).size!==input.debits.length)throw new Error('Distinct debit limits required');
   for(const debit of input.debits){asset.parse(debit.asset);positive.parse(debit.quantity);}
   const [base,quote]=input.product.split('-');if(base===quote||!input.debits.some(d=>d.asset===(input.side==='buy'?quote:base)))throw new Error('Order funding currency required');
   const requestHash=hash({...input,debits:[...input.debits].sort((a,b)=>a.asset.localeCompare(b.asset))});

    const closing=input.side==='sell'&&(await tx.query("SELECT 1 FROM coinbase_order_reviews WHERE allocation_id=$1 AND $2 LIKE 'review:'||id::text||':%' AND payload->'withdrawal'->>'close'='true' AND state IN ('preview','confirmed')",[input.allocationId,input.cause])).rows.length>0;
    await allocation(tx,input.accountId,input.allocationId,true,!closing);
    const prior=(await tx.query<Order>('SELECT * FROM coinbase_allocation_orders WHERE allocation_id=$1 AND cause=$2',[input.allocationId,input.cause])).rows[0];
    if(prior){if(prior.request_hash!==requestHash)throw new Error('Idempotency conflict');return {id:prior.id,clientRef:prior.client_ref};}
    const observed=await readCoinbaseBalances(tx,input.accountId,clock),owned=await readCoinbaseClaims(tx,input.accountId);
    if(reconcileCurrencyClaims(input.accountId,observed,owned).some(r=>r.state!=='reconciled'))throw new Error('Resolve currency shortfall');
    for(const debit of input.debits)previewCurrencyReservation(input.accountId,input.allocationId,debit.asset,debit.quantity,observed,owned);
    const id=randomUUID(),clientRef=randomUUID();
    await tx.query(`INSERT INTO coinbase_allocation_orders(id,allocation_id,account_id,cause,request_hash,client_ref,product,side,max_base,state,created_at,quote_sized) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared',$10,$11)`,[id,input.allocationId,input.accountId,input.cause,requestHash,clientRef,input.product,input.side,input.maxBase,now(),input.quoteSized??false]);
    for(const debit of input.debits)await tx.query('INSERT INTO coinbase_allocation_reservations(order_id,allocation_id,account_id,asset,maximum,remaining) VALUES($1,$2,$3,$4,$5,$5)',[id,input.allocationId,input.accountId,debit.asset,debit.quantity]);
    return {id,clientRef};

 }
 return {
  /** Reserve ownership locally only after a future reviewed member instruction. */
  fund(input:{accountId:string;allocationId:string;strategyId:string;versionId:string;asset:string;quantity:string;cause:string},authorize?: (tx:Transaction)=>Promise<void>) {
   z.uuid().parse(input.allocationId);asset.parse(input.asset);positive.parse(input.quantity);cause.parse(input.cause);
   const requestHash=hash(input);
   return atomic(input.accountId,async tx=>{
    if(await replay(tx,input.allocationId,'capital:'+input.cause,requestHash))return;
    await authorize?.(tx);
    const valid=(await tx.query(`SELECT 1 FROM strategies s JOIN strategy_versions v ON v.strategy_id=s.id JOIN strategy_account_routes r ON r.strategy_id=s.id
     JOIN linked_accounts a ON a.id=r.account_id JOIN platform_connections c ON c.id=a.connection_id
     WHERE s.id=$1 AND v.id=$2 AND s.current_version_id=v.id AND s.status='committed' AND s.archived_at IS NULL
     AND r.account_id=$3 AND r.venue='coinbase' AND c.venue='coinbase' AND s.owner_id=c.owner_id`,[input.strategyId,input.versionId,input.accountId])).rows.length;
    if(!valid)throw new Error('Committed Take version and explicit Coinbase route required');
    const existing=(await tx.query<Allocation>('SELECT * FROM coinbase_allocations WHERE id=$1',[input.allocationId])).rows[0];
    if(existing&&(existing.account_id!==input.accountId||existing.strategy_id!==input.strategyId||existing.version_id!==input.versionId||existing.status!=='active'||existing.restore_required))throw new Error('Allocation identity mismatch');
    const rows=reconcileCurrencyClaims(input.accountId,await readCoinbaseBalances(tx,input.accountId,clock),await readCoinbaseClaims(tx,input.accountId));
    if(rows.some(r=>r.state!=='reconciled'))throw new Error('Resolve currency claims before funding');
    const row=rows.find(r=>r.asset===input.asset);
    if(!row||row.unclaimed===null||n(input.quantity)>n(row.unclaimed))throw new Error('Insufficient unclaimed currency');
    if(!existing){
     const version=(await tx.query<{spec:unknown}>('SELECT spec FROM strategy_versions WHERE id=$1',[input.versionId])).rows[0];
     const spec=await executionBasket(tx,basketSchema.parse(version.spec),input,'coinbase');
     const driftEnabled=spec.target.weights.every(w=>w.instrument.venue==='coinbase')&&(spec.rebalance.driftBandPoints!==null||spec.rebalance.driftBandRelative!==null);
     await tx.query('INSERT INTO coinbase_allocations(id,account_id,strategy_id,version_id,created_at,drift_enabled) VALUES($1,$2,$3,$4,$5,$6)',[input.allocationId,input.accountId,input.strategyId,input.versionId,now(),driftEnabled]);
    }
    await append(tx,{...input,quantity:format(n(input.quantity)),cause:'capital:'+input.cause,requestHash,kind:'capital',at:now()});
   });
  },
  release(input:{accountId:string;allocationId:string;asset:string;quantity:string;cause:string},authorize?: (tx:Transaction)=>Promise<void>) {
   asset.parse(input.asset);positive.parse(input.quantity);cause.parse(input.cause);const requestHash=hash(input);
   return atomic(input.accountId,async tx=>{
    if(await replay(tx,input.allocationId,'release:'+input.cause,requestHash))return;
    await authorize?.(tx);
    await allocation(tx,input.accountId,input.allocationId,true,false);
    const own=(await readCoinbaseClaims(tx,input.accountId)).find(c=>c.allocationId===input.allocationId&&c.asset===input.asset);
    if(!own||n(input.quantity)>n(own.quantity)-n(own.reserved))throw new Error('Insufficient unreserved allocation currency');
    await append(tx,{...input,quantity:format(-n(input.quantity)),cause:'release:'+input.cause,requestHash,kind:'release',at:now()});
   });
  },
  async returnWithdrawalProceeds(reviewId:string){
   const found=await database.use(async db=>(await db.query<{account_id:string}>('SELECT account_id FROM coinbase_order_reviews WHERE id=$1',[reviewId])).rows[0]);
   if(!found)throw new Error('Withdrawal unavailable');
   return atomic(found.account_id,async tx=>{
    const row=(await tx.query<{account_id:string;allocation_id:string;state:string;payload:{quote:string;withdrawal?:{close?:boolean;residue?:{asset:string;quantity:string}[]}}}>('SELECT account_id,allocation_id,state,payload FROM coinbase_order_reviews WHERE id=$1',[reviewId])).rows[0];
    if(!row.payload.withdrawal||row.state!=='settled')return;
    const key=`withdrawal-return:${reviewId}`;
    if((await tx.query('SELECT 1 FROM coinbase_allocation_entries WHERE allocation_id=$1 AND cause=$2',[row.allocation_id,key])).rows.length)return;
    await allocation(tx,row.account_id,row.allocation_id,true,false);
    if((await tx.query("SELECT 1 FROM coinbase_allocation_orders WHERE allocation_id=$1 AND cause LIKE $2 AND state<>'closed'",[row.allocation_id,`review:${reviewId}:%`])).rows.length)return;
    if(row.payload.withdrawal.close){
     // Only fully filled sells close a Take; cancelled/partial orders keep their holdings.
     const incomplete=(await tx.query(`SELECT 1 FROM coinbase_allocation_orders o LEFT JOIN account_orders p ON p.account_id=o.account_id AND p.provider='coinbase' AND p.provider_ref=o.provider_order_ref
      WHERE o.allocation_id=$1 AND o.cause LIKE $2 AND (p.state IS DISTINCT FROM 'filled') LIMIT 1`,[row.allocation_id,`review:${reviewId}:%`])).rows.length;
     if(!incomplete){
      const owned=(await readCoinbaseClaims(tx,row.account_id)).filter(c=>c.allocationId===row.allocation_id);
      if(owned.some(c=>n(c.reserved)>0n))return;
      for(const c of owned){
       if(!['USD','USDC'].includes(c.asset)&&n(c.quantity)>n(row.payload.withdrawal.residue?.find(r=>r.asset===c.asset)?.quantity??'0'))throw Error('Closing holdings require reconciliation');
      }
      for(const c of owned)if(n(c.quantity)>0n)await append(tx,{accountId:row.account_id,allocationId:row.allocation_id,asset:c.asset,quantity:format(-n(c.quantity)),cause:key,requestHash:hash({reviewId}),kind:'release',at:now()});
      if(!owned.some(c=>n(c.quantity)>0n))await append(tx,{accountId:row.account_id,allocationId:row.allocation_id,asset:row.payload.quote,quantity:'0',cause:key,requestHash:hash({reviewId}),kind:'release',at:now()});
      return;
     }
    }
    const net=(await tx.query<{quantity:string}>(`SELECT coalesce(sum(e.quantity),0)::text AS quantity FROM coinbase_allocation_entries e JOIN coinbase_allocation_orders o ON o.id=e.order_id WHERE e.allocation_id=$1 AND e.asset=$2 AND e.kind='fill' AND o.cause LIKE $3`,[row.allocation_id,row.payload.quote,`review:${reviewId}:%`])).rows[0];
    const proceeds=n(net.quantity);if(proceeds<0n)throw new Error('Withdrawal proceeds require reconciliation');
    const own=(await readCoinbaseClaims(tx,row.account_id)).find(c=>c.allocationId===row.allocation_id&&c.asset===row.payload.quote);
    if(proceeds>0n&&(!own||proceeds>n(own.quantity)-n(own.reserved)))throw new Error('Withdrawal cash requires reconciliation');
    await append(tx,{accountId:row.account_id,allocationId:row.allocation_id,asset:row.payload.quote,quantity:format(-proceeds),cause:key,requestHash:hash({reviewId}),kind:'release',at:now()});
   });
  },
  /** Return only this attempt's unused contribution once its orders are definitively closed. */
  async returnInvestmentCash(investmentId:string){
   const found=await database.use(async db=>(await db.query<{account_id:string}>('SELECT account_id FROM coinbase_investments WHERE id=$1',[investmentId])).rows[0]);
   if(!found)throw new Error('Investment unavailable');
   return atomic(found.account_id,async tx=>{
    const row=(await tx.query<{account_id:string;capital_review_id:string|null;order_review_id:string|null;input:{allocationId:string;asset:string;quantity:string;cause:string};state:string}>(`SELECT i.account_id,i.capital_review_id,i.order_review_id,r.input,r.state FROM coinbase_investments i LEFT JOIN coinbase_capital_reviews r ON r.id=i.capital_review_id WHERE i.id=$1`,[investmentId])).rows[0];
    if(!row.capital_review_id||row.state!=='confirmed')return {settled:true,returned:'0'};
    const input=row.input,key=`investment-return:${investmentId}:${row.capital_review_id}`;
    const previous=(await tx.query<{quantity:string}>('SELECT quantity::text FROM coinbase_allocation_entries WHERE allocation_id=$1 AND cause=$2',[input.allocationId,key])).rows[0];
    if(previous)return {settled:true,returned:format(-n(previous.quantity))};
    if(row.order_review_id){const review=(await tx.query<{state:string}>('SELECT state FROM coinbase_order_reviews WHERE id=$1',[row.order_review_id])).rows[0];if(review&&!['cancelled','settled'].includes(review.state))return {settled:false,returned:'0'};}
    const orderRows=(await tx.query<{state:string}>("SELECT state FROM coinbase_allocation_orders WHERE allocation_id=$1 AND cause LIKE $2",[input.allocationId,`review:${row.order_review_id}:%`])).rows;
    if(orderRows.some(o=>o.state!=='closed'))return {settled:false,returned:'0'};
    await allocation(tx,row.account_id,input.allocationId,true,false);
    const own=(await readCoinbaseClaims(tx,row.account_id)).find(c=>c.allocationId===input.allocationId&&c.asset===input.asset);
    const spent=(await tx.query<{quantity:string}>(`SELECT coalesce(sum(-e.quantity),0)::text AS quantity FROM coinbase_allocation_entries e JOIN coinbase_allocation_orders o ON o.id=e.order_id WHERE e.allocation_id=$1 AND e.asset=$2 AND e.quantity<0 AND e.kind='fill' AND o.cause LIKE $3`,[input.allocationId,input.asset,`review:${row.order_review_id}:%`])).rows[0];
    // Manual cash releases made after this contribution also reduce what it can return.
    const releases=(await tx.query<{quantity:string}>(`SELECT coalesce(sum(-e.quantity),0)::text AS quantity FROM coinbase_allocation_entries e WHERE e.allocation_id=$1 AND e.asset=$2 AND e.kind='release' AND e.cause NOT LIKE 'investment-return:%' AND e.occurred_at >= (SELECT occurred_at FROM coinbase_allocation_entries WHERE allocation_id=$1 AND cause=$3 LIMIT 1)`,[input.allocationId,input.asset,'capital:'+input.cause])).rows[0];
    const remainder=n(input.quantity)-n(spent.quantity)-n(releases.quantity),available=own?n(own.quantity)-n(own.reserved):0n;
    const returned=remainder>0n&&available>0n?(remainder<available?remainder:available):0n;
    // A zero entry is an idempotent settlement marker, preventing a later deposit
    // from being returned by a repeated cancellation of this older attempt.
    await append(tx,{accountId:row.account_id,allocationId:input.allocationId,asset:input.asset,quantity:format(-returned),cause:key,requestHash:hash({investmentId,capitalReviewId:row.capital_review_id}),kind:'release',at:now()});
    return {settled:true,returned:format(returned)};
   });
  },
  prepareOrder(input:OrderInput){return atomic(input.accountId,tx=>prepare(tx,input));},
  prepareOrders(inputs:OrderInput[],authorize:(tx:Transaction)=>Promise<void>){
   if(!inputs.length||inputs.length>20||inputs.some(i=>i.accountId!==inputs[0].accountId||i.allocationId!==inputs[0].allocationId))throw new Error('One allocation per order review required');
   return atomic(inputs[0].accountId,async tx=>{await authorize(tx);const result=[];for(const input of inputs)result.push(await prepare(tx,input));return result;});
  },
  replacePreparedOrders(accountId:string,causes:string[],inputs:OrderInput[],authorize:(tx:Transaction)=>Promise<void>){
   return atomic(accountId,async tx=>{
    const old=(await tx.query<Order>("SELECT * FROM coinbase_allocation_orders WHERE account_id=$1 AND cause=ANY($2::text[])",[accountId,causes])).rows;
    if(old.length!==causes.length||old.some(o=>o.state!=='prepared'||o.provider_order_ref))throw Error('Only unsent orders can be refreshed.');
    if((await tx.query('SELECT 1 FROM coinbase_order_dispatches WHERE order_id=ANY($1::uuid[])',[old.map(o=>o.id)])).rows.length)throw Error('Submitted orders cannot be refreshed.');
    for(const order of old){
     if((await tx.query("SELECT 1 FROM account_orders WHERE account_id=$1 AND provider='coinbase' AND data->>'clientOrderRef'=$2",[accountId,order.client_ref])).rows.length)throw Error('Order already observed at Coinbase.');
     await tx.query('UPDATE coinbase_allocation_reservations SET remaining=0 WHERE order_id=$1',[order.id]);
     await tx.query("UPDATE coinbase_allocation_orders SET state='closed',closed_at=$2 WHERE id=$1",[order.id,now()]);
    }
    await authorize(tx);
    for(const input of inputs){if(input.accountId!==accountId||input.allocationId!==old[0]?.allocation_id)throw Error('Review account changed.');await prepare(tx,input);}
   });
  },
  cancelPrepared(accountId:string,causes:string[],authorize:(tx:Transaction)=>Promise<void>){
   return atomic(accountId,async tx=>{
    await authorize(tx);
    const orders=(await tx.query<Order>("SELECT * FROM coinbase_allocation_orders WHERE account_id=$1 AND cause=ANY($2::text[])",[accountId,causes])).rows;
    if(orders.length!==causes.length||orders.some(o=>o.state!=='prepared'||o.provider_order_ref))throw new Error('Only unsent reservations can be cancelled here.');
    for(const o of orders){
     if((await tx.query("SELECT 1 FROM account_orders WHERE account_id=$1 AND provider='coinbase' AND data->>'clientOrderRef'=$2",[accountId,o.client_ref])).rows.length)throw new Error('Order already observed at Coinbase.');
     await tx.query('UPDATE coinbase_allocation_reservations SET remaining=0 WHERE order_id=$1',[o.id]);
     await tx.query("UPDATE coinbase_allocation_orders SET state='closed',closed_at=$2 WHERE id=$1",[o.id,now()]);
    }
   });
  },
  dispatchOrder(accountId:string,id:string,authorize:(tx:Transaction)=>Promise<void>){
   return atomic(accountId,async tx=>{
    const order=(await tx.query<Order>("SELECT * FROM coinbase_allocation_orders WHERE id=$1 AND account_id=$2 AND state='prepared'",[id,accountId])).rows[0];
    if(!order)throw new Error('Order is already submitted or unavailable.');
    const closing=order.side==='sell'&&(await tx.query("SELECT 1 FROM coinbase_order_reviews WHERE allocation_id=$1 AND $2 LIKE 'review:'||id::text||':%' AND payload->'withdrawal'->>'close'='true' AND state='confirmed'",[order.allocation_id,order.cause])).rows.length>0;
    await allocation(tx,accountId,order.allocation_id,true,!closing);
    const observed=await readCoinbaseBalances(tx,accountId,clock),owned=await readCoinbaseClaims(tx,accountId);
    if(reconcileCurrencyClaims(accountId,observed,owned).some(r=>r.state!=='reconciled'))throw new Error('Resolve account shortfalls before submitting.');
    const reservations=(await tx.query<{asset:string;remaining:string;maximum:string}>('SELECT asset,remaining::text,maximum::text FROM coinbase_allocation_reservations WHERE order_id=$1',[id])).rows;
    if(!reservations.length)throw new Error('Missing reservation');
    for(const r of reservations){const balance=observed.find(b=>b.asset===r.asset);if(n(r.remaining)!==n(r.maximum)||balance?.available==null||n(balance.available)<n(r.remaining))throw new Error('Reserved currency is no longer available.');}
    await authorize(tx);
    await tx.query("UPDATE coinbase_allocation_orders SET state='submitting' WHERE id=$1",[id]);
   });
  },
  fundingRoom(accountId:string){return atomic(accountId,async tx=>reconcileCurrencyClaims(accountId,await readCoinbaseBalances(tx,accountId,clock),await readCoinbaseClaims(tx,accountId)));},
  snapshot(accountId:string){return atomic(accountId,async tx=>({claims:await readCoinbaseClaims(tx,accountId),orders:(await tx.query<Order>('SELECT * FROM coinbase_allocation_orders WHERE account_id=$1 ORDER BY created_at',[accountId])).rows}));},
  async reconcile(accountId:string) {
   const ids=await atomic(accountId,async tx=>(await tx.query<{id:string}>("SELECT o.id FROM coinbase_allocation_orders o WHERE o.account_id=$1 AND (o.state IN ('prepared','submitting','unknown','bound') OR (o.state='closed' AND EXISTS(SELECT 1 FROM account_executions e WHERE e.account_id=o.account_id AND e.provider='coinbase' AND e.order_ref=o.provider_order_ref AND e.attribution_state<>'completed'))) ORDER BY o.created_at LIMIT 100",[accountId])).rows);
   for(const {id} of ids)try {await atomic(accountId,async tx=>{
    const order=(await tx.query<Order>('SELECT * FROM coinbase_allocation_orders WHERE id=$1 AND account_id=$2',[id,accountId])).rows[0];
    if(!order||!['prepared','submitting','unknown','bound','closed'].includes(order.state))return;
    await allocation(tx,accountId,order.allocation_id,false);
    const provider=(await tx.query<{provider_ref:string;data:CoinbaseOrder}>(`SELECT provider_ref,data FROM account_orders WHERE account_id=$1 AND provider='coinbase' AND data->>'clientOrderRef'=$2`,[accountId,order.client_ref])).rows;
    const evidence=recoverOrder({venue:'coinbase',accountId,clientRef:order.client_ref},provider.map(p=>({...p,venue:'coinbase' as const,accountId,clientRef:p.data.clientOrderRef??'',providerRef:p.provider_ref})));
    if(!evidence)return;
    if(evidence.data.productId!==order.product||evidence.data.side!==order.side||!Number.isFinite(Date.parse(evidence.data.sourceCreatedAt))||Date.parse(evidence.data.sourceCreatedAt)<order.created_at.getTime()||(order.provider_order_ref&&order.provider_order_ref!==evidence.provider_ref))throw new Error('Provider order binding mismatch');
    await tx.query("UPDATE coinbase_allocation_orders SET state='bound',provider_order_ref=$2 WHERE id=$1",[id,evidence.provider_ref]);
    const fills=(await tx.query<{provider_ref:string;data:CoinbaseFill}>("SELECT provider_ref,data FROM account_executions WHERE account_id=$1 AND provider='coinbase' AND order_ref=$2 ORDER BY occurred_at,provider_ref",[accountId,evidence.provider_ref])).rows;
    let filled=0n,fees=0n;
    for(const execution of fills){
     const fill=execution.data;if(fill.productId!==order.product||fill.side!==order.side||fill.orderRef!==evidence.provider_ref||fill.providerExecutionRef!==execution.provider_ref||!Number.isFinite(Date.parse(fill.occurredAt))||Date.parse(fill.occurredAt)<Date.parse(evidence.data.sourceCreatedAt))throw new Error('Fill binding mismatch');
     const movements=coinbaseFillMovements(fill);if(movements.some(m=>!m.exact))throw new Error('Inexact fill');
     filled+=n(fill.quantity);fees+=n(fill.feeAmount);if(!order.quote_sized&&filled>n(order.max_base))throw new Error('Fill exceeds reviewed quantity');
     const key='fill:'+execution.provider_ref,requestHash=hash(fill);
     if(await replay(tx,order.allocation_id,key,requestHash))continue;
     if(order.state==='closed')throw new Error('Late fill requires reconciliation');
     const deltas=new Map<string,bigint>();for(const m of movements)deltas.set(m.asset,(deltas.get(m.asset)??0n)+n(m.quantity));
     const owned=await readCoinbaseClaims(tx,accountId);
     for(const [currency,delta] of deltas){
      if(delta===0n)continue;
      const own=owned.find(c=>c.allocationId===order.allocation_id&&c.asset===currency),quantity=n(own?.quantity??'0');
      if(quantity+delta<0n)throw new Error('Fill exceeds allocation holdings');
      if(delta<0n){const reservation=(await tx.query<{remaining:string}>('SELECT remaining::text FROM coinbase_allocation_reservations WHERE order_id=$1 AND asset=$2',[id,currency])).rows[0];
       if(!reservation||n(reservation.remaining)<-delta)throw new Error('Fill exceeds reviewed currency limit');
       await tx.query('UPDATE coinbase_allocation_reservations SET remaining=remaining+$3 WHERE order_id=$1 AND asset=$2',[id,currency,format(delta)]);
      }
      await append(tx,{allocationId:order.allocation_id,accountId,asset:currency,quantity:format(delta),cause:key,requestHash,kind:'fill',at:fill.occurredAt,orderId:id,executionRef:execution.provider_ref});
     }
     await tx.query("UPDATE account_executions SET attribution_state='completed',attributed_at=$3 WHERE account_id=$1 AND provider='coinbase' AND provider_ref=$2",[accountId,execution.provider_ref,now()]);
    }
    // Terminal status alone cannot prove all fills have arrived.
    if(evidence.data.terminal&&n(evidence.data.filledQuantity)===filled&&n(evidence.data.feeAmount)===fees){
     await tx.query('UPDATE coinbase_allocation_reservations SET remaining=0 WHERE order_id=$1',[id]);
     await tx.query("UPDATE coinbase_allocation_orders SET state='closed',closed_at=$2 WHERE id=$1",[id,now()]);
    }
   });}catch{
    await atomic(accountId,async tx=>{await tx.query("UPDATE coinbase_allocation_orders SET state='reconciliation_required' WHERE id=$1 AND account_id=$2",[id,accountId]);await tx.query("UPDATE coinbase_allocations SET status='reconciliation_required' WHERE id=(SELECT allocation_id FROM coinbase_allocation_orders WHERE id=$1)",[id]);});
   }
  },
 };
}
