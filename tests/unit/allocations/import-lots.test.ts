import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {importStrategyPortfolio} from '../../../src/main/allocations/portfolio-import';
import {bindImportedLots} from '../../../src/main/allocations/import-lots';
import {lotsForAllocationSell} from '../../../src/main/execution/sell-lots';

// Imported takes bind their lots (migration 43): hosted's matcher on the stored
// source buys, or hosted's own lot ids from a newer export.
async function fixture(){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=Date.parse('2026-10-03T14:00:00Z'),shares='20';
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const accountId=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic-hash','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:accountId,selected:true,agenticAllowed:true,maskedNumber:'fixture',nickname:null,accountType:'cash'}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:shares,mark_price:'10',average_buy_price:'8'}]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 const sourceConnection=randomUUID(),sourceStrategy=randomUUID(),buy1=randomUUID(),buy2=randomUUID();
 const input={format:'opentake-strategy-portfolio-v1',exportedAt:new Date(now).toISOString(),source:{branch:'development',provider:'robinhood_agentic',accountId:randomUUID(),connectionId:sourceConnection,accountRefHash:createHash('sha256').update(`${sourceConnection}:synthetic-hash`).digest('hex')},
  strategies:[{id:sourceStrategy,title:'Imported strategy',description:'Synthetic',rebalance:null,versions:[{id:randomUUID(),sequence:1,weights:[{symbol:'VTI',weightPercent:80}],cashPercent:20}]}],
  allocations:[{id:randomUUID(),strategyId:sourceStrategy,status:'active',appliedSequence:1,entries:[
   {id:randomUUID(),sequence:1,entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'100',unitCost:null,currency:'USD',sourceKind:'reconciliation',sourceRef:'fixture1',occurredAt:'2026-10-01T14:00:00Z'},
   {id:buy1,sequence:2,entryType:'fill',symbol:'VTI',quantityDelta:'5',cashDelta:'-50',unitCost:'10',currency:'USD',sourceKind:'strategy_execution',sourceRef:'fixture2',occurredAt:'2026-10-02T15:00:00Z'},
   {id:buy2,sequence:3,entryType:'fill',symbol:'VTI',quantityDelta:'3',cashDelta:'-33',unitCost:'11',currency:'USD',sourceKind:'strategy_execution',sourceRef:'fixture3',occurredAt:'2026-10-02T16:00:00Z'},
  ],history:[]}]};
 await importStrategyPortfolio(database,input,undefined,now,{externalRef:'synthetic-hash',connectionId:sourceConnection,accountRefHash:input.source.accountRefHash});
 const allocationId=(await sync.snapshot()).strategies![0].allocationId;
 const row=async()=>(await db.query<{status:string;restore_required:boolean}>('SELECT status,restore_required FROM strategy_allocations WHERE id=$1',[allocationId])).rows[0];
 return {db,database,input,buy1,buy2,proof:{externalRef:'synthetic-hash',connectionId:sourceConnection,accountRefHash:input.source.accountRefHash},sync,accountId,allocationId,row,now:()=>new Date(now).toISOString(),
  resync:async(next:string)=>{shares=next;now+=1000;await sync.synchronize();},
  later:(ms:number)=>{now+=ms;},close:async()=>{sync.cancel();await db.close();}};
}

const lot=(openLotId:string,quantity:string,unitCost:string,acquiredAt:string)=>({openLotId,quantity,costBasis:null,unitCost,acquiredAt,selectable:true});

test('an imported take binds its source buys to the open lots they created, so its sells name them',async()=>{
 const f=await fixture();try{
  const lots=[lot('OWN','12','8','2026-01-05T15:00:00Z'),lot('L5','5','10','2026-10-02T15:00:00Z'),lot('L3','3','11','2026-10-02T16:00:00Z')];
  let reads=0;const read=async()=>{reads++;return lots;};
  expect(await bindImportedLots(f.database,read,f.accountId)).toEqual({matched:2,unmatched:0});
  const bound=(await f.db.query<{open_lot_id:string;source_ref:string}>(`SELECT open_lot_id,source_ref FROM strategy_lot_bindings ORDER BY open_lot_id`)).rows;
  expect(bound).toEqual([{open_lot_id:'L3',source_ref:f.buy2},{open_lot_id:'L5',source_ref:f.buy1}]);
  // Bound once: the next sync has nothing to read.
  expect(await bindImportedLots(f.database,read,f.accountId)).toEqual({matched:0,unmatched:0});expect(reads).toBe(1);
  await f.db.query(`UPDATE strategy_allocations SET status='active',restore_required=false WHERE id=$1`,[f.allocationId]);
  const sell=await f.db.transaction(tx=>lotsForAllocationSell(tx,{allocationId:f.allocationId,symbol:'VTI',quantity:'5',live:lots,nowMs:Date.parse('2026-10-06T15:00:00Z')}));
  expect(sell.kind).toBe('lots');
  if(sell.kind==='lots')expect(sell.taxLots.every(l=>['L5','L3'].includes(l.open_lot_id))).toBe(true);
 }finally{await f.close();}
});

test('a newer export adds hosted lot ids and publish days to the imported take; the lot id wins over matching',async()=>{
 const f=await fixture();try{
  const v2=structuredClone(f.input) as typeof f.input&{strategies:{versions:Record<string,unknown>[]}[];allocations:{entries:Record<string,unknown>[]}[]};
  v2.exportedAt=new Date(Date.parse(v2.exportedAt)+1000).toISOString();
  v2.strategies[0]!.versions[0]!.publishedAt='2026-09-23T21:27:34Z';
  v2.allocations[0]!.entries.find(e=>e.id===f.buy1)!.openLotId='HINTED';
  expect(await importStrategyPortfolio(f.database,v2,undefined,Date.parse(v2.exportedAt),f.proof)).toMatchObject({imported:0,updated:{publishDays:1,lotIds:1}});
  expect((await f.db.query(`SELECT effective_on::text AS d FROM strategy_version_effective_dates`)).rows).toEqual([{d:'2026-09-23'}]);
  // A same-size lot from the same day would match the buy; hosted's own id is bound instead.
  const lots=[lot('DECOY','5','10','2026-10-02T15:00:00Z'),lot('HINTED','5','10','2026-10-02T15:00:00Z'),lot('L3','3','11','2026-10-02T16:00:00Z')];
  await bindImportedLots(f.database,async()=>lots,f.accountId);
  expect((await f.db.query(`SELECT open_lot_id FROM strategy_lot_bindings WHERE source_ref=$1`,[f.buy1])).rows).toEqual([{open_lot_id:'HINTED'}]);
  // An export with nothing new for the imported takes still refuses to overwrite them.
  const changed=structuredClone(f.input);changed.allocations[0]!.history=[{observedAt:changed.exportedAt,totalValue:'1'}];
  await expect(importStrategyPortfolio(f.database,changed,undefined,Date.parse(changed.exportedAt),f.proof)).rejects.toThrow('Source portfolio changed');
 }finally{await f.close();}
});
