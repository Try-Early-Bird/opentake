import type { DatabaseClient as PGlite } from '../database-client';
import type {NotificationInput} from '../../shared/notifications';

/** Project persisted sync health into the existing notification journal; never reads credentials. */
export async function syncCoinbaseHealthNotifications(db:Pick<PGlite,'transaction'>,now:number,recovery=false) {
 await db.transaction(async tx=>{
  const accounts=(await tx.query<{account_id:string;connection_id:string;label:string;failure_count:number;state:string;status:string;available:boolean;maintenance_enabled:boolean}>(`
   SELECT a.id AS account_id,c.id AS connection_id,coalesce(cd.label,a.nickname,a.masked_number,'Coinbase portfolio') AS label,
    s.failure_count,s.state,c.status,a.available,c.maintenance_enabled
   FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id AND c.venue='coinbase'
   JOIN coinbase_portfolio_sync s ON s.account_id=a.id
   LEFT JOIN coinbase_connection_details cd ON cd.connection_id=c.id`)).rows;
  for(const account of accounts){
   const prefix=`coinbase_sync:${account.account_id}:`;
   const previous=(await tx.query<{id:string;event_key:string;resolved_at:Date|null}>(`SELECT id,payload->>'eventKey' AS event_key,resolved_at FROM notifications
    WHERE payload->>'kind'='account_data_stale' AND payload->'context'->>'accountId'=$1
     AND payload->'context'->>'venue'='coinbase' AND starts_with(payload->>'eventKey',$2)
    ORDER BY sequence DESC LIMIT 1`,[account.account_id,prefix])).rows[0];
   // Reauthentication already has a shared connection notice; do not duplicate it.
   const inactive=account.status!=='connected'||!account.available||!account.maintenance_enabled;
   const healthy=account.state==='completed'&&account.failure_count===0;
   if(inactive||healthy){
    if(previous&&!previous.resolved_at)await tx.query('UPDATE notifications SET resolved_at=$2 WHERE id=$1 AND resolved_at IS NULL',[previous.id,new Date(now).toISOString()]);
    continue;
   }
   // Running/interrupted retries retain an existing notice. A single failure is silent.
   if(previous&&!previous.resolved_at)continue;
   if(account.failure_count<3)continue;
   const key=prefix+(previous?.id??'initial');
   const notice:NotificationInput={kind:'account_data_stale',tier:'act_now',requiresAction:true,eventKey:key,
    context:{venue:'coinbase',connectionId:account.connection_id,accountId:account.account_id},source:{type:'connection',id:account.connection_id},
    occurredAt:new Date(now).toISOString(),title:'Coinbase account sync needs attention',
    body:`${account.label.slice(0,70)}: repeated sync attempts failed. Balances or activity may be out of date. Open Connections to check this account. Opentake will keep retrying.`};
   await tx.query('SELECT record_local_notification($1::jsonb,$2)',[JSON.stringify(notice),recovery]);
  }
 });
}
