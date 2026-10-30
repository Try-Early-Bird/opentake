// Venue columns reference `venues` instead of listing venues in a CHECK, so a new
// venue is one INSERT. Synthetic database only.
import {afterEach,expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate,migrations} from '../../../src/main/migrations';
const dbs:PGlite[]=[];afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});
const tables=['strategy_account_routes','order_activity','mixed_take_execution_legs'];

test('the three venue tables reference venues and keep no venue CHECK',async()=>{
 const db=new PGlite();dbs.push(db);await migrate(db);
 for(const table of tables){
  const constraints=(await db.query<{contype:string;def:string}>(`SELECT contype,pg_get_constraintdef(oid) AS def FROM pg_constraint
   WHERE conrelid=$1::regclass AND contype IN ('c','f') AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=$1::regclass AND attname='venue')]`,[table])).rows;
  expect(constraints,table).toEqual([{contype:'f',def:'FOREIGN KEY (venue) REFERENCES venues(id)'}]);
 }
});

test('the two venues are accepted as before; a venue outside the table is refused until it is inserted',async()=>{
 const db=new PGlite();dbs.push(db);await migrate(db);
 const row=(venue:string)=>db.query("INSERT INTO order_activity(id,venue,account_id,order_id,signature,payload) VALUES($1,$2,$3,$4,'s','{}')",[randomUUID(),venue,randomUUID(),randomUUID()]);
 await row('coinbase');await row('robinhood');
 await expect(row('kraken')).rejects.toThrow(/foreign key/);
 await db.query("INSERT INTO venues(id) VALUES('kraken')");
 await row('kraken');
 expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM order_activity')).rows[0].n).toBe(3);
});

test('existing rows survive the upgrade from the CHECK to the reference',async()=>{
 const db=new PGlite();dbs.push(db);
 await migrate(db,migrations.filter(m=>m.version<118));
 const id=randomUUID();
 await db.query("INSERT INTO order_activity(id,venue,account_id,order_id,signature,payload) VALUES($1,'robinhood',$2,$3,'s','{}')",[id,randomUUID(),randomUUID()]);
 await migrate(db);
 expect((await db.query<{venue:string}>('SELECT venue FROM order_activity WHERE id=$1',[id])).rows).toEqual([{venue:'robinhood'}]);
});
