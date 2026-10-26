import {z} from 'zod';
import type {DatabaseClient} from '../database-client';

type Query=Pick<DatabaseClient,'query'>;
export interface HeldMarketSelection {accountIds:string[];maxAgeMs:number}
const positions=z.array(z.object({symbol:z.string().nullable(),quantity:z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d+)?$/)})).max(10000);
/** Uses only completed local observations. Never refreshes accounts or acquires credentials. */
export async function heldEquityMarket(db:Query,owner:string,selection:HeldMarketSelection,symbol:string,now:number):Promise<'held'|'not-held'|'unavailable'>{
 const rows=(await db.query<{id:string;observed_at:Date|null;watermark:Date|null;discovery_complete:boolean|null;data:unknown}>(`
  SELECT a.id,o.observed_at,k.watermark,k.discovery_complete,p.data
  FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
  LEFT JOIN account_sync_checkpoints k ON k.account_id=a.id AND k.resource='equity_positions'
  LEFT JOIN LATERAL (SELECT observed_at,position_snapshot_id FROM account_observations
   WHERE account_id=a.id AND resource='equity_positions' ORDER BY observed_at DESC,id DESC LIMIT 1) o ON true
  LEFT JOIN position_snapshots p ON p.id=o.position_snapshot_id AND p.account_id=a.id AND p.asset_class='equity'
  WHERE c.owner_id=$1 AND c.venue='robinhood' AND c.status='connected' AND a.available AND a.agentic_allowed AND a.id=ANY($2::uuid[])`,[owner,selection.accountIds])).rows;
 if(rows.length!==selection.accountIds.length)return 'unavailable';
 let held=false;
 for(const row of rows){
  const observed=row.observed_at?.getTime(),checked=row.watermark?.getTime();
  if(!row.discovery_complete||observed===undefined||checked===undefined||observed>now||checked>now||now-observed>selection.maxAgeMs||now-checked>selection.maxAgeMs)return 'unavailable';
  const parsed=positions.safeParse(row.data);if(!parsed.success)return 'unavailable';
  if(parsed.data.some(p=>p.symbol===symbol&&/[1-9]/.test(p.quantity)))held=true;
 }
 return held?'held':'not-held';
}

const cryptoPositions=z.object({spotPositions:z.array(z.object({asset:z.string(),quantity:z.string().max(80).regex(/^(0|[1-9]\d*)(\.\d+)?$/),isCash:z.boolean(),currency:z.string()})).max(10000)});
/** Exact Coinbase USD products, scoped to selected local accounts and recent saved holdings. */
export async function heldCryptoMarket(db:Query,owner:string,selection:HeldMarketSelection,product:string,now:number):Promise<'held'|'not-held'|'unavailable'>{
 if(!/^[A-Z0-9._]+-USD$/.test(product)||['USD-USD','USDC-USD'].includes(product))return 'not-held';
 const rows=(await db.query<{observed_at:Date|null;data:unknown}>(`SELECT o.observed_at,o.data FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
 LEFT JOIN LATERAL (SELECT observed_at,data FROM coinbase_portfolio_observations WHERE account_id=a.id ORDER BY observed_at DESC,id DESC LIMIT 1) o ON true
 WHERE c.owner_id=$1 AND c.venue='coinbase' AND c.status='connected' AND a.available AND a.agentic_allowed AND a.id=ANY($2::uuid[])`,[owner,selection.accountIds])).rows;
 if(rows.length!==selection.accountIds.length)return 'unavailable';
 let held=false;
 for(const row of rows){
  const at=row.observed_at?.getTime(),parsed=cryptoPositions.safeParse(row.data);
  if(at===undefined||at>now||now-at>selection.maxAgeMs||!parsed.success)return 'unavailable';
  if(parsed.data.spotPositions.some(p=>p.asset+'-USD'===product&&!p.isCash&&p.currency==='USD'&&/[1-9]/.test(p.quantity)))held=true;
 }
 return held?'held':'not-held';
}
