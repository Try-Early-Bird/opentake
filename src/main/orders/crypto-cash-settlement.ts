import type {createDatabaseLifecycle} from '../database';
import type {CryptoFillSnapshot} from './crypto-fill-accounting';
import {claimed,measuredCash} from '../allocations/evidence';
import {personalCashHeld,unsettledTakeCash} from './cash-holds';
import {amount} from '../allocations/ledger';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
/** Release only after terminal fills and post-terminal account cash evidence.
 * Filled buys additionally require the observed cash decrease to cover the debit. */
export function createCryptoCashSettlement(database:Database,clock=()=>Date.now()){
 function release(input:{intentId:string;accountId:string},allowFilled:boolean){
  return database.use(db=>db.transaction(async tx=>{
   const now=new Date(clock()).toISOString();
   const row=(await tx.query<{allocation_id:string|null;provider_order_ref:string|null;status:string;amount:string;hold_state:string;cash_before:string|null;snapshot:CryptoFillSnapshot|null;observed_at:Date|null}>(`SELECT i.allocation_id,i.provider_order_ref,i.status,h.amount::text,h.state AS hold_state,h.cash_before::text,c.snapshot,c.observed_at
    FROM order_intents i JOIN order_cash_holds h ON h.intent_id=i.id LEFT JOIN order_fill_checkpoints c ON c.intent_id=i.id
    WHERE i.id=$1 AND i.account_id=$2 AND i.asset_class='crypto' FOR UPDATE OF i,h`,[input.intentId,input.accountId])).rows[0];
   if(!row)throw Error('Crypto cash hold not found');
   if(row.hold_state==='released')return {released:true};
   const snapshot=row.snapshot;
   if(row.status!=='placed'||!snapshot||snapshot.orderRef!==row.provider_order_ref||!snapshot.terminal
    ||snapshot.side!=='buy'||(!allowFilled&&(amount(snapshot.filled)!==0n||amount(snapshot.netCash)!==0n)))throw Error(allowFilled?'Confirmed terminal buy evidence required':'Confirmed zero-fill terminal evidence required');
   const observed=row.observed_at?.getTime();
   if(observed===undefined||observed>clock()||clock()-observed>60000)throw Error('Fresh terminal order evidence required');
   if(!(await tx.query(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
    WHERE a.id=$1 AND c.venue='robinhood' AND c.status='connected' FOR UPDATE OF a`,[input.accountId])).rows.length)throw Error('Account requires reconciliation');
   if((await tx.query(`SELECT 1 FROM account_executions WHERE account_id=$1 AND attribution_state<>'completed' LIMIT 1`,[input.accountId])).rows.length)throw Error('Wait for account fill attribution');
   if((await tx.query(`SELECT 1 FROM account_orders WHERE account_id=$1 AND NOT terminal LIMIT 1`,[input.accountId])).rows.length)throw Error('Wait for open account orders');
   if((await tx.query(`SELECT 1 FROM order_intents i WHERE account_id=$1 AND id<>$2 AND (status IN ('placing','placement_unknown') OR (asset_class='crypto' AND status='placed' AND NOT EXISTS(SELECT 1 FROM order_fill_checkpoints f WHERE f.intent_id=i.id AND (f.snapshot->>'terminal')::boolean))) LIMIT 1`,[input.accountId,input.intentId])).rows.length)throw Error('Wait for uncertain account submissions');
   const cash=await measuredCash(tx,input.accountId,now);
   if(Date.parse(cash.observedAt)<observed||Date.parse(cash.observedAt)>clock()||clock()-Date.parse(cash.observedAt)>60000)throw Error('Refresh account cash after the terminal order observation');
   // Every required discovery checkpoint must postdate the terminal observation.
   const complete=(await tx.query(`SELECT resource FROM account_sync_checkpoints WHERE account_id=$1
    AND resource IN ('portfolio','equity_orders','option_orders') AND discovery_complete AND watermark>=$2 AND watermark<=$3`,[input.accountId,new Date(observed).toISOString(),now])).rows;
   if(complete.length!==3)throw Error('Complete post-terminal account sync required');
   const debit=amount(snapshot.netCash);
   if(debit>0n&&(row.cash_before===null||cash.cash>amount(row.cash_before)-debit))throw Error('Account cash has not reconciled the executed crypto debit');
   const claims=await claimed(tx,input.accountId,null);
   if(claims.some(c=>amount(c.quantity)<0n))throw Error('Resolve negative allocation cash');
   const remainingPersonal=await personalCashHeld(tx,input.accountId)-(row.allocation_id===null?amount(row.amount):0n);
   if(cash.cash<claims.reduce((sum,c)=>sum+amount(c.quantity),0n)+remainingPersonal+await unsettledTakeCash(tx,input.accountId)-(row.allocation_id===null?0n:debit))throw Error('Account cash does not cover remaining claims');
   await tx.query(`UPDATE order_cash_holds SET state='released',released_at=$2 WHERE intent_id=$1 AND state='held'`,[input.intentId,now]);
   return {released:true};
  }));
 }
 return {releaseUnfilled:(input:{intentId:string;accountId:string})=>release(input,false),releaseSettled:(input:{intentId:string;accountId:string})=>release(input,true)};
}
