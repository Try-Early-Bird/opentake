import type { DatabaseClient as PGlite } from '../database-client';
import {z} from 'zod';
import type {PortfolioActivityPage,PortfolioView} from '../../shared/portfolio';
import {takeNameSql,withCurrentTakeName} from '../strategies/take-name';
const cursorSchema=z.object({at:z.string().datetime({offset:true}),id:z.string().min(1).max(500)}).strict();
/** One stable cursor across fills, order updates, capital and account transfers. */
export async function readActivityPage(db:Pick<PGlite,'query'>,accountId:string,rawCursor?:unknown):Promise<PortfolioActivityPage>{
 z.uuid().parse(accountId);const cursor=rawCursor==null?null:cursorSchema.parse(rawCursor);
 const account=(await db.query(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners o ON o.id=c.owner_id WHERE a.id=$1`,[accountId])).rows[0];
 if(!account)throw Error('Account unavailable');
 const rows=(await db.query<{id:string;at:string;kind:string;data:unknown}>(`
 WITH capital AS (
 SELECT e.id,e.occurred_at,r.kind,e.asset,abs(e.quantity)::text AS quantity,r.take_id,coalesce(${takeNameSql('r.take_id')},r.take_title) AS take_title
 FROM coinbase_capital_reviews r JOIN coinbase_allocation_entries e ON e.account_id=r.account_id
 AND e.allocation_id=(r.input->>'allocationId')::uuid AND e.cause=(CASE WHEN r.kind='assign' THEN 'capital:' ELSE 'release:' END)||(r.input->>'cause')
 WHERE r.account_id=$1 AND r.state='confirmed' AND e.kind IN ('capital','release')
 UNION ALL
 SELECT e.id,e.occurred_at,'release',e.asset,abs(e.quantity)::text,i.take_id,coalesce(${takeNameSql('i.take_id')},t.title)
 FROM coinbase_allocation_entries e JOIN coinbase_investments i ON e.cause LIKE 'investment-return:'||i.id::text||':%' JOIN takes t ON t.id=i.take_id
 WHERE e.account_id=$1 AND e.kind='release' AND e.quantity<0
 UNION ALL
 SELECT e.id,e.occurred_at,'release',e.asset,abs(e.quantity)::text,r.take_id,coalesce(${takeNameSql('r.take_id')},r.payload->>'takeTitle')
 FROM coinbase_allocation_entries e JOIN coinbase_order_reviews r ON e.cause='withdrawal-return:'||r.id::text
 WHERE e.account_id=$1 AND e.kind='release' AND e.quantity<0
 ), events AS (
 SELECT 'fill:'||provider||':'||provider_ref AS id,occurred_at AS at,'fill' AS kind,data FROM account_executions WHERE account_id=$1
 UNION ALL SELECT 'order:'||id::text,(payload->>'observedAt')::timestamptz,'order',${withCurrentTakeName('payload')} FROM order_activity WHERE account_id=$1
 UNION ALL SELECT 'capital:'||id::text,occurred_at,'capital',jsonb_build_object('id',id,'occurredAt',occurred_at,'kind',kind,'asset',asset,'quantity',quantity,'takeId',take_id,'takeTitle',take_title) FROM capital
 UNION ALL SELECT 'transaction:'||(t->>'id'),(t->>'occurredAt')::timestamptz,'transaction',t
 FROM coinbase_transaction_history h CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.data->'transactions','[]'::jsonb)) t
 WHERE h.account_id=$1 AND NOT (t->>'type'='advanced_trade_fill' AND t->>'orderRef' IS NOT NULL AND EXISTS(SELECT 1 FROM account_executions e WHERE e.account_id=$1 AND e.provider='coinbase' AND e.order_ref=t->>'orderRef'))
 ) SELECT id,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,kind,data FROM events
 WHERE ($2::timestamptz IS NULL OR (at,id)<($2::timestamptz,$3::text)) ORDER BY at DESC,id DESC LIMIT 51
 `,[accountId,cursor?.at??null,cursor?.id??null])).rows;
 const selected=rows.slice(0,50);
 const executions=selected.filter(r=>r.kind==='fill').map(r=>r.data as PortfolioView['executions'][number]);
 const orders=(await db.query<{data:PortfolioView['orders'][number];asset_class:string}>(`SELECT data,asset_class FROM account_orders WHERE account_id=$1 AND provider_ref=ANY($2::text[])`,[accountId,executions.map(e=>e.orderRef)])).rows.map(r=>({...r.data,assetClass:r.asset_class}));
 return {executions,orders,capitalActivity:selected.filter(r=>r.kind==='capital').map(r=>r.data as NonNullable<PortfolioView['capitalActivity']>[number]),orderActivity:selected.filter(r=>r.kind==='order').map(r=>r.data as NonNullable<PortfolioView['orderActivity']>[number]),accountTransactions:selected.filter(r=>r.kind==='transaction').map(r=>r.data as NonNullable<PortfolioView['accountTransactions']>[number]),nextCursor:rows.length>50?{at:selected[49].at,id:selected[49].id}:null};
}
