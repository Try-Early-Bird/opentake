import { readCoinbaseFundingRoom } from '../coinbase/allocations';
import { decimalToScaledInteger, scaledIntegerToDecimal } from '../allocations/decimal';
import { randomUUID } from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import type { DatabaseClient as PGlite } from '../database-client';
import type { createDatabaseLifecycle } from '../database';
import { supportsBasketExecution, hasPendingInstrumentSupport, type BasketSpec } from '../../shared/strategies';
import { investmentVenueIds } from '../../shared/investment-venues';
import { saveTakeAccountPlanSchema, type TakeAccountPlan, type TakePlanAccount, type PlannedPortfolioTake } from '../../shared/strategy-account-plan';

type Query = Pick<PGlite, 'query'>;
type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
interface Target { take_id: string; strategy_id: string; draft_revision_id: string; archived_at: Date | null; payload: {spec: BasketSpec}; funded: boolean }
const targetSql = `SELECT t.id AS take_id,s.id AS strategy_id,s.draft_revision_id,s.archived_at,p.payload,
 (EXISTS(SELECT 1 FROM strategy_allocations a WHERE a.strategy_id=s.id AND a.status IN ('active','paused','diverged')) OR EXISTS(SELECT 1 FROM coinbase_allocations ca WHERE ca.strategy_id=s.id)) AS funded
 FROM takes t JOIN strategies s ON s.id=t.strategy_id JOIN local_owners o ON o.id=s.owner_id
 JOIN strategy_proposals p ON p.id=s.draft_revision_id`;
async function target(db: Query, takeId: string): Promise<Target> {
 const row=(await db.query<Target>(targetSql+' WHERE t.id=$1',[takeId])).rows[0];
 if(!row) throw new Error('Create a Take basket before choosing accounts.');
 return row;
}
const reason = (row: Target) => hasPendingInstrumentSupport(row.payload.spec) ? 'Robinhood crypto Takes are research-only until trading support is ready.' : row.archived_at ? 'Restore this Take to change its planned accounts.' : row.funded ? 'Funded Takes keep their existing account allocations.' : supportsBasketExecution(row.payload.spec) ? 'Robinhood-only Takes choose their funding account when investing.' : null;
async function accounts(db: Query, strategyId:string): Promise<TakePlanAccount[]> {
 const rows=(await db.query<TakePlanAccount>(`SELECT a.id,c.venue,coalesce(cd.label,a.nickname,a.masked_number) AS label,
 (a.available AND c.status='connected') AS available,
 CASE WHEN NOT a.available OR c.status<>'connected' THEN 'Account disconnected'
 WHEN c.venue='coinbase' AND NOT coalesce(cd.can_trade,false) THEN 'Key can’t trade — read-only'
 WHEN c.venue='robinhood' AND NOT a.agentic_allowed THEN 'Account not eligible for trading' ELSE NULL END AS "disabledReason",
 (SELECT count(DISTINCT used.strategy_id)::int FROM (
 SELECT strategy_id FROM strategy_account_routes WHERE account_id=a.id
 UNION SELECT strategy_id FROM strategy_allocations WHERE account_id=a.id AND status IN ('active','paused','diverged')
 UNION SELECT strategy_id FROM coinbase_allocations WHERE account_id=a.id
 ) used JOIN strategies s ON s.id=used.strategy_id WHERE s.archived_at IS NULL AND s.id<>$1) AS "otherTakeCount"
 FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners o ON o.id=c.owner_id
 LEFT JOIN coinbase_connection_details cd ON cd.connection_id=c.id
 WHERE c.venue=ANY($2::text[]) AND (c.venue<>'robinhood' OR a.agentic_allowed OR EXISTS(
 SELECT 1 FROM strategy_account_routes WHERE strategy_id=$1 AND account_id=a.id) OR EXISTS(
 SELECT 1 FROM strategy_allocations WHERE strategy_id=$1 AND account_id=a.id AND status IN ('active','paused','diverged'))) ORDER BY c.venue,label,a.id`,[strategyId,investmentVenueIds])).rows;
 for(const account of rows){
  account.balances=[];
  if(!account.available)continue;
  if(account.venue==='coinbase'){
   try{account.balances=(await readCoinbaseFundingRoom(db,account.id)).filter(r=>['USD','USDC'].includes(r.asset)&&r.state==='reconciled'&&r.unclaimed!==null).map(r=>({asset:r.asset,amount:r.unclaimed!}));}catch{/* Missing or stale buying power is unavailable. */}
  }else{
   const snapshot=(await db.query<{data:{buyingPower:string|null;currency:string}}>(`SELECT p.data FROM account_observations o JOIN portfolio_snapshots p ON p.id=o.portfolio_snapshot_id
    WHERE o.account_id=$1 AND o.resource='portfolio' ORDER BY o.observed_at DESC LIMIT 1`,[account.id])).rows[0];
   if(snapshot?.data.buyingPower!==undefined&&snapshot.data.buyingPower!==null)account.balances=[{asset:snapshot.data.currency,amount:snapshot.data.buyingPower}];
  }
 }
 return rows;
}
async function read(db: Query, row: Target): Promise<TakeAccountPlan> {
 const revision=(await db.query<{revision:string}>('SELECT revision FROM strategy_account_plans WHERE strategy_id=$1',[row.strategy_id])).rows[0]?.revision??null;
 const saved=(await db.query<{venue:string;account_id:string}>('SELECT venue,account_id FROM strategy_account_routes WHERE strategy_id=$1',[row.strategy_id])).rows;
 const allocated=row.funded?(await db.query<{venue:string;account_id:string}>(`SELECT c.venue,a.account_id FROM strategy_allocations a
 JOIN linked_accounts la ON la.id=a.account_id JOIN platform_connections c ON c.id=la.connection_id
 WHERE a.strategy_id=$1 AND a.status IN ('active','paused','diverged')
 UNION SELECT 'coinbase' AS venue,account_id FROM coinbase_allocations WHERE strategy_id=$1`,[row.strategy_id])).rows:[];
 const venues=[...new Set([...row.payload.spec.target.weights.map(w=>w.instrument.venue),...allocated.map(a=>a.venue)])].sort();
 return {takeId:row.take_id,strategyId:row.strategy_id,draftRevision:row.draft_revision_id,revision,editable:reason(row)===null,reason:reason(row),accounts:await accounts(db,row.strategy_id),
  routes:venues.flatMap(venue=>{
   const existing=allocated.filter(a=>a.venue===venue);
   const ids=existing.length?existing.map(a=>a.account_id):[saved.find(r=>r.venue===venue)?.account_id??null];
   return ids.map(accountId=>({venue,accountId,assets:row.payload.spec.target.weights.filter(w=>w.instrument.venue===venue).map(w=>({symbol:w.instrument.symbol,bps:w.bps}))}));
  })};
}
/** Planning metadata only: never reserves cash, attributes a holding, selects a trading account or grants tool access. */
export function createTakeAccountPlans(database: Database) {
 return {
  read(takeId: string) { return database.use(db=>db.transaction(async tx=>read(tx,await target(tx,takeId)))); },
  save(input: unknown) {
   const request=saveTakeAccountPlanSchema.parse(input);
   return database.use(db=>db.transaction(async (tx:Transaction)=>{
    const row=await target(tx,request.takeId), blocked=reason(row);
    if(blocked) throw new Error(blocked);
    if(row.draft_revision_id!==request.draftRevision) throw new Error('This Take changed. Reload its accounts before saving.');
    const view=await read(tx,row);
    if(view.revision!==request.revision) throw new Error('Account choices changed. Reload before saving.');
    for(const route of request.routes){
     if(!view.routes.some(r=>r.venue===route.venue)) throw new Error('The selected platform is not in this Take.');
     const account=view.accounts.find(a=>a.id===route.accountId && a.venue===route.venue);
     const unchanged=view.routes.some(r=>r.venue===route.venue && r.accountId===route.accountId);
     if(!account || (!account.available && !unchanged)) throw new Error('Choose a connected account on the matching platform.');
     if(account.disabledReason && !unchanged)throw new Error(account.disabledReason);
    }
    const revision=randomUUID();
    if(request.revision===null){
     const inserted=await tx.query('INSERT INTO strategy_account_plans(strategy_id,revision) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING strategy_id',[row.strategy_id,revision]);
     if(!inserted.rows.length) throw new Error('Account choices changed. Reload before saving.');
    } else {
     const updated=await tx.query('UPDATE strategy_account_plans SET revision=$2,updated_at=now() WHERE strategy_id=$1 AND revision=$3 RETURNING strategy_id',[row.strategy_id,revision,request.revision]);
     if(!updated.rows.length) throw new Error('Account choices changed. Reload before saving.');
    }
    await tx.query('DELETE FROM strategy_account_routes WHERE strategy_id=$1',[row.strategy_id]);
    for(const route of request.routes) await tx.query('INSERT INTO strategy_account_routes(strategy_id,venue,account_id) VALUES($1,$2,$3)',[row.strategy_id,route.venue,route.accountId]);
    return read(tx,row);
   }));
  },
  forAccount(accountId: string): Promise<PlannedPortfolioTake[]> {
   return database.use(async db=>{
    const rows=(await db.query<Target & {title:string;venue:string}>(targetSql.replace('SELECT t.id', "SELECT r.venue,p.payload->'metadata'->>'title' AS title,t.id")+` JOIN strategy_account_routes r ON r.strategy_id=s.id
     JOIN linked_accounts a ON a.id=r.account_id JOIN platform_connections c ON c.id=a.connection_id
     WHERE r.account_id=$1 AND c.venue=r.venue AND c.owner_id=s.owner_id AND s.archived_at IS NULL ORDER BY t.updated_at DESC`,[accountId])).rows;
    const capital=(await db.query<{strategy_id:string;asset:string;quantity:string}>(`SELECT a.strategy_id,e.asset,sum(e.quantity)::text AS quantity
     FROM coinbase_allocations a JOIN coinbase_allocation_entries e ON e.allocation_id=a.id WHERE a.account_id=$1
     GROUP BY a.strategy_id,e.asset HAVING sum(e.quantity)>0`,[accountId])).rows;
    // Resolve the title from the same current draft as the route's asset list.
    return rows.flatMap(row=>{
     if(supportsBasketExecution(row.payload.spec)) return [];
     const assigned=capital.filter(c=>c.strategy_id===row.strategy_id).map(c=>({asset:c.asset,quantity:scaledIntegerToDecimal(decimalToScaledInteger(c.quantity,36),36)}));
     if(row.funded&&row.venue!=='coinbase')return [];
     const assets=row.payload.spec.target.weights.filter(w=>w.instrument.venue===row.venue).map(w=>({symbol:w.instrument.symbol,bps:w.bps}));
     return assets.length ? [{takeId:row.take_id,strategyId:row.strategy_id,title:row.title,venue:row.venue,assets,...(assigned.length?{capital:assigned}:{})}] : [];
    });
   });
  },
 };
}
