import {adoptMixedVersion} from '../mixed-execution/version';
import {strategyNameSql} from '../strategies/take-name';
import {rebalanceClaimsEvidence} from './rebalance-warning';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import type {CoinbaseLifecycle,CoinbaseLifecycleDecision} from '../../shared/coinbase-lifecycle';
import {readCoinbaseBalances,readCoinbaseClaims} from './allocations';
import {amount,format} from './order-planner';
import {basketSchema} from '../../shared/strategies';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Query=Pick<Transaction,'query'>;
type LifecycleTarget={version_sequence:number;current_version_sequence:number;account_id:string;allocation_id:string;label:string;archived:boolean;version_id:string;current_version_id:string;drift_enabled:boolean;restore_required:boolean;status:string;clean:boolean;spec:unknown;next_spec:unknown};
/** Proportional loss of account assets; no exchange rate, inferred sale, or new ownership. */
export function recoveryChanges(claims:{allocationId:string;asset:string;quantity:string;reserved:string}[],balances:{asset:string;total:string}[]){
 const changes:{allocationId:string;asset:string;before:string;after:string}[]=[];
 for(const balance of balances){
  const owned=claims.filter(c=>c.asset===balance.asset&&amount(c.quantity)>0n).sort((a,b)=>a.allocationId.localeCompare(b.allocationId));
  const total=owned.reduce((s,c)=>s+amount(c.quantity),0n),actual=amount(balance.total);
  if(total<=actual)continue;
  if(owned.some(c=>amount(c.reserved)>0n))throw Error('Wait for reserved orders to resolve.');
  let remaining=actual;
  owned.forEach((c,i)=>{const next=i===owned.length-1?remaining:amount(c.quantity)*actual/total;remaining-=next;changes.push({allocationId:c.allocationId,asset:c.asset,before:format(amount(c.quantity)),after:format(next)});});
 }
 return changes;
}
export function createCoinbaseLifecycle(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,clock=Date.now){
 async function accountEvidence(db:Query,accountId:string,fresh:boolean){
  const claims=await readCoinbaseClaims(db,accountId);
  const pendingOrders=(await db.query(`SELECT 1 FROM coinbase_allocation_orders WHERE account_id=$1 AND state<>'closed'
   UNION ALL SELECT 1 FROM coinbase_order_reviews WHERE account_id=$1 AND state='confirmed'
   UNION ALL SELECT 1 FROM coinbase_investments WHERE account_id=$1 AND state IN ('started','funded','ready') LIMIT 1`,[accountId])).rows.length>0;
  let balances:{asset:string;total:string}[]=[],balancesUnavailable=false;
  try{balances=await readCoinbaseBalances(db,accountId,clock,fresh?60000:900000);}catch{balancesUnavailable=true;}
  const needsReconciliation=(await db.query("SELECT 1 FROM coinbase_allocations WHERE account_id=$1 AND (restore_required OR status<>'active') LIMIT 1",[accountId])).rows.length>0;
  const titles=(await db.query<{id:string;title:string}>(`SELECT a.id,coalesce(${strategyNameSql('a.strategy_id')},t.title) AS title FROM coinbase_allocations a JOIN takes t ON t.strategy_id=a.strategy_id WHERE a.account_id=$1`,[accountId])).rows;
  return {claims,pendingOrders,balances,balancesUnavailable,needsReconciliation,titles};
 }
 const targetSelection=`a.account_id,a.id AS allocation_id,coalesce(d.label,la.nickname,la.masked_number) AS label,
   s.archived_at IS NOT NULL AS archived,a.version_id,s.current_version_id,a.drift_enabled,a.restore_required,a.status,
   v.sequence AS version_sequence,nv.sequence AS current_version_sequence,nv.source_proposal_id=s.draft_revision_id AS clean,v.spec,nv.spec AS next_spec
   FROM takes t JOIN strategies s ON s.id=t.strategy_id JOIN local_owners own ON own.id=s.owner_id
   JOIN strategy_account_routes r ON r.strategy_id=s.id AND r.venue='coinbase'
   JOIN coinbase_allocations a ON a.strategy_id=s.id AND a.account_id=r.account_id
   JOIN linked_accounts la ON la.id=a.account_id JOIN platform_connections c ON c.id=la.connection_id AND c.owner_id=own.id
   LEFT JOIN coinbase_connection_details d ON d.connection_id=c.id
   JOIN strategy_versions v ON v.id=a.version_id JOIN strategy_versions nv ON nv.id=s.current_version_id`;
 async function state(db:Query,takeId:string,fresh=false,readAccount=accountEvidence,loaded?:LifecycleTarget):Promise<CoinbaseLifecycle>{
  const row=loaded??(await db.query<LifecycleTarget>(`SELECT ${targetSelection} WHERE t.id=$1`,[takeId])).rows[0];
  if(!row)throw Error('Coinbase allocation unavailable.');
  const {claims,pendingOrders,balances,balancesUnavailable,needsReconciliation,titles}=await readAccount(db,row.account_id,fresh);
  let blocked:string|null=null;
  if(row.restore_required||row.status!=='active')blocked='This allocation needs reconciliation before it can resume.';
  if(pendingOrders)blocked='Wait for the account’s pending orders to resolve.';
  if(balancesUnavailable)blocked='Sync this account before reviewing changes.';
  // Stale balances read as empty; only a successful read can show a wallet missing.
  if(!balancesUnavailable&&claims.some(c=>amount(c.quantity)>0n&&!balances.some(b=>b.asset===c.asset)))blocked='Some wallet balances are missing. Sync this account before reviewing changes.';
  if(claims.some(c=>amount(c.reserved)>0n))blocked='Wait for reserved orders to resolve.';
  if(needsReconciliation)blocked='Reconcile the account’s paused or restored allocations first.';
  const pending=claims.some(c=>amount(c.reserved)>0n)||blocked==='Wait for the account’s pending orders to resolve.';
  const changes=blocked?[]:recoveryChanges(claims,balances);
  const current=basketSchema.parse(row.spec),next=basketSchema.parse(row.next_spec);
  const mixed=(await db.query('SELECT 1 FROM mixed_take_executions WHERE take_id=$1 LIMIT 1',[takeId])).rows.length>0;

  const latestRun=(await db.query<{warning_code:'below_minimum'|'insufficient_funds'|null;warning_details:{claimsHash?:string;cash?:{currency:string;required:string;available:string;shortfall:string}}|null;updated_at:Date;next_attempt_at:Date;state:string}>(`SELECT warning_code,warning_details,updated_at,next_attempt_at,state FROM coinbase_rebalance_runs r
   WHERE allocation_id=$1 AND trigger='drift' AND created_at>=coalesce((SELECT max(created_at) FROM coinbase_allocation_decisions WHERE allocation_id=$1 AND kind='adopt'),'-infinity'::timestamptz)
   ORDER BY created_at DESC,id DESC LIMIT 1`,[row.allocation_id])).rows[0];
  const rebalanceWarning=latestRun?.warning_code&&latestRun.warning_details?.claimsHash===rebalanceClaimsEvidence(claims.filter(c=>c.allocationId===row.allocation_id))?{cash:latestRun.warning_details?.cash,code:latestRun.warning_code,checkedAt:latestRun.updated_at.toISOString(),nextRetryAt:latestRun.state==='pending'?latestRun.next_attempt_at.toISOString():null}:null;
  const weights=(spec:typeof current)=>spec.target.weights.map(w=>({symbol:w.instrument.symbol,bps:w.bps}));
  return {takeId,versionSequence:row.version_sequence,currentVersionSequence:row.current_version_sequence,rebalanceWarning,pending,funded:claims.some(c=>c.allocationId===row.allocation_id&&amount(c.quantity)>0n),accountId:row.account_id,allocationId:row.allocation_id,accountLabel:row.label,archived:row.archived,versionId:row.version_id,currentVersionId:row.current_version_id,driftEnabled:row.drift_enabled,
   canEnableDrift:(mixed||!next.target.weights.some(w=>w.instrument.venue!=='coinbase'))&&(next.rebalance.driftBandPoints!==null||next.rebalance.driftBandRelative!==null),blocked,
   evidence:hash([row,claims.map(c=>({...c,quantity:format(amount(c.quantity)),reserved:format(amount(c.reserved))})).sort((a,b)=>(a.allocationId+a.asset).localeCompare(b.allocationId+b.asset)),balances]),
   changes:changes.map(c=>({...c,takeTitle:titles.find(t=>t.id===c.allocationId)?.title??'Take'})),currentWeights:weights(current),nextWeights:weights(next),currentRules:{cashBps:current.target.cashBps,...current.rebalance},nextRules:{cashBps:next.target.cashBps,...next.rebalance}};
 }
 const view=(takeId:string)=>database.use(db=>db.transaction(tx=>state(tx,z.uuid().parse(takeId))));
 return {
  view,
  /** Display projection only: reuse account evidence within bounded transactions. */
  async viewMany(takeIds:string[]):Promise<Record<string,CoinbaseLifecycle|null>> {
   const ids=z.array(z.uuid()).parse(takeIds),result:Record<string,CoinbaseLifecycle|null>={};
   for(let offset=0;offset<ids.length;offset+=10){
    const batch=ids.slice(offset,offset+10);
    try{
     const views=await database.use(db=>db.transaction(async tx=>{
      const accounts=new Map<string,Promise<Awaited<ReturnType<typeof accountEvidence>>>>();
      const readAccount:typeof accountEvidence=(db,id,fresh)=>{
       const key=`${id}:${fresh}`;let evidence=accounts.get(key);
       if(!evidence){evidence=accountEvidence(db,id,fresh);accounts.set(key,evidence);}return evidence;
      };
      const rows=(await tx.query<LifecycleTarget & {take_id:string}>(`SELECT t.id AS take_id,${targetSelection} WHERE t.id=ANY($1::uuid[])`,[batch])).rows;
      const targets=new Map(rows.map(({take_id,...row})=>[take_id,row]));
      const views:CoinbaseLifecycle[]=[];
      for(const id of batch){
       const target=targets.get(id);if(!target)throw Error('Coinbase allocation unavailable.');
       views.push(await state(tx,id,false,readAccount,target));
      }
      return views;
     }));
     for(const item of views)result[item.takeId]=item;
    }catch{
     // Roll back a failed batch before preserving the old per-Take failure boundary.
     for(const id of batch)result[id]=await view(id).catch(()=>null);
    }
   }
   return result;
  },
  async decide(raw:CoinbaseLifecycleDecision){
   const input=z.object({takeId:z.uuid(),evidence:z.string().length(64),action:z.enum(['reconcile','release','adopt','enable_drift','disable_drift'])}).strict().parse(raw);
   return database.use(db=>db.transaction(async tx=>{
    const initial=await state(tx,input.takeId);await tx.query('SELECT id FROM linked_accounts WHERE id=$1 FOR UPDATE',[initial.accountId]);
    const review=await state(tx,input.takeId,true);if(review.blocked)throw Error(review.blocked);if(review.evidence!==input.evidence)throw Error('Account or Take changed. Review the latest values.');
    const now=new Date(clock()).toISOString(),id=randomUUID();
    const audit=async(kind:string,details:unknown)=>tx.query(`INSERT INTO coinbase_allocation_decisions(id,account_id,allocation_id,kind,evidence_hash,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[id,review.accountId,review.allocationId,kind,input.evidence,JSON.stringify(details),now]);
    if(input.action==='reconcile'||input.action==='release'){
     if(input.action==='release'&&review.changes.length)throw Error('Review account changes before releasing this Take.');
     const changes=input.action==='reconcile'?review.changes:(await readCoinbaseClaims(tx,review.accountId)).filter(c=>c.allocationId===review.allocationId&&amount(c.quantity)>0n).map(c=>({allocationId:c.allocationId,asset:c.asset,before:c.quantity,after:'0'}));
     if(!changes.length)throw Error('No allocation changes to apply.');
     await audit(input.action,changes);
     for(const change of changes){const delta=amount(change.before)-amount(change.after);if(delta===0n)continue;
      await tx.query(`INSERT INTO coinbase_allocation_entries(id,allocation_id,account_id,asset,quantity,cause,request_hash,kind,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,'release',$8) ON CONFLICT DO NOTHING`,[randomUUID(),change.allocationId,review.accountId,change.asset,'-'+format(delta),`lifecycle:${input.action}:${id}`,input.evidence,now]);
     }
    }else if(input.action==='adopt'){
     if(!(await tx.query('SELECT 1 FROM strategies s JOIN strategy_versions v ON v.id=s.current_version_id WHERE v.id=$1 AND v.source_proposal_id=s.draft_revision_id',[review.currentVersionId])).rows.length)throw Error('Commit the latest Take changes first.');
     if(review.versionId===review.currentVersionId)throw Error('This version is already in use.');
     if(review.archived||review.changes.length)throw Error('Restore and reconcile the Take before adopting changes.');
     const target=(await tx.query<{spec:unknown}>('SELECT spec FROM strategy_versions WHERE id=$1',[review.currentVersionId])).rows[0];
     const isMixed=(await tx.query('SELECT 1 FROM mixed_take_executions WHERE take_id=$1 LIMIT 1',[input.takeId])).rows.length>0;
     if(isMixed)await adoptMixedVersion(tx,input.takeId,review.versionId,review.currentVersionId);
     else if(basketSchema.parse(target.spec).target.weights.some(w=>w.instrument.venue!=='coinbase'))throw Error('Close the current investment before changing its platforms.');
     await audit('adopt',{fromVersion:review.versionId,toVersion:review.currentVersionId,driftEnabled:review.canEnableDrift});
     await tx.query('UPDATE coinbase_allocations SET version_id=$2,drift_enabled=$3 WHERE id=$1',[review.allocationId,review.currentVersionId,review.canEnableDrift]);
     await tx.query("UPDATE coinbase_order_reviews SET state='expired' WHERE allocation_id=$1 AND state='preview'",[review.allocationId]);
     await tx.query("UPDATE coinbase_rebalance_runs SET state='completed',updated_at=$2 WHERE allocation_id=$1 AND state<>'completed'",[review.allocationId,now]);
    }else{
     if(input.action==='enable_drift'&&(!review.canEnableDrift||review.archived||review.changes.length||review.versionId!==review.currentVersionId))throw Error('A reconciled current version with drift limits is required.');
     await audit('drift',{enabled:input.action==='enable_drift'});
     if(input.action==='disable_drift')await tx.query("UPDATE coinbase_rebalance_runs SET state='completed',updated_at=$2 WHERE allocation_id=$1 AND trigger='drift' AND review_id IS NULL AND state='pending'",[review.allocationId,now]);
     await tx.query('UPDATE coinbase_allocations SET drift_enabled=$2 WHERE id=$1',[review.allocationId,input.action==='enable_drift']);
    }
    return state(tx,input.takeId);
   }));
  },
 };
}
