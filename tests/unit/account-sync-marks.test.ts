import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createAccountSync} from '../../src/main/account-sync/service';
import {importStrategyPortfolio} from '../../src/main/allocations/portfolio-import';

// Robinhood's positions endpoint carries no price (as on the live account,
// 2026-10-03): the sync quotes the symbols, so positions and the strategies
// holding them can be valued.
async function fixture(quotes:(symbols:string[])=>unknown){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const now=Date.parse('2026-10-03T14:00:00Z');
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const accountId=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic-hash','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const calls:{name:string;args:Record<string,unknown>;account:string|undefined}[]=[];
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:accountId,selected:true,agenticAllowed:true,maskedNumber:'fixture',nickname:null,accountType:'cash'}]}),
  readTool:async(name:string,args:Record<string,unknown>,account?:string)=>{
   calls.push({name,args,account});
   if(name==='get_portfolio')return {total_value:'1200',cash:'1000',buying_power:'1000'};
   if(name==='get_equity_positions')return {results:[{instrument_id:'qdte',symbol:'QDTE',quantity:'2'},{instrument_id:'VTI',symbol:'VTI',quantity:'1'}]};
   if(name==='get_equity_quotes')return quotes(args.symbols as string[]);
   return {results:[]};
  },
 },()=>now);
 return {db,database,sync,accountId,calls,now};
}

test('positions without a provider price are marked from quotes, and an imported strategy is valued',async()=>{
 const f=await fixture(symbols=>({results:symbols.map(symbol=>({symbol,last_trade_price:symbol==='QDTE'?'35.50':'250'}))}));
 try{
  await f.sync.synchronize();
  const quoteCall=f.calls.find(c=>c.name==='get_equity_quotes');
  expect(quoteCall).toMatchObject({args:{symbols:['QDTE','VTI']},account:undefined});
  const sourceConnection=randomUUID(),strategyId=randomUUID();
  const input={format:'opentake-strategy-portfolio-v1',exportedAt:new Date(f.now).toISOString(),source:{branch:'development',provider:'robinhood_agentic',accountId:randomUUID(),connectionId:sourceConnection,accountRefHash:createHash('sha256').update(`${sourceConnection}:synthetic-hash`).digest('hex')},
   strategies:[{id:strategyId,title:'QDTE dividend test',description:'',rebalance:null,versions:[{id:randomUUID(),sequence:1,weights:[{symbol:'QDTE',weightPercent:100}],cashPercent:0}]}],
   allocations:[{id:randomUUID(),strategyId,status:'active',appliedSequence:1,entries:[
    {id:randomUUID(),sequence:1,entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'71',unitCost:null,currency:'USD',sourceKind:'reconciliation',sourceRef:'a',occurredAt:'2026-10-01T14:00:00Z'},
    {id:randomUUID(),sequence:2,entryType:'fill',symbol:'QDTE',quantityDelta:'2',cashDelta:'-71',unitCost:'35.5',currency:'USD',sourceKind:'strategy_execution',sourceRef:'b',occurredAt:'2026-10-02T15:00:00Z'},
   ],history:[]}]};
  await importStrategyPortfolio(f.database,input,undefined,f.now,{externalRef:'synthetic-hash',connectionId:sourceConnection,accountRefHash:input.source.accountRefHash});
  const view=await f.sync.snapshot();
  expect(view.positions.map(p=>[p.symbol,p.markPrice,p.marketValue])).toEqual([['QDTE','35.50','71'],['VTI','250','250']]);
  expect(view.strategies?.[0]).toMatchObject({title:'QDTE dividend test',value:'71'});
 }finally{f.sync.cancel();await f.db.close();}
});

test('a quote failure leaves positions unmarked without failing the sync',async()=>{
 const f=await fixture(()=>{throw new Error('quotes down');});
 try{
  await f.sync.synchronize();
  const view=await f.sync.snapshot();
  expect(view.positions.every(p=>p.markPrice===null&&p.marketValue===null)).toBe(true);
  expect(view.resources.find(r=>r.resource==='equity_positions')?.state).toBe('completed');
 }finally{f.sync.cancel();await f.db.close();}
});
