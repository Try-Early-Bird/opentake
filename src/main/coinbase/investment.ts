import {createCoinbaseAllocations} from './allocations';
import {z} from 'zod';
import type {createDatabaseLifecycle} from '../database';
import type {createCoinbaseCapital} from './capital';
import type {createCoinbaseOrderReviews} from './order-reviews';
import type {createCoinbaseExecution} from './execution';
import {coinbaseInvestmentRequest,type CoinbaseInvestmentRequest,type CoinbaseInvestmentView} from '../../shared/coinbase-investment';
import type {CoinbaseOrderReview} from '../../shared/coinbase-orders';
type Row={id:string;take_id:string;account_id:string;request:CoinbaseInvestmentRequest;capital_review_id:string|null;order_review_id:string|null;state:CoinbaseInvestmentView['state']};
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
/** Member's Invest action composes existing durable capital and order services. No background submission. */
export function createCoinbaseInvestments(database:Database,capital:ReturnType<typeof createCoinbaseCapital>,orders:ReturnType<typeof createCoinbaseOrderReviews>,execution:ReturnType<typeof createCoinbaseExecution>,eligible:(accountId:string)=>Promise<void>,clock=Date.now){
 const core=createCoinbaseAllocations(database,clock);
 const active=new Map<string,Promise<CoinbaseInvestmentView>>();let closing=false;
 const read=async(id:string)=>{z.uuid().parse(id);const row=await database.use(async db=>(await db.query<Row>('SELECT * FROM coinbase_investments WHERE id=$1',[id])).rows[0]);if(!row)throw Error('Investment unavailable.');return row;};
 const check=()=>{if(closing)throw Error('The app is shutting down. Reopen the Take to continue.');};
 const exclusive=(takeId:string,work:()=>Promise<CoinbaseInvestmentView>)=>{check();if(active.has(takeId))throw Error('An investment is already being checked.');const task=work().finally(()=>active.delete(takeId));active.set(takeId,task);return task;};
 const preference=()=>database.use(async db=>(await db.query<{confirm_trades:boolean}>('SELECT p.confirm_trades FROM trading_preferences p JOIN local_owners o ON o.id=p.owner_id LIMIT 1')).rows[0]?.confirm_trades??false);
 async function view(row:Row,error:string|null=null):Promise<CoinbaseInvestmentView>{
  let review=row.order_review_id?await execution.view(row.order_review_id):null;
  const returned=row.capital_review_id?await database.use(async db=>(await db.query<{quantity:string}>("SELECT (-quantity)::text AS quantity FROM coinbase_allocation_entries WHERE cause=$1",[`investment-return:${row.id}:${row.capital_review_id}`])).rows[0]):null;
  if(returned&&row.state!=='cancelled'){row={...row,state:'started'};review=null;}
  const funded=row.capital_review_id?await database.use(async db=>(await db.query("SELECT 1 FROM coinbase_capital_reviews WHERE id=$1 AND state='confirmed'",[row.capital_review_id])).rows.length):0;
  const cashStatus=row.state==='cancelled'?(review&&!['cancelled','settled'].includes(review.state)?'Cancellation pending. Cash stays reserved until orders are resolved.':!funded?'Investment cancelled. No new cash is set aside.':returned?(Number(returned.quantity)>0?'Unused cash returned to your Coinbase account.':'Cancellation complete. Purchased holdings remain in this Take.'):'Orders cancelled. Holdings and unused cash remain in this Take.'):row.state==='started'?'No orders placed. Cash remains available in your Coinbase account.':row.state==='funded'||row.state==='ready'?'Cash set aside for this investment. No orders placed yet.':review?.state==='settled'?'Orders resolved. Purchased holdings and remaining cash are shown below.':'Investment pending. Cash for unresolved orders remains reserved.';
  return {id:row.id,requestedAmount:row.request.quantity==='0'?undefined:row.request.quantity,asset:row.request.asset,state:row.state,capital:await capital.view(row.take_id),review,needsConfirmation:row.state==='ready',error,cashStatus};
 }
 async function advance(initial:Row,confirmed=false):Promise<CoinbaseInvestmentView>{
  let row=initial;
  try{
   if(row.state==='cancelled')return view(row);
   if(row.capital_review_id&&await database.use(async db=>(await db.query('SELECT 1 FROM coinbase_allocation_entries WHERE cause=$1',[`investment-return:${row.id}:${row.capital_review_id}`])).rows.length)){
    await database.use(db=>db.query("UPDATE coinbase_investments SET state='started',capital_review_id=NULL,order_review_id=NULL WHERE id=$1",[row.id]));row=await read(row.id);
   }
   if(row.state==='dispatched'){if(confirmed&&row.order_review_id){check();await execution.submit(row.order_review_id);}return view(row);}
   check();if((await capital.view(row.take_id)).accountId!==row.account_id)throw Error('The Take account changed. Review it again.');
   await eligible(row.account_id);check();
   if(row.state==='started'){
    if(!row.capital_review_id&&/[1-9]/.test(row.request.quantity)){
     const next=await capital.preview({takeId:row.take_id,asset:row.request.asset,quantity:row.request.quantity,kind:'assign'});
     await database.use(db=>db.query('UPDATE coinbase_investments SET capital_review_id=$2 WHERE id=$1',[row.id,next.id]));row=await read(row.id);
    }
    if(row.capital_review_id){
     const capitalReview=await database.use(async db=>(await db.query<{state:string;expires_at:Date;input:{allocationId:string;quantity:string}}>('SELECT state,expires_at,input FROM coinbase_capital_reviews WHERE id=$1',[row.capital_review_id])).rows[0]);
     if(capitalReview?.state==='pending'&&capitalReview.expires_at.getTime()<=clock()){
      const next=await capital.preview({takeId:row.take_id,asset:row.request.asset,quantity:row.request.quantity,kind:'assign'});check();
      await database.use(db=>db.query('UPDATE coinbase_investments SET capital_review_id=$2 WHERE id=$1',[row.id,next.id]));row=await read(row.id);
     }
     if(capitalReview?.state!=='confirmed'){
      const proposal=await database.use(async db=>(await db.query<{input:{allocationId:string;quantity:string}}>('SELECT input FROM coinbase_capital_reviews WHERE id=$1',[row.capital_review_id])).rows[0]);
      await orders.preview({takeId:row.take_id,quote:row.request.asset},{accountId:row.account_id,...proposal.input});check();
     }
     await capital.confirm(row.capital_review_id!);
    }check();
    await database.use(db=>db.query("UPDATE coinbase_investments SET state='funded' WHERE id=$1",[row.id]));row=await read(row.id);
   }
   let review:CoinbaseOrderReview;
   if(row.order_review_id){
    const saved=await orders.load(row.order_review_id);review={...saved.payload,state:saved.state};
    if(saved.state==='cancelled')throw Error('Orders were cancelled. No additional funds have been assigned.');
    if(saved.expires_at.getTime()<=clock()&&saved.state==='preview'){
     review=await orders.preview({takeId:row.take_id,quote:row.request.asset},undefined,undefined,true);confirmed=false;
     await database.use(db=>db.query("UPDATE coinbase_investments SET order_review_id=$2,state='ready' WHERE id=$1",[row.id,review.id]));row=await read(row.id);
     return view(row,'The order review expired. Review the updated orders before confirming.');
    }
   }else{
    review=await orders.preview({takeId:row.take_id,quote:row.request.asset},undefined,undefined,true);check();
    await database.use(db=>db.query("UPDATE coinbase_investments SET order_review_id=$2,state='ready' WHERE id=$1",[row.id,review.id]));row=await read(row.id);
   }
   if(!confirmed&&await preference())return view(row);
   check();await orders.confirm(review.id);check();
   // Persist before sending. An interrupted/uncertain dispatch is only reconciled, never automatically retried.
   await database.use(db=>db.query("UPDATE coinbase_investments SET state='dispatched' WHERE id=$1",[row.id]));row=await read(row.id);
   await execution.submit(review.id);return view(row);
  }catch(e){
   row=await read(row.id);
   // Compensate only before any durable dispatch. Uncertain or accepted orders
   // retain their reservations until provider evidence resolves them.
   const sent=row.order_review_id?await database.use(async db=>(await db.query('SELECT 1 FROM coinbase_order_dispatches WHERE review_id=$1 LIMIT 1',[row.order_review_id])).rows.length):0;
   if(!sent){
    try{
     if(row.order_review_id){const r=await orders.load(row.order_review_id);if(r.state==='confirmed')await orders.cancel(r.id);else if(r.state==='preview')await database.use(db=>db.query("UPDATE coinbase_order_reviews SET state='cancelled' WHERE id=$1 AND state='preview'",[r.id]));}
     const mixed=await database.use(async db=>(await db.query("SELECT 1 FROM mixed_take_execution_legs WHERE venue='coinbase' AND operation_id=$1",[row.id])).rows.length>0);
     if(mixed){
      // A combined investment owns this cash. Preserve it for this child, not
      // another funding action, while the other platform may already be buying.
      await database.use(db=>db.query("UPDATE coinbase_investments SET state='funded',order_review_id=NULL WHERE id=$1",[row.id]));
      return view(await read(row.id),e instanceof Error?e.message:'Could not prepare Coinbase orders.');
     }
     const returned=await core.returnInvestmentCash(row.id);
     if(returned.settled)await database.use(db=>db.query("UPDATE coinbase_investments SET state='started',capital_review_id=NULL,order_review_id=NULL WHERE id=$1",[row.id]));
    }catch{/* Keep durable ownership visible if recovery cannot yet finish. */}
   }
   return view(await read(row.id),e instanceof Error?e.message:'Could not complete the investment.');
  }
 }
 return {
  busy:()=>active.size>0,
  async current(takeId:string){z.uuid().parse(takeId);const row=await database.use(async db=>(await db.query<Row>('SELECT * FROM coinbase_investments WHERE take_id=$1 ORDER BY created_at DESC LIMIT 1',[takeId])).rows[0]);return row?view(row):null;},
  invest(raw:unknown){const input=coinbaseInvestmentRequest.parse(raw);return exclusive(input.takeId,async()=>{
   const prior=await database.use(async db=>(await db.query<Row>('SELECT * FROM coinbase_investments WHERE id=$1',[input.operationId])).rows[0]);
   if(prior){if(JSON.stringify(prior.request)!==JSON.stringify(input)){
    if(prior.take_id!==input.takeId||prior.account_id!==input.accountId||prior.request.asset!==input.asset||prior.request.quantity!==input.quantity)throw Error('Investment request changed.');
   }return view(prior);}
   const spec=await database.use(async db=>(await db.query<{spec:{target:{weights:{instrument:{venue:string}}[]}}}>('SELECT v.spec FROM takes t JOIN strategies s ON s.id=t.strategy_id JOIN strategy_versions v ON v.id=s.current_version_id WHERE t.id=$1',[input.takeId])).rows[0]?.spec);
   if(spec?.target.weights.some(w=>w.instrument.venue!=='coinbase'))throw Error('Use the combined account review to invest in a mixed Take.');
   const current=await capital.view(input.takeId);if(current.accountId!==input.accountId)throw Error('The Take account changed. Review it again.');
   await eligible(input.accountId);check();
   const usesAssignedCash=!/[1-9]/.test(input.quantity);
   if(usesAssignedCash&&!current.balances.some(b=>b.asset===input.asset&&Number(b.quantity)>Number(b.reserved)))throw Error('No available cash assigned to this Take.');
   const review=usesAssignedCash?null:await capital.preview({takeId:input.takeId,asset:input.asset,quantity:input.quantity,kind:'assign'});check();
   await database.use(db=>db.query('INSERT INTO coinbase_investments(id,take_id,account_id,request,capital_review_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[input.operationId,input.takeId,input.accountId,JSON.stringify(input),review?.id??null,new Date(clock()).toISOString()]));
   return advance(await read(input.operationId));
  });},
  async continue(id:string,confirmed=false){const row=await read(id);return exclusive(row.take_id,()=>advance(row,confirmed));},
  async cancel(id:string){const row=await read(id);return exclusive(row.take_id,async()=>{
   if(row.order_review_id){
    await database.use(db=>db.query("UPDATE coinbase_order_reviews SET state='cancelled' WHERE id=$1 AND state='preview'",[row.order_review_id]));
    const r=await orders.load(row.order_review_id);if(r.state==='confirmed'||r.state==='settled')await execution.cancel(r.id);
   }
   await database.use(db=>db.query("UPDATE coinbase_investments SET state='cancelled' WHERE id=$1",[id]));return view(await read(id));
  });},
  async refresh(id:string){const row=await read(id);return exclusive(row.take_id,async()=>{if(row.order_review_id)await execution.refresh(row.order_review_id);return view(await read(id));});},
  async close(){closing=true;await Promise.allSettled([...active.values()]);},
 };
}
