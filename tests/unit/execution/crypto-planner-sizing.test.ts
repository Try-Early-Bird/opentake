import {createAllocationInstructions} from '../../../src/main/execution/instructions';
import {append,instruction} from '../../../src/main/allocations/ledger';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {expect,test,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createPlanner} from '../../../src/main/execution/planner';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {marketKey} from '../../../src/shared/search';
import {cryptoBuyMaximumDebit} from '../../../src/main/orders/crypto-transport';
// Exercise the gated planner with synthetic records only. Production gates remain unchanged.
vi.mock('../../../src/main/mixed-execution/basket',()=>({executionBasket:async(_db:unknown,spec:unknown)=>spec}));
vi.mock('../../../src/shared/strategies',async original=>({...await original<typeof import('../../../src/shared/strategies')>(),assertBasketExecution:()=>{}}));
test('crypto planner uses persisted pair sizing and emits funded market legs without equity quotes',async()=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 try{
  const now=Date.parse('2026-10-15T15:00:00Z'),at=new Date(now).toISOString();
  const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
  const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'test','test',true,true) RETURNING id`,[connection])).rows[0].id;
  const strategy=randomUUID(),version=randomUUID();
  const spec={schemaVersion:1,kind:'basket',target:{weights:['BTC','ETH'].map(symbol=>({instrument:{venue:'robinhood',symbol:symbol+'-USD',market:{venue:'robinhood',instance:'production',kind:'crypto',reference:symbol.toLowerCase()}},bps:5000})),cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
  await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,[version,strategy,JSON.stringify(spec)]);
  await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
  const sync=createAccountSync(database as any,{status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,selected:true,agenticAllowed:true}]}),readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1000',cash:'1000',buying_power:'1000'}:{results:[]}} as any,()=>now);
  await sync.synchronize();sync.cancel();
  const core=createAllocationCore(database,()=>now);
  const invested=await core.invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'100',cause:'synthetic'});
  const data=spec.target.weights.map(w=>({instrumentRef:marketKey({identity:w.instrument.market}),symbol:w.instrument.symbol,quantity:'0',markPrice:'100',marketValue:'0',priceObservedAt:at,providerPayload:{cryptoSizing:{quantityIncrement:'0.00000001',minimumQuantity:'0.00001',maximumQuantity:'100',minimumNotional:'1'}}}));
  const run=randomUUID(),snapshot=randomUUID();
  await db.query(`INSERT INTO account_sync_runs(id,account_id,resource,state,started_at,finished_at) VALUES($1,$2,'crypto_positions','completed',$3,$3)`,[run,account,at]);
  await db.query(`INSERT INTO position_snapshots(id,account_id,asset_class,payload_hash,data) VALUES($1,$2,'crypto',$4,$3)`,[snapshot,account,JSON.stringify(data),snapshot]);
  await db.query(`INSERT INTO account_observations(id,run_id,account_id,resource,observed_at,position_snapshot_id) VALUES($1,$2,$3,'crypto_positions',$4,$5)`,[randomUUID(),run,account,at,snapshot]);
  await db.query(`INSERT INTO account_sync_checkpoints(account_id,resource,watermark) VALUES($1,'crypto_positions',$2)`,[account,at]);
  const row={allocationId:version,valuedOn:'2026-10-15',source:'live' as const,unitValue:'100',cash:'0',units:Object.fromEntries(data.map(p=>[p.instrumentRef,'0.5'])),closes:Object.fromEntries(data.map(p=>[p.instrumentRef,'100']))};
  const planner=createPlanner(database,{cryptoModel:async()=>({ready:true,baselineAt:at,rows:[row],current:row})},()=>now);
  await db.query('UPDATE position_snapshots SET data=$2 WHERE id=$1',[snapshot,JSON.stringify(data.map(p=>({...p,providerPayload:{}})))]);
  expect(await planner.planAllocation(invested.allocationId,'activation')).toMatchObject({disposition:'deferred',reasonCode:'crypto_sizing_evidence_required'});
  expect((await db.query('SELECT * FROM strategy_executions')).rows).toHaveLength(0);
  expect(await planner.preflight({accountId:account,strategyId:strategy,amount:'100'})).toMatchObject({ok:false,legs:[],reasons:expect.arrayContaining([{code:'crypto_sizing_evidence_required',symbols:[]}])});
  await db.query('UPDATE position_snapshots SET data=$2 WHERE id=$1',[snapshot,JSON.stringify(data)]);
  await db.query('UPDATE position_snapshots SET data=$2 WHERE id=$1',[snapshot,JSON.stringify(data.map(p=>({...p,providerPayload:{cryptoSizing:{...p.providerPayload.cryptoSizing,minimumNotional:'100'}}})))]);
  expect(await planner.preflight({accountId:account,strategyId:strategy,amount:'100'})).toMatchObject({ok:false,legs:[],reasons:expect.arrayContaining([{code:'incomplete_basket',symbols:[]}])});
  await db.query('UPDATE position_snapshots SET data=$2 WHERE id=$1',[snapshot,JSON.stringify(data)]);
  const firstPreview=await planner.preflight({accountId:account,strategyId:strategy,amount:'100'});
  const result=await planner.planAllocation(invested.allocationId,'activation');
  expect(result).toMatchObject({disposition:'planned'});
  const legs=(await db.query<{order_request:{currency_pair_id:string;dollar_amount:string;type:string}}>('SELECT order_request FROM strategy_executions')).rows;
  expect(firstPreview.ok).toBe(true);
  expect(firstPreview.legs.map(l=>l.notionalUsd).sort()).toEqual(legs.map(l=>l.order_request.dollar_amount).sort());
  expect(Number(firstPreview.orderReserveUsd)).toBeGreaterThan(0);
  expect(legs).toHaveLength(2);expect(legs.map(l=>l.order_request.currency_pair_id).sort()).toEqual(['btc','eth']);
  expect(legs.reduce((sum,l)=>sum+Number(cryptoBuyMaximumDebit(l.order_request.dollar_amount,'market')),0)).toBeLessThanOrEqual(100);
  // Adopt ETH-only after acquiring BTC: its removed target still has owned units.
  await db.query("UPDATE strategy_executions SET status='cancelled'");
  await db.transaction(tx=>append(tx,{allocationId:invested.allocationId,transactionId:invested.transactionId,entryType:'fill',cause:'synthetic-owned-btc',instrumentRef:data[0].instrumentRef,assetClass:'crypto',symbol:'BTC-USD',quantityDelta:'0.9',cashDelta:'-90',sourceKind:'test',sourceRef:'test',occurredAt:at},at));
  const next=randomUUID(),nextSpec={...spec,target:{weights:[{...spec.target.weights[1],bps:10000}],cashBps:0}};
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,2,1,'{}',$3,'{}','{}' FROM local_owners`,[next,strategy,JSON.stringify(nextSpec)]);
  await db.query('UPDATE strategy_allocations SET accepted_version_id=$2,applied_version_sequence=1 WHERE id=$1',[invested.allocationId,next]);
  row.allocationId=next;row.units={[data[1].instrumentRef]:'1'};row.closes={[data[1].instrumentRef]:'100'};
  expect(await planner.planAllocation(invested.allocationId,'republish')).toMatchObject({disposition:'planned'});
  const exit=(await db.query<{order_request:unknown}>("SELECT order_request FROM strategy_executions WHERE status='queued' AND side='sell'")).rows;
  expect(exit).toHaveLength(1);expect(exit[0].order_request).toMatchObject({currency_pair_id:'btc',side:'sell',quantity:'0.9'});
  const closeId=await db.transaction(tx=>instruction(tx,{allocationId:invested.allocationId,kind:'exit',cause:'test-close'},at));
  expect(await planner.planLiquidation(invested.allocationId,{kind:'liquidate',transactionId:closeId})).toMatchObject({disposition:'deferred',reasonCode:'open_execution'});
  await db.query("UPDATE strategy_executions SET status='cancelled' WHERE status='queued'");
  const redeemId=await db.transaction(tx=>instruction(tx,{allocationId:invested.allocationId,kind:'redemption',cause:'test-redemption'},at));
  expect(await planner.planLiquidation(invested.allocationId,{kind:'redeem',transactionId:redeemId,amount:'20',previewSymbols:['BTC-USD']})).toMatchObject({disposition:'planned'});
  expect((await db.query<{order_request:unknown}>("SELECT order_request FROM strategy_executions WHERE status='queued'")).rows[0].order_request).toMatchObject({currency_pair_id:'btc',side:'sell',quantity:'0.2'});
  await db.query("UPDATE strategy_executions SET status='cancelled' WHERE status='queued'");
  await db.query('UPDATE position_snapshots SET data=$2 WHERE id=$1',[snapshot,JSON.stringify(data.map(p=>({...p,providerPayload:{cryptoSizing:{...p.providerPayload.cryptoSizing,minimumNotional:'100'}}})))]);
  expect(await planner.planLiquidation(invested.allocationId,{kind:'liquidate',transactionId:closeId})).toMatchObject({disposition:'deferred',reasonCode:'crypto_dust_remaining'});
  await db.query('UPDATE position_snapshots SET data=$2 WHERE id=$1',[snapshot,JSON.stringify(data)]);
  expect(await planner.planLiquidation(invested.allocationId,{kind:'liquidate',transactionId:closeId,symbols:['BTC-USD']})).toMatchObject({disposition:'planned'});
  expect((await db.query<{order_request:unknown}>("SELECT order_request FROM strategy_executions WHERE status='queued'")).rows[0].order_request).toMatchObject({currency_pair_id:'btc',side:'sell',quantity:'0.9'});


  await db.query("UPDATE strategy_executions SET status='cancelled' WHERE status='queued'");
  const mixed=randomUUID(),mixedSpec={...spec,target:{weights:[spec.target.weights[0],{instrument:{venue:'robinhood',symbol:'BTC'},bps:5000}],cashBps:0}};
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,3,1,'{}',$3,'{}','{}' FROM local_owners`,[mixed,strategy,JSON.stringify(mixedSpec)]);
  await db.query('UPDATE strategy_allocations SET accepted_version_id=$2 WHERE id=$1',[invested.allocationId,mixed]);
  row.allocationId=mixed;row.units={[data[0].instrumentRef]:'0.5',BTC:'0.5'};row.closes={[data[0].instrumentRef]:'100',BTC:'100'};
  expect(await planner.planAllocation(invested.allocationId,'republish')).toMatchObject({disposition:'planned'});
  const mixedLegs=(await db.query<{order_request:unknown}>("SELECT order_request FROM strategy_executions WHERE status='queued' ORDER BY side DESC")).rows;
  expect(mixedLegs).toHaveLength(2);
  expect(mixedLegs[0].order_request).toMatchObject({currency_pair_id:'btc',side:'sell',quantity:'0.4'});
  expect(mixedLegs[1].order_request).toMatchObject({symbol:'BTC',side:'buy',type:'market'});

  // A crypto-only replacement must still value and sell stock left by the old version.
  await db.query("UPDATE strategy_executions SET status='cancelled' WHERE status='queued'");
  await db.transaction(tx=>append(tx,{allocationId:invested.allocationId,transactionId:invested.transactionId,entryType:'fill',cause:'synthetic-owned-stock',instrumentRef:'stock-btc',assetClass:'equity',symbol:'BTC',quantityDelta:'0.1',cashDelta:'-10',sourceKind:'test',sourceRef:'stock',occurredAt:at},at));
  await db.query('UPDATE strategy_allocations SET accepted_version_id=$2 WHERE id=$1',[invested.allocationId,next]);
  row.allocationId=next;row.units={[data[1].instrumentRef]:'1'};row.closes={[data[1].instrumentRef]:'100'};
  await db.query("UPDATE account_sync_checkpoints SET watermark=$2 WHERE account_id=$1 AND resource='equity_positions'",[account,new Date(now-3600000).toISOString()]);
  expect(await planner.planAllocation(invested.allocationId,'republish')).toMatchObject({disposition:'deferred',reasonCode:'fresh_position_snapshot_required'});
  await db.query("UPDATE account_sync_checkpoints SET watermark=$2 WHERE account_id=$1 AND resource='equity_positions'",[account,at]);
  await db.query(`UPDATE position_snapshots SET data=$2 WHERE id=(SELECT position_snapshot_id FROM account_observations WHERE account_id=$1 AND resource='equity_positions' ORDER BY observed_at DESC LIMIT 1)`,[account,JSON.stringify([{instrumentRef:'stock-btc',symbol:'BTC',quantity:'0.1',markPrice:'100',marketValue:'10'}])]);
  expect(await planner.planAllocation(invested.allocationId,'republish')).toMatchObject({disposition:'planned'});
  const removedStock=(await db.query<{order_request:unknown}>("SELECT order_request FROM strategy_executions WHERE status='queued' AND side='sell' AND order_request->>'symbol'='BTC'")).rows;
  expect(removedStock).toHaveLength(1);
  expect(removedStock[0].order_request).toMatchObject({symbol:'BTC',side:'sell',type:'market'});

  const denied=randomUUID(),verification={checkedAt:at,results:[
   {instrument:mixedSpec.target.weights[0].instrument,state:'verified',tradable:false,fractional:null},
   {instrument:mixedSpec.target.weights[1].instrument,state:'verified',tradable:true,fractional:true},
  ]};
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,4,1,'{}',$3,'{}',$4 FROM local_owners`,[denied,strategy,JSON.stringify(mixedSpec),JSON.stringify(verification)]);
  await db.query('UPDATE strategy_allocations SET accepted_version_id=$2 WHERE id=$1',[invested.allocationId,denied]);
  row.allocationId=denied;row.units={[data[0].instrumentRef]:'0.5',BTC:'0.5'};row.closes={[data[0].instrumentRef]:'100',BTC:'100'};
  const preflight=await planner.preflight({accountId:account,allocationId:invested.allocationId,amount:'100'});
  expect(preflight.reasons).toContainEqual({code:'symbol_not_tradable',symbols:['BTC-USD']});
  expect(preflight.reasons.flatMap(r=>r.symbols)).not.toContain('BTC');
  await db.query("UPDATE strategy_executions SET status='cancelled' WHERE status='queued'");
  await planner.planAllocation(invested.allocationId,'republish');
  expect((await db.query("SELECT id FROM strategy_executions WHERE status='queued' AND order_request->>'currency_pair_id'='btc'")).rows).toHaveLength(0);
  const instructions=createAllocationInstructions(database,{core,planner,executor:{} as any,clock:()=>now});
  const preview=await instructions.preflight({bucketId:invested.allocationId},'100');
  expect(preview.legs).toEqual([
   {symbol:'BTC',instrumentRef:'robinhood:BTC',venue:'robinhood',assetClass:'equity',weightPercent:50,notional:'90'},
   {symbol:'BTC-USD',instrumentRef:data[0].instrumentRef,venue:'robinhood',assetClass:'crypto',weightPercent:50,notional:'9.89'},
  ]);
  const checkedInstruments:unknown[]=[];
  const funding=createAllocationInstructions(database,{core,planner:{...planner,planAllocation:async allocationId=>({allocationId,planId:null,disposition:'deferred',reasonCode:'test',executionIds:[],sleeves:[]})},executor:{} as any,clock:()=>now,
   readEligibility:async(_account,symbols,_signal,instruments)=>{checkedInstruments.push(instruments);return symbols.map(symbol=>({symbol,tradable:true,fractional:true,detail:null,name:null}));}});
  const smallDeposit=await instructions.preflight({bucketId:invested.allocationId},'20');
  expect(smallDeposit.legs.map(l=>l.notional)).toEqual(['20']);
  const depositPreview=await instructions.preflight({bucketId:invested.allocationId},'80');
  await funding.deposit(invested.allocationId,'80');
  expect(checkedInstruments).toEqual([[mixedSpec.target.weights[1].instrument]]);
  await db.query("UPDATE strategy_executions SET status='cancelled' WHERE status='queued'");
  expect(await planner.planAllocation(invested.allocationId,'deposit')).toMatchObject({disposition:'planned'});
  const deposited=(await db.query<{order_request:{dollar_amount:string}}>("SELECT order_request FROM strategy_executions WHERE status='queued'")).rows;
  expect(deposited.map(l=>l.order_request.dollar_amount)).toEqual(depositPreview.legs.map(l=>l.notional));

  await db.query('UPDATE position_snapshots SET data=$2 WHERE id=$1',[snapshot,JSON.stringify(data.map(p=>({...p,priceObservedAt:new Date(now-61000).toISOString()})))]);
  expect(await instructions.preflight({bucketId:invested.allocationId},'100')).toMatchObject({ok:false,legs:[],reasons:expect.arrayContaining([{code:'fresh_position_snapshot_required',symbols:[]}])});




 }finally{await db.close();}
});
