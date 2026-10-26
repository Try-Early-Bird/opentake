import {afterEach,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,prepareRestoredDatabase} from '../../src/main/migrations';
import {createCoinbaseAllocations} from '../../src/main/coinbase/allocations';
const databases:PGlite[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.close();});
async function fixture(){
 const db=new PGlite();databases.push(db);await migrate(db);let clock=Date.parse('2026-10-10T12:00:00Z');
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)},service=createCoinbaseAllocations(database,()=>clock);
 const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
 const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) VALUES($1,'coinbase','connected','synthetic') RETURNING id",[owner])).rows[0].id;
 const accounts=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,available) VALUES($1,'a','A',true),($1,'b','B',true) RETURNING id",[connection])).rows.map(r=>r.id);
 async function balances(accountId=accounts[0],usdc='1000'){
  const history={state:'complete',reason:null,walletCount:3,completedWallets:3,transactions:[],wallets:[{wallet:'usd',asset:'USD',balance:'1000',available:'1000',held:'0'},{wallet:'usdc',asset:'USDC',balance:usdc,available:usdc,held:'0'},{wallet:'btc',asset:'BTC',balance:'0',available:'0',held:'0'}]};
  await db.query(`INSERT INTO coinbase_transaction_history(account_id,checked_at,state,data) VALUES($1,$2,'complete',$3) ON CONFLICT(account_id) DO UPDATE SET checked_at=excluded.checked_at,data=excluded.data`,[accountId,new Date(clock).toISOString(),JSON.stringify(history)]);
 }
 await balances();await balances(accounts[1]);
 async function fund(quantity='500',accountId=accounts[0]){
  const strategyId=randomUUID(),versionId=randomUUID(),allocationId=randomUUID();
  await db.query('INSERT INTO strategies(id,owner_id) VALUES($1,$2)',[strategyId,owner]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) VALUES($1,$2,$3,1,1,'{}',$4,'{}','{}')`,[versionId,strategyId,owner,JSON.stringify({schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}})]);
  await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategyId,versionId]);
  await db.query('INSERT INTO strategy_account_plans(strategy_id,revision) VALUES($1,$2)',[strategyId,randomUUID()]);
  await db.query("INSERT INTO strategy_account_routes(strategy_id,venue,account_id) VALUES($1,'coinbase',$2)",[strategyId,accountId]);
  const input={accountId,allocationId,strategyId,versionId,asset:'USDC',quantity,cause:'initial'};
  await service.fund(input);return input;
 }
 async function prepare(allocationId:string,quantity='202'){
  return service.prepareOrder({accountId:accounts[0],allocationId,product:'BTC-USDC',side:'buy',maxBase:'0.004',debits:[{asset:'USDC',quantity}],cause:'reviewed-order'});
 }
 async function order(clientRef:string,options:{accountId?:string;product?:string;filled?:string;fee?:string;terminal?:boolean}={}){
  const accountId=options.accountId??accounts[0],product=options.product??'BTC-USDC';
  const data={providerOrderRef:'provider-order',clientOrderRef:clientRef,productId:product,side:'buy',sourceCreatedAt:new Date(clock+1000).toISOString(),filledQuantity:options.filled??'0.004',feeAmount:options.fee??'0.2',terminal:options.terminal??true};
  await db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen)
   VALUES($1,'coinbase','provider-order','crypto','filled',$2,$3,$4,$4) ON CONFLICT(account_id,provider,provider_ref) DO UPDATE SET data=excluded.data,terminal=excluded.terminal`,[accountId,data.terminal,JSON.stringify(data),new Date(clock).toISOString()]);
 }
 async function fill(id:string,quote='100',fee='0.1',accountId=accounts[0]){
  const data={providerExecutionRef:id,tradeRef:id,orderRef:'provider-order',productId:'BTC-USDC',instrumentRef:'coinbase:BTC',symbol:'BTC',currency:'USDC',side:'buy',quantity:String(Number(quote)/50000),price:'50000',notionalAmount:quote,feeAmount:fee,feeCurrency:'USDC',commissionTotal:null,sourceSize:quote,sizeInQuote:true,occurredAt:new Date(clock+2000).toISOString(),sequenceAt:new Date(clock+2000).toISOString(),assetClass:'crypto',origin:'unknown'};
  await db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at,attribution_state) VALUES($1,'coinbase',$2,'provider-order','crypto',$3,$4,'deferred')`,[accountId,id,JSON.stringify(data),data.occurredAt]);
 }
 return {db,database,service,accounts,fund,prepare,order,fill,balances,advance:(ms:number)=>{clock+=ms;},clock:()=>clock};
}
const own=(snapshot:Awaited<ReturnType<ReturnType<typeof createCoinbaseAllocations>['snapshot']>>,allocationId:string,asset:string)=>snapshot.claims.find(c=>c.allocationId===allocationId&&c.asset===asset);
test('funding and reservations survive restart and reject duplicate causes with changed amounts',async()=>{
 const f=await fixture(),a=await f.fund('400'),b=await f.fund('300');
 await f.service.fund({...a});
 await expect(f.service.fund({...a,quantity:'401'})).rejects.toThrow('Idempotency');
 const order=await f.prepare(a.allocationId);
 expect(await f.prepare(a.allocationId)).toEqual(order);
 await expect(f.prepare(a.allocationId,'203')).rejects.toThrow('Idempotency');
 const restarted=createCoinbaseAllocations(f.database,f.clock),snapshot=await restarted.snapshot(f.accounts[0]);
 expect(Number(own(snapshot,a.allocationId,'USDC')?.quantity)).toBe(400);expect(Number(own(snapshot,a.allocationId,'USDC')?.reserved)).toBe(202);
 expect(Number(own(snapshot,b.allocationId,'USDC')?.reserved)).toBe(0);
 await expect(f.service.release({accountId:f.accounts[0],allocationId:a.allocationId,asset:'USDC',quantity:'199',cause:'release'})).rejects.toThrow('unreserved');
 expect((await f.service.snapshot(f.accounts[1])).claims).toHaveLength(0);
});
test('partial fills atomically consume reservations; missing fills prevent terminal release; replay is safe',async()=>{
 const f=await fixture(),a=await f.fund(),prepared=await f.prepare(a.allocationId);
 await f.order(prepared.clientRef);await f.fill('first');await f.service.reconcile(f.accounts[0]);
 let snapshot=await f.service.snapshot(f.accounts[0]);
 expect(Number(own(snapshot,a.allocationId,'USDC')?.quantity)).toBe(399.9);expect(Number(own(snapshot,a.allocationId,'USDC')?.reserved)).toBe(101.9);expect(snapshot.orders[0].state).toBe('bound');
 await f.fill('second');await createCoinbaseAllocations(f.database,f.clock).reconcile(f.accounts[0]);await f.service.reconcile(f.accounts[0]);
 snapshot=await f.service.snapshot(f.accounts[0]);expect(Number(own(snapshot,a.allocationId,'USDC')?.quantity)).toBe(299.8);expect(Number(own(snapshot,a.allocationId,'BTC')?.quantity)).toBe(0.004);expect(Number(own(snapshot,a.allocationId,'USDC')?.reserved)).toBe(0);expect(snapshot.orders[0].state).toBe('closed');
 expect((await f.db.query('SELECT * FROM coinbase_allocation_entries')).rows).toHaveLength(5);
 await expect(f.db.query('UPDATE coinbase_allocation_entries SET quantity=0')).rejects.toThrow('append-only');
});
test('currency budget overrun rolls back all fill effects and blocks further funding',async()=>{
 const f=await fixture(),a=await f.fund(),prepared=await f.prepare(a.allocationId,'100');
 await f.order(prepared.clientRef,{filled:'0.002',fee:'0.1'});await f.fill('first');await f.service.reconcile(f.accounts[0]);
 const snapshot=await f.service.snapshot(f.accounts[0]);expect(snapshot.orders[0].state).toBe('reconciliation_required');expect(Number(own(snapshot,a.allocationId,'USDC')?.quantity)).toBe(500);expect(Number(own(snapshot,a.allocationId,'USDC')?.reserved)).toBe(100);
 expect((await f.db.query('SELECT attribution_state FROM account_executions')).rows).toEqual([{attribution_state:'deferred'}]);
 await expect(f.service.fund({...a,cause:'more',quantity:'1'})).rejects.toThrow();
});
test('another account or a symbol match cannot bind; mismatched explicit client reference blocks',async()=>{
 const f=await fixture(),a=await f.fund(),prepared=await f.prepare(a.allocationId);
 await f.order(prepared.clientRef,{accountId:f.accounts[1]});await f.fill('other','100','0.1',f.accounts[1]);await f.service.reconcile(f.accounts[0]);
 expect((await f.service.snapshot(f.accounts[0])).orders[0].state).toBe('prepared');
 await f.order(randomUUID());await f.service.reconcile(f.accounts[0]);expect((await f.service.snapshot(f.accounts[0])).orders[0].state).toBe('prepared');
 await f.order(prepared.clientRef,{product:'ETH-USDC'});await f.service.reconcile(f.accounts[0]);expect((await f.service.snapshot(f.accounts[0])).orders[0].state).toBe('reconciliation_required');
});
test('cancelled empty orders release reservations but late fills cannot silently spend released capital',async()=>{
 const f=await fixture(),a=await f.fund(),prepared=await f.prepare(a.allocationId);
 await f.order(prepared.clientRef,{filled:'0',fee:'0'});await f.service.reconcile(f.accounts[0]);
 expect(Number(own(await f.service.snapshot(f.accounts[0]),a.allocationId,'USDC')?.reserved)).toBe(0);
 await f.fill('late');await f.service.reconcile(f.accounts[0]);
 const snapshot=await f.service.snapshot(f.accounts[0]);expect(snapshot.orders[0].state).toBe('reconciliation_required');expect(Number(own(snapshot,a.allocationId,'USDC')?.quantity)).toBe(500);
});
test('stale evidence and restored allocations cannot create new reservations',async()=>{
 const f=await fixture(),a=await f.fund();f.advance(61000);await expect(f.prepare(a.allocationId)).rejects.toThrow('Fresh');
 await prepareRestoredDatabase(f.db);
 await expect(f.prepare(a.allocationId)).rejects.toThrow('Active');
 expect((await f.db.query('SELECT status,restore_required FROM coinbase_allocations')).rows).toEqual([{status:'paused',restore_required:true}]);
});
test('concurrent reservations cannot overspend and reviewed limits cannot be rewritten',async()=>{
 const f=await fixture(),a=await f.fund('300');
 const results=await Promise.allSettled(['first','second'].map(cause=>f.service.prepareOrder({accountId:f.accounts[0],allocationId:a.allocationId,product:'BTC-USDC',side:'buy',maxBase:'0.004',debits:[{asset:'USDC',quantity:'202'}],cause})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect(Number(own(await f.service.snapshot(f.accounts[0]),a.allocationId,'USDC')?.reserved)).toBe(202);
 await expect(f.db.query('UPDATE coinbase_allocation_orders SET max_base=1')).rejects.toThrow('reviewed limits');
 await expect(f.db.query('UPDATE coinbase_allocation_reservations SET maximum=999,remaining=999')).rejects.toThrow('limits');
 await expect(f.db.query('DELETE FROM coinbase_allocation_reservations')).rejects.toThrow('cannot be deleted');
});
test('wallet shortfalls and archived or changed Takes block new order reservations',async()=>{
 const f=await fixture(),a=await f.fund();
 await f.balances(f.accounts[0],'400');await expect(f.prepare(a.allocationId)).rejects.toThrow('shortfall');
 await f.balances();await f.db.query('UPDATE strategies SET archived_at=now() WHERE id=$1',[a.strategyId]);
 await expect(f.prepare(a.allocationId)).rejects.toThrow('Current committed');
 const nextVersion=randomUUID();
 await f.db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,strategy_id,owner_id,2,1,metadata,spec,provenance,verification FROM strategy_versions WHERE id=$2",[nextVersion,a.versionId]);
 await f.db.query('UPDATE strategies SET archived_at=NULL,current_version_id=$2 WHERE id=$1',[a.strategyId,nextVersion]);
 await expect(f.prepare(a.allocationId)).rejects.toThrow('Current committed');
});

test('cash-sized market buys accept better-price quantities but still enforce the cash reservation',async()=>{
 for(const budget of ['101','100']){
  const f=await fixture(),a=await f.fund();
  const prepared=await f.service.prepareOrder({accountId:f.accounts[0],allocationId:a.allocationId,product:'BTC-USDC',side:'buy',maxBase:'0.001',quoteSized:true,debits:[{asset:'USDC',quantity:budget}],cause:'market-buy'});
  await f.order(prepared.clientRef,{filled:'0.002',fee:'0.1'});await f.fill('market-fill');await f.service.reconcile(f.accounts[0]);
  const snapshot=await f.service.snapshot(f.accounts[0]);
  if(budget==='101'){expect(snapshot.orders[0].state).toBe('closed');expect(Number(own(snapshot,a.allocationId,'BTC')?.quantity)).toBe(0.002);expect(Number(own(snapshot,a.allocationId,'USDC')?.reserved)).toBe(0);}
  else{expect(snapshot.orders[0].state).toBe('reconciliation_required');expect(Number(own(snapshot,a.allocationId,'USDC')?.quantity)).toBe(500);}
 }
});
