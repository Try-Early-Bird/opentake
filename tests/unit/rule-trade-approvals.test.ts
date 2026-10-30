import {afterEach,expect,test,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {coinbaseRuleApprovals,createRuleTradeApprovals,robinhoodRuleApprovals} from '../../src/main/strategies/rule-trade-approvals';
import {coinbaseProfile,createVenueRegistry,robinhoodProfile} from '../../src/main/venues/registry';
import type {VenueProfile} from '../../src/main/venues/types';
const dbs:PGlite[]=[];afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});

test('one approval list for both venues; approving or declining goes to the right venue',async()=>{
 const db=new PGlite();dbs.push(db);await migrate(db);const database={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const request=randomUUID(),take=randomUUID();
 const robinhood={pending:vi.fn(async()=>[{request_id:request,kind:'reduce',amount:'25',preview:{orders:[{symbol:'VTI',side:'sell' as const,amountUsd:'25.00'}]},rule_name:'Cash buffer',created_at:new Date('2026-10-24T12:00:00Z')}]),decide:vi.fn(async()=>{})};
 const submitCoinbase=vi.fn(async()=>{}),deps={cancel:vi.fn(async()=>{}),nudge:vi.fn(async()=>{})};
 const venues=createVenueRegistry([{profile:coinbaseProfile,adapters:{},approvals:coinbaseRuleApprovals(database,submitCoinbase)},{profile:robinhoodProfile,adapters:{},approvals:robinhoodRuleApprovals(robinhood)}]);
 const approvals=createRuleTradeApprovals(venues,deps);
 expect(await approvals.list(take)).toEqual([{requestId:request,venue:'robinhood',ruleName:'Cash buffer',kind:'reduce',amount:'25',createdAt:'2026-10-24T12:00:00.000Z',orders:[{symbol:'VTI',side:'sell',amountUsd:'25.00'}],estimated:true}]);
 await approvals.decide(take,request,true);expect(robinhood.decide).toHaveBeenCalledWith(request,true);expect(deps.nudge).toHaveBeenCalled();expect(submitCoinbase).not.toHaveBeenCalled();
 await approvals.decide(take,request,false);expect(deps.cancel).toHaveBeenCalledWith(request);
 await expect(approvals.decide(take,randomUUID(),true)).rejects.toThrow('no longer waiting');
});

test('a third venue joins the approval list through its slot alone',async()=>{
 const take=randomUUID(),own=randomUUID(),other=randomUUID();
 const fake:VenueProfile={...coinbaseProfile,id:'fakevenue',label:'Fake'};
 const third={pending:vi.fn(async()=>[{requestId:own,ruleName:null,kind:'rebalance_to_target',amount:null,createdAt:'2026-10-24T13:00:00.000Z',orders:[{side:'buy' as const,symbol:'XYZ',amountUsd:'10'}]}]),approve:vi.fn(async()=>{})};
 const robinhood={pending:vi.fn(async()=>[{requestId:other,ruleName:'r',kind:'reduce',amount:'5',createdAt:'2026-10-24T12:00:00.000Z',orders:[]}]),approve:vi.fn(async()=>{})};
 const nudge=vi.fn(async()=>{});
 // A venue without the slot (no approvals yet) is skipped, never an error.
 const venues=createVenueRegistry([{profile:robinhoodProfile,adapters:{},approvals:robinhood},{profile:coinbaseProfile,adapters:{}},{profile:fake,adapters:{},approvals:third}]);
 const approvals=createRuleTradeApprovals(venues,{cancel:vi.fn(async()=>{}),nudge});
 expect((await approvals.list(take)).map(a=>[a.venue,a.requestId])).toEqual([['robinhood',other],['fakevenue',own]]);
 await approvals.decide(take,own,true);
 expect(third.approve).toHaveBeenCalledWith(own);expect(robinhood.approve).not.toHaveBeenCalled();expect(nudge).toHaveBeenCalledTimes(1);
});

test('an approval that fails at its venue does not nudge or fall through to another venue',async()=>{
 const take=randomUUID(),request=randomUUID();
 const failing={pending:vi.fn(async()=>[{requestId:request,ruleName:null,kind:'reduce',amount:'1',createdAt:'2026-10-24T12:00:00.000Z',orders:[]}]),approve:vi.fn(async()=>{throw new Error('venue refused');})};
 const other={pending:vi.fn(async()=>[]),approve:vi.fn(async()=>{})},nudge=vi.fn(async()=>{});
 const approvals=createRuleTradeApprovals(createVenueRegistry([{profile:robinhoodProfile,adapters:{},approvals:failing},{profile:coinbaseProfile,adapters:{},approvals:other}]),{cancel:vi.fn(async()=>{}),nudge});
 await expect(approvals.decide(take,request,true)).rejects.toThrow('venue refused');
 expect(other.approve).not.toHaveBeenCalled();expect(nudge).not.toHaveBeenCalled();
});
