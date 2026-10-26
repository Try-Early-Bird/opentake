import {z} from 'zod';
import type {createDatabaseLifecycle} from '../database';
import {coinbaseAccountConfigSchema,defaultCoinbaseAccountConfig,readCoinbaseAccountConfig,type CoinbaseAccountSourceSetting} from '../../shared/coinbase-field-mappings';
export function createCoinbaseAccountSettings(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>){
 async function load(accountId:string):Promise<CoinbaseAccountSourceSetting>{
  z.uuid().parse(accountId);
  return database.use(db=>db.transaction(async tx=>{
   const account=await tx.query(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners o ON o.id=c.owner_id WHERE a.id=$1 AND c.venue='coinbase' AND c.status<>'disconnected' FOR UPDATE OF a`,[accountId]);
   if(!account.rows.length)throw Error('Coinbase account unavailable');
   await tx.query('INSERT INTO coinbase_account_source_settings(account_id,revision,config) VALUES($1,1,$2) ON CONFLICT DO NOTHING',[accountId,JSON.stringify(defaultCoinbaseAccountConfig)]);
   const row=(await tx.query<{accountId:string;revision:number;config:unknown}>('SELECT account_id AS "accountId",revision,config FROM coinbase_account_source_settings WHERE account_id=$1',[accountId])).rows[0];
   // An unreadable row must not stop background sync: collect with the defaults and flag it until the member saves.
   const {config,unreadable}=readCoinbaseAccountConfig(row.config);
   return {accountId:row.accountId,revision:row.revision,config,...(unreadable?{unreadable:true as const}:{})};
  }));
 }
 return {
  load,
  async save(raw:unknown){
   const input=z.object({accountId:z.uuid(),revision:z.number().int().positive(),config:coinbaseAccountConfigSchema}).strict().parse(raw);
   await load(input.accountId);
   await database.use(async db=>{const changed=await db.query('UPDATE coinbase_account_source_settings SET config=$3,revision=revision+1 WHERE account_id=$1 AND revision=$2 RETURNING account_id',[input.accountId,input.revision,JSON.stringify(input.config)]);if(!changed.rows.length)throw Error('Source changed; reload before saving');});
   return load(input.accountId);
  },
 };
}
