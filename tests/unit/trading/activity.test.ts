import {afterEach,expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createOrderActivity,syncOrderActivity} from '../../../src/main/trading/activity';
import {createNotifications} from '../../../src/main/notifications';
const databases:PGlite[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.close();});
async function fixture(){
 const db=new PGlite();databases.push(db);await migrate(db);
 const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id")).rows[0].id;
 const accounts:string[]=[];
 for(const name of ['Agentic','Second'])accounts.push((await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,nickname) VALUES($1,$2,'synthetic',$2) RETURNING id",[connection,name])).rows[0].id);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const insert=async(accountId=accounts[0],status='placed')=>{const id=randomUUID();await db.query(`INSERT INTO order_intents(id,account_id,asset_class,status,ref_id,order_request,provider_order_ref,reviewed_at,expires_at,updated_at) VALUES($1,$2,'equity',$3,$4,$5,$6,now(),now()+interval '1 minute',now())`,[id,accountId,status,randomUUID(),JSON.stringify({symbol:'VTI',side:'buy',type:'market',dollar_amount:'10'}),status==='placed'?'same-provider-ref':null]);return id;};
 return {db,database,accounts,insert,service:createOrderActivity(database)};
}
test('order updates remain account scoped, durable and deduplicated after service restart',async()=>{
 const f=await fixture();await f.insert();await f.insert(f.accounts[1]);
 await f.service.sync();await createOrderActivity(f.database).sync();
 expect(await f.service.list(f.accounts[0])).toHaveLength(1);expect(await f.service.list(f.accounts[1])).toHaveLength(1);
 expect((await f.service.list(f.accounts[0]))[0]).toMatchObject({venue:'robinhood',accountLabel:'Agentic',takeTitle:null,notional:'10',currency:'USD',execution:{state:'accepted'}});
 expect((await f.db.query('SELECT * FROM notifications')).rows).toHaveLength(2);
});
test('uncertain, accepted, partial, filled and recurring uncertainty each preserve observed history',async()=>{
 const f=await fixture(),id=await f.insert(f.accounts[0],'placement_unknown');
 await f.service.sync();
 await f.db.query("UPDATE order_intents SET status='placed',provider_order_ref='same-provider-ref' WHERE id=$1",[id]);await f.service.sync();
 await f.db.query("INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','same-provider-ref','equity','partially_filled',false,'{}',now(),now())",[f.accounts[0]]);await f.service.sync();
 await f.db.query("UPDATE account_orders SET state='filled',terminal=true");await f.service.sync();
 expect((await f.service.list(f.accounts[0])).map(e=>e.execution.state)).toEqual(['filled','partially_filled','accepted','unknown']);
 expect((await f.db.query("SELECT * FROM notifications WHERE resolved_at IS NULL AND (payload->>'requiresAction')::boolean")).rows).toHaveLength(0);
 await f.db.query("UPDATE account_orders SET state='unrecognized'");await f.service.sync();await f.service.sync();
 expect((await f.service.list(f.accounts[0])).map(e=>e.execution.state)).toEqual(['unknown','filled','partially_filled','accepted','unknown']);
 expect((await f.db.query("SELECT * FROM notifications WHERE resolved_at IS NULL AND (payload->>'requiresAction')::boolean")).rows).toHaveLength(1);
});
test('notification links resolve to the latest exact order even when an older event is resolved',async()=>{
 const f=await fixture();await f.insert();await f.service.sync();
 const notification=(await f.db.query<{id:string}>('SELECT id FROM notifications')).rows[0].id;
 await f.db.query("INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','same-provider-ref','equity','canceled',true,'{}',now(),now())",[f.accounts[0]]);await f.service.sync();
 const notices=createNotifications(f.database,{deliver:()=>{},openDesktop:()=>{},badge:()=>{}});
 expect(await notices.target(notification)).toMatchObject({type:'order',order:{accountId:f.accounts[0],execution:{state:'cancelled'}}});await notices.stop();
});
test('recovery records existing orders quietly and ignores unsent expired reviews',async()=>{
 const f=await fixture();await f.insert();await f.insert(f.accounts[1],'expired');await syncOrderActivity(f.db,Date.now(),true);
 const alerts:unknown[]=[];const notices=createNotifications(f.database,{deliver:a=>alerts.push(a),openDesktop:()=>{},badge:()=>{}});
 await notices.tick();expect(alerts).toHaveLength(0);expect(await f.service.list(f.accounts[0])).toHaveLength(1);expect(await f.service.list(f.accounts[1])).toHaveLength(0);await notices.stop();
});

test('abandoning an uncertain Robinhood order resolves attention without claiming cancellation',async()=>{
 const f=await fixture(),id=await f.insert(f.accounts[0],'placement_unknown');await f.service.sync();
 await f.db.query("UPDATE order_intents SET status='abandoned' WHERE id=$1",[id]);await f.service.sync();
 expect((await f.service.list(f.accounts[0])).map(e=>e.execution.state)).toEqual(['unknown']);
 expect((await f.db.query("SELECT * FROM notifications WHERE resolved_at IS NULL")).rows).toHaveLength(0);
});


test('filled order receipts use execution value and older matching notifications gain amounts',async()=>{
 const f=await fixture();await f.insert();await f.service.sync();
 await f.db.query("INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','same-provider-ref','equity','filled',true,$2,now(),now())",[f.accounts[0],JSON.stringify({cumulativeQuantity:'0.1',averagePrice:'99'})]);
 await f.service.sync();
 expect((await f.service.list(f.accounts[0]))[0]).toMatchObject({filledQuantity:'0.1',filledNotional:'9.9'});
 const notices=createNotifications(f.database,{deliver:()=>{},openDesktop:()=>{},badge:()=>{}});
 expect((await notices.list()).items[0].title).toBe('Bought 0.1 VTI · $9.90');
 await notices.stop();
});


test('crypto notifications use saved review symbols and repair legacy null labels without duplicate delivery',async()=>{
 const f=await fixture(),id=await f.insert(f.accounts[0],'rejected');
 await f.db.query(`UPDATE order_intents SET asset_class='crypto',maximum_debit=5.01,order_request=$2,review_result=$3 WHERE id=$1`,[id,JSON.stringify({currency_pair_id:'synthetic-btc',side:'buy',type:'limit',dollar_amount:'5',limit_price:'90000'}),JSON.stringify({symbol:'BTC-USD'})]);
 await f.service.sync();
 expect((await f.service.list(f.accounts[0]))[0].symbol).toBe('BTC-USD');
 await f.db.query(`UPDATE order_activity SET payload=jsonb_set(payload,'{symbol}','null'::jsonb)`);
 await f.db.query(`UPDATE notifications SET payload=jsonb_set(jsonb_set(payload,'{order,symbol}','null'::jsonb),'{title}','"Buying $5.00 of null · Rejected"'::jsonb),seen=true`);
 const before=(await f.db.query('SELECT id,seen,delivery FROM notifications')).rows;
 await f.service.sync();await f.service.sync();
 expect(await f.service.list(f.accounts[0])).toHaveLength(1);
 expect((await f.service.list(f.accounts[0]))[0].symbol).toBe('BTC-USD');
 expect((await f.db.query('SELECT id,seen,delivery FROM notifications')).rows).toEqual(before);
 expect((await f.db.query<{payload:any}>('SELECT payload FROM notifications')).rows[0].payload.title).toBe('Buying $5.00 of BTC-USD · Rejected');
});
