import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createMixedPreviewStore} from '../../src/main/mixed-execution/store';
import {createMixedExecutionStore} from '../../src/main/mixed-execution/execution-store';
import type {MixedPreview} from '../../src/shared/mixed-execution';
test('both ledger reservations roll back on failure; retries retain the same child identities',async()=>{
 const db=new PGlite();try{
  await migrate(db);
  const take=randomUUID(),strategy=randomUUID(),version=randomUUID();
  await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners`,[version,strategy]);
  await db.query(`INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Synthetic','{}',$2 FROM local_owners`,[take,strategy]);
  const legs=[];
  for(const venue of ['coinbase','robinhood'] as const){
   const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,$1,'connected','synthetic' FROM local_owners RETURNING id",[venue])).rows[0].id;
   const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,available) VALUES($1,'a','Synthetic',true) RETURNING id",[connection])).rows[0].id;
   legs.push({venue,accountId:account,operationId:randomUUID()});
  }
  await db.exec('CREATE TABLE synthetic_claims(operation_id uuid PRIMARY KEY,venue text)');
  const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
  const preview:MixedPreview={id:randomUUID(),takeId:take,versionId:version,routeRevision:randomUUID(),amountUsd:'10',state:'ready',executionEnabled:true,expiresAt:new Date(Date.now()+60000).toISOString(),legs:legs.map(l=>({...l,currency:'USD',quantity:'5',state:'ready',reason:null,orders:[],retainedCash:'5',available:'10',evidence:'checked',expiresAt:new Date(Date.now()+60000).toISOString()}))};
  await createMixedPreviewStore(database).save(randomUUID(),'hash',preview);
  let fail=true;
  const create=()=>createMixedExecutionStore(database,{validate:async()=>{},reserve:async(tx,_preview,leg)=>{await tx.query('INSERT INTO synthetic_claims VALUES($1,$2)',[leg.operationId,leg.venue]);if(fail&&leg.venue==='robinhood')throw Error('Insufficient cash');return leg.operationId;}});
  const store=create(),id=randomUUID();
  await expect(store.fund(id,preview,legs)).rejects.toThrow('Insufficient');
  expect((await db.query('SELECT * FROM synthetic_claims')).rows).toHaveLength(0);
  expect(await store.find(id)).toBeNull();
  fail=false;const funded=await store.fund(id,preview,legs);
  expect(funded.legs.map(l=>l.state)).toEqual(['reserved','reserved']);
  const recovered=await create().fund(id,preview,legs.map(l=>({...l,operationId:randomUUID()})));
  expect(recovered).toEqual(funded);expect((await db.query('SELECT * FROM synthetic_claims')).rows).toHaveLength(2);
  expect(await store.claimDispatch(id,funded.legs[0])).toBe(true);
  expect(await create().claimDispatch(id,funded.legs[0])).toBe(false);
  for(const leg of funded.legs)await store.saveLeg(id,{...leg,state:'completed'});
  expect((await create().find(id))?.state).toBe('completed');
  await expect(store.fund(randomUUID(),preview,legs)).rejects.toThrow();
  expect((await db.query('SELECT * FROM synthetic_claims')).rows).toHaveLength(2);
 }finally{await db.close();}
});
