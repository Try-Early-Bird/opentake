import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {defaultCoinbasePriceMappings} from '../../../shared/coinbase-field-mappings';
import {previewPriceMapping} from './price-mapping-preview';
import type {WebsocketMessages} from '../../../shared/websocket-sources';
import { z } from 'zod';
import { coinbaseSourceId, defaultCoinbaseSourceConfig } from '../../../shared/coinbase-source';
import type { createDatabaseLifecycle } from '../../database';
import { websocketSourceConfig, type WebsocketSource } from '../websocket/adapter';
/** Provider configuration shares the versioned source tables. The protocol adapter
 * stays Coinbase-specific; it must never create a second generic socket. */
export function createCoinbaseSourceSettings(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>){
 let current:WebsocketSource|undefined;
 const validated=new Map<string,number>();
 const key=(config:unknown)=>createHash('sha256').update(JSON.stringify(config)).digest('hex');
 let pending:Promise<unknown>=Promise.resolve();
 const serial=<T>(work:()=>Promise<T>):Promise<T>=>{const result=pending.then(work);pending=result.catch(()=>{});return result;};
 async function read(){
  return database.use(db=>db.transaction(async tx=>{
   const owners=(await tx.query<{id:string}>('SELECT id FROM local_owners LIMIT 2 FOR UPDATE')).rows;
   if(owners.length!==1)throw Error('Source owner unavailable');
   const ownerId=owners[0].id;
   let row=(await tx.query<WebsocketSource>(`SELECT s.id,s.owner_id AS "ownerId",s.current_revision AS revision,s.enabled,s.validated,r.config FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision WHERE s.id=$1 AND s.owner_id=$2`,[coinbaseSourceId,ownerId])).rows[0];
   if(!row){
    const config=websocketSourceConfig.parse(defaultCoinbaseSourceConfig);
    await tx.query('INSERT INTO data_sources(id,owner_id,current_revision,enabled,validated) VALUES($1,$2,1,true,true)',[coinbaseSourceId,ownerId]);
    await tx.query('INSERT INTO data_source_revisions(source_id,revision,config) VALUES($1,1,$2)',[coinbaseSourceId,JSON.stringify(config)]);
    row={id:coinbaseSourceId,ownerId,revision:1,enabled:true,validated:true,config};
   }
   websocketSourceConfig.parse(row.config);
   if(!row.config.provider)throw Error('Coinbase source configuration unavailable');
   current=row;return structuredClone(row);
  }));
 }
 return {
  load:()=>serial(read),
  preview(raw:unknown,messages:WebsocketMessages){const config=websocketSourceConfig.parse(raw);if(!config.provider)throw Error('Coinbase source required');const result=previewPriceMapping(messages,config.provider.priceMappings);if(validated.size>=128)validated.clear();validated.set(key(config.provider.priceMappings),Date.now()+300000);return result;},
  get(){if(!current)throw Error('Coinbase source not loaded');return structuredClone(current);},
  save(raw:unknown){return serial(async()=>{
   const input=z.object({revision:z.number().int().positive(),config:websocketSourceConfig}).strict().parse(raw);
   if(!input.config.provider)throw Error('Coinbase provider configuration required');
   const source=await read();
   if(!isDeepStrictEqual(input.config.provider.priceMappings,source.config.provider?.priceMappings??defaultCoinbasePriceMappings)&&!isDeepStrictEqual(input.config.provider.priceMappings,defaultCoinbasePriceMappings)&&(validated.get(key(input.config.provider.priceMappings))??0)<Date.now())throw Error('Preview the changed price mappings before saving');
   // Pure policy edits retain the fixed provider protocol validation. No network
   // probe, credentials or account refresh is needed to change subscription demand.
   await database.use(db=>db.transaction(async tx=>{
    await tx.query('SELECT id FROM local_owners WHERE id=$1 FOR UPDATE',[source.ownerId]);
    const next=input.revision+1;
    const changed=await tx.query('UPDATE data_sources SET current_revision=$4,enabled=$5,validated=true WHERE owner_id=$1 AND id=$2 AND current_revision=$3 RETURNING id',[source.ownerId,source.id,input.revision,next,input.config.collection!=='off']);
    if(!changed.rows.length)throw Error('Source changed; reload before saving');
    await tx.query('INSERT INTO data_source_revisions(source_id,revision,config) VALUES($1,$2,$3)',[source.id,next,JSON.stringify(input.config)]);
    await tx.query('DELETE FROM data_source_latest WHERE source_id=$1',[source.id]);
   }));
   return read();
  });},
 };
}
