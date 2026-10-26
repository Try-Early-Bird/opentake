import {test,expect,vi,afterEach} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createMixedWithdrawals,type MixedWithdrawalDependencies} from '../../src/main/mixed-execution/withdrawal';
const databases:PGlite[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.close();});
async function fixture(){
 const db=new PGlite();databases.push(db);await migrate(db);
 const takeId=randomUUID();await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Withdrawal fixture','{}' FROM local_owners",[takeId]);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};let now=Date.now();
 const deps:MixedWithdrawalDependencies={enabled:()=>true,clock:()=>now,
  accounts:async()=>[{venue:'coinbase',accountId:randomUUID(),accountLabel:'Crypto',holdingsUsd:'14',valueUsd:'14.1',currency:'USDC',rate:'1'},{venue:'robinhood',accountId:randomUUID(),accountLabel:'Equity',holdingsUsd:'6',valueUsd:'6.2',currency:'USD',rate:'1'}],
  band:async(_take,a)=>({minimumAmount:'1',maximumAmount:a.venue==='coinbase'?'12':'5',possible:true}),
  preview:vi.fn(async(_request,a,amount)=>({expiresAt:new Date(now+60000).toISOString(),leg:{...a,reference:randomUUID(),evidence:'checked',amount,cashReturned:'0',estimatedProceeds:amount,orders:[]}})),
  validate:vi.fn(async()=>{}),releaseReview:vi.fn(async()=>{}),drive:vi.fn(async()=>({state:'completed' as const,message:null})),
 };
 return {db,database,takeId,deps,service:createMixedWithdrawals(database,deps),advance:()=>{now+=61000;},request:{takeId,kind:'reduce' as const,amountUsd:'10',coinbaseCurrency:'USDC' as const}};
}
test('partial withdrawal splits current holdings proportionally and intersects venue minimums',async()=>{
 const f=await fixture(),p=await f.service.preview(f.request);
 expect(p.legs.map(l=>l.amount)).toEqual(['7','3']);
 expect(await f.service.limits(f.takeId,'USDC')).toMatchObject({minimumAmount:'3.34',maximumAmount:'16.66',possible:true});
 expect(f.deps.drive).not.toHaveBeenCalled();
 const done=await f.service.confirm(p.id);expect(done.state).toBe('completed');
 await f.service.confirm(p.id);expect(f.deps.drive).toHaveBeenCalledTimes(2);
});
test('failed second account preview prevents a confirmable parent and any execution',async()=>{
 const f=await fixture();f.deps.preview=vi.fn(async()=>{throw Error('Below minimum');});
 await expect(f.service.preview(f.request)).rejects.toThrow('Below minimum');
 expect((await f.db.query('SELECT * FROM mixed_take_withdrawals')).rows).toHaveLength(0);expect(f.deps.drive).not.toHaveBeenCalled();
});
test('expired or changed review places no orders',async()=>{
 const f=await fixture(),p=await f.service.preview(f.request);f.advance();
 expect((await f.service.confirm(p.id)).state).toBe('expired');expect(f.deps.drive).not.toHaveBeenCalled();
 const next=await f.service.preview(f.request);f.deps.validate=async()=>{throw Error('Holdings changed');};
 await expect(f.service.confirm(next.id)).rejects.toThrow('Holdings changed');expect(f.deps.drive).not.toHaveBeenCalled();
});
test('restart resumes scheduled child with its same identity without repeating completed sales',async()=>{
 const f=await fixture();let open=false;
 f.deps.drive=vi.fn(async(_v,l)=>({state:l.venue==='coinbase'||open?'completed' as const:'waiting_market' as const,message:null}));
 const p=await f.service.preview(f.request),run=await f.service.confirm(p.id);
 expect(run.state).toBe('running');await expect(f.service.preview(f.request)).rejects.toThrow('Finish');
 open=true;const recovered=createMixedWithdrawals(f.database,f.deps);await recovered.tick();
 expect((await recovered.current(f.takeId))?.state).toBe('completed');
 const calls=vi.mocked(f.deps.drive).mock.calls;expect(calls.map(c=>c[1].venue)).toEqual(['coinbase','robinhood','robinhood']);expect(calls[1][1].operationId).toBe(calls[2][1].operationId);
});
test('uncertain outcome blocks later child; ending is gated on safe release',async()=>{
 const f=await fixture();f.deps.drive=vi.fn(async()=>{throw Error('Unknown submission');});
 const p=await f.service.preview(f.request);expect((await f.service.confirm(p.id)).state).toBe('attention');expect(f.deps.drive).toHaveBeenCalledTimes(1);
 f.deps.releaseReview=async()=>{throw Error('Order still live');};await expect(f.service.end(p.id)).rejects.toThrow('still live');
 expect((await f.service.current(f.takeId))?.state).toBe('attention');
 f.deps.releaseReview=async()=>{};expect((await f.service.end(p.id)).state).toBe('expired');await expect(f.service.preview(f.request)).resolves.toMatchObject({state:'preview'});
});
test('close includes cash-only accounts and keeps venue-specific sell choices',async()=>{
 const f=await fixture();const accounts=await f.deps.accounts(f.takeId,'USDC');accounts[0].holdingsUsd='0';accounts[0].valueUsd='0.1';f.deps.accounts=async()=>accounts;
 const p=await f.service.preview({...f.request,kind:'close',sellSymbols:['robinhood:AAPL']});
 expect(p.legs).toHaveLength(2);expect(p.amountUsd).toBe('6.3');expect(vi.mocked(f.deps.preview).mock.calls[0][0].sellSymbols).toEqual(['robinhood:AAPL']);
 expect((await f.service.confirm(p.id)).state).toBe('completed');
});

test('Coinbase adapter reconciles an existing dispatch instead of submitting it again',async()=>{
 const {mixedWithdrawalAdapters}=await import('../../src/main/mixed-execution/withdrawal-adapters');
 const f=await fixture(),p=await f.service.preview(f.request);
 const submit=vi.fn(),confirm=vi.fn(),refresh=vi.fn(async()=>({state:'settled',orders:[{execution:{state:'filled'}}]}));
 const deps=mixedWithdrawalAdapters(f.database,{enabled:()=>true,rate:async()=> '1',executor:{} as never,instructions:{} as never,capital:{} as never,orders:{confirm} as never,execution:{view:async()=>({state:'confirmed',orders:[{execution:{state:'open'}}]}),submit,refresh} as never});
 expect(await deps.drive(p,p.legs[0])).toEqual({state:'completed',message:null});expect(refresh).toHaveBeenCalledOnce();expect(submit).not.toHaveBeenCalled();expect(confirm).not.toHaveBeenCalled();
});
