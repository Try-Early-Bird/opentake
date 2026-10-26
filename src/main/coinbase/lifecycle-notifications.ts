import type { DatabaseClient as PGlite } from '../database-client';
import type {NotificationInput,TakeEventKind} from '../../shared/notifications';
import {createCoinbaseLifecycle} from './lifecycle';
/** Read persisted account evidence only. Decisions and trades remain explicit. */
export async function syncCoinbaseLifecycleNotifications(db:PGlite,now:number,recovery=false){
 const service=createCoinbaseLifecycle({use:fn=>fn(db)},()=>now);
 const rows=(await db.query<{id:string;take_id:string;strategy_id:string;title:string;funded:boolean}>(`SELECT a.id,t.id AS take_id,a.strategy_id,t.title,
  EXISTS(SELECT 1 FROM coinbase_allocation_entries e WHERE e.allocation_id=a.id GROUP BY e.asset HAVING sum(e.quantity)>0) AS funded
  FROM coinbase_allocations a JOIN takes t ON t.strategy_id=a.strategy_id ORDER BY a.account_id,a.id`)).rows;
 // Keep evidence and journaling close together; never hold the queue for all Takes.
 for(let offset=0;offset<rows.length;offset+=10){
 const batch=rows.slice(offset,offset+10),views=await service.viewMany(batch.map(row=>row.take_id));
 for(const row of batch){
  const view=views[row.take_id];if(!view)continue;
  const events:{event:TakeEventKind;title:string;body:string}[]=[];
  if(row.funded&&view.archived)events.push({event:'strategy_archived',title:`You archived ${row.title}`.slice(0,120),body:'Choose what to sell, or keep the holdings in your Coinbase account.'});
  if(view.changes.some(c=>c.allocationId===row.id))events.push({event:'outside_sale',title:'Coinbase account changed',body:'Your account no longer covers this Take’s allocated assets. Review the adjustment before continuing.'});
  await db.transaction(async tx=>{
   for(const event of ['strategy_archived','outside_sale'] as const){
    const key=`coinbase-lifecycle:${row.id}:${event}:`;
    const previous=(await tx.query<{id:string;resolved_at:Date|null}>("SELECT id,resolved_at FROM notifications WHERE starts_with(payload->>'eventKey',$1) ORDER BY sequence DESC LIMIT 1",[key])).rows[0];
    const current=events.find(e=>e.event===event);
    if(!current){
     // Stale or pending evidence cannot prove an outside-account discrepancy resolved.
     if(event==='outside_sale'&&view.blocked&&row.funded)continue;
     if(previous&&!previous.resolved_at)await tx.query('UPDATE notifications SET resolved_at=$2 WHERE id=$1',[previous.id,new Date(now).toISOString()]);
    }else if(!previous||previous.resolved_at){
     const input:NotificationInput={kind:event,context:{strategyId:row.strategy_id},source:{type:'take_event',id:row.id},eventKey:key+(previous?.id??'initial'),tier:'act_now',requiresAction:true,occurredAt:new Date(now).toISOString(),title:current.title,body:current.body,takeEvent:{venue:'coinbase',event,allocationId:row.id,strategyName:row.title,symbol:null,detail:current.body}};
     await tx.query('SELECT record_local_notification($1::jsonb,$2)',[JSON.stringify(input),recovery]);
    }
   }
  });
 }
 }
}
