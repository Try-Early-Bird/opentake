import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';
import { managedPollDefaults, type ManagedPollSetting } from '../../shared/managed-polls';
const schema = z.object({accountId:z.uuid().optional(),id:z.enum(['robinhood-account-sync','coinbase-account-sync','robinhood-prices','robinhood-earnings']),collection:z.enum(['automatic','off']),intervalMs:z.number().int().min(5000).max(86400000),revision:z.number().int().nonnegative()}).strict().refine(value=>value.intervalMs >= managedPollDefaults.find(job=>job.id===value.id)!.intervalMs,'Interval is below the provider polling minimum');
export function createManagedSourceSettings(database: Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>) {
  return {
    async list(accountId?:string):Promise<ManagedPollSetting[]> {
      if(accountId){z.uuid().parse(accountId);return database.use(db=>db.transaction(async tx=>{
        const account=(await tx.query<{venue:string}>(`SELECT c.venue FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners o ON o.id=c.owner_id WHERE a.id=$1 AND c.status<>'disconnected' FOR UPDATE OF a`,[accountId])).rows[0];
        if(!account)throw Error('Account unavailable');
        for(const job of managedPollDefaults.filter(job=>job.venue===account.venue))await tx.query(`INSERT INTO account_source_settings(account_id,job_id,collection,interval_ms,revision) SELECT $1,$2,coalesce(s.collection,'automatic'),coalesce(s.interval_ms,$3),1 FROM local_owners o LEFT JOIN managed_source_settings s ON s.owner_id=o.id AND s.job_id=$2 ON CONFLICT DO NOTHING`,[accountId,job.id,job.intervalMs]);
        return (await tx.query<ManagedPollSetting>('SELECT account_id AS "accountId",job_id AS id,collection,interval_ms AS "intervalMs",revision FROM account_source_settings WHERE account_id=$1 ORDER BY job_id',[accountId])).rows;
      }));}
      return database.use(async db=>{
        const owners=(await db.query<{id:string}>('SELECT id FROM local_owners LIMIT 2')).rows;
        if(owners.length!==1)throw Error('Source owner unavailable');
        const rows=(await db.query<ManagedPollSetting>('SELECT job_id AS id,collection,interval_ms AS "intervalMs",revision FROM managed_source_settings WHERE owner_id=$1',[owners[0].id])).rows;
        return managedPollDefaults.map(job=>rows.find(row=>row.id===job.id)??{id:job.id,collection:'automatic',intervalMs:job.intervalMs,revision:0});
      });
    },
    async save(raw:unknown):Promise<ManagedPollSetting> {
      const value=schema.parse(raw);
      if(value.accountId)return database.use(db=>db.transaction(async tx=>{
        const account=(await tx.query<{venue:string}>(`SELECT c.venue FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners o ON o.id=c.owner_id WHERE a.id=$1 AND c.status<>'disconnected' FOR UPDATE OF a`,[value.accountId])).rows[0];
        if(!account||managedPollDefaults.find(job=>job.id===value.id)?.venue!==account.venue)throw Error('Account source unavailable');
        const rows=await tx.query(`UPDATE account_source_settings SET collection=$3,interval_ms=$4,revision=revision+1 WHERE account_id=$1 AND job_id=$2 AND revision=$5 RETURNING account_id`,[value.accountId,value.id,value.collection,value.intervalMs,value.revision]);
        if(!rows.rows.length)throw Error('Polling settings changed; reload before saving');
        return {...value,revision:value.revision+1};
      }));
      return database.use(db=>db.transaction(async tx=>{
        const owners=(await tx.query<{id:string}>('SELECT id FROM local_owners LIMIT 2 FOR UPDATE')).rows;
        if(owners.length!==1)throw Error('Source owner unavailable');
        const row=(await tx.query<{revision:number}>('SELECT revision FROM managed_source_settings WHERE owner_id=$1 AND job_id=$2',[owners[0].id,value.id])).rows[0];
        if((row?.revision??0)!==value.revision)throw Error('Polling settings changed; reload before saving');
        await tx.query(`INSERT INTO managed_source_settings(owner_id,job_id,collection,interval_ms,revision) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(owner_id,job_id) DO UPDATE SET collection=excluded.collection,interval_ms=excluded.interval_ms,revision=excluded.revision`,[owners[0].id,value.id,value.collection,value.intervalMs,value.revision+1]);
        return {...value,revision:value.revision+1};
      }));
    },
  };
}
