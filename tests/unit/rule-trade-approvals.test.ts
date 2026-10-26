import {afterEach,expect,test,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createRuleTradeApprovals} from '../../src/main/strategies/rule-trade-approvals';
const dbs:PGlite[]=[];afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});

test('one approval list for both venues; approving or declining goes to the right venue',async()=>{
 const db=new PGlite();dbs.push(db);await migrate(db);const database={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const request=randomUUID(),take=randomUUID();
 const robinhood={pending:vi.fn(async()=>[{request_id:request,kind:'reduce',amount:'25',preview:{orders:[{symbol:'VTI',side:'sell' as const,amountUsd:'25.00'}]},rule_name:'Cash buffer',created_at:new Date('2026-10-24T12:00:00Z')}]),decide:vi.fn(async()=>{})};
 const deps={robinhood,submitCoinbase:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),nudge:vi.fn(async()=>{})};
 const approvals=createRuleTradeApprovals(database,deps);
 expect(await approvals.list(take)).toEqual([{requestId:request,venue:'robinhood',ruleName:'Cash buffer',kind:'reduce',amount:'25',createdAt:'2026-10-24T12:00:00.000Z',orders:[{symbol:'VTI',side:'sell',amountUsd:'25.00'}]}]);
 await approvals.decide(take,request,true);expect(robinhood.decide).toHaveBeenCalledWith(request,true);expect(deps.nudge).toHaveBeenCalled();expect(deps.submitCoinbase).not.toHaveBeenCalled();
 await approvals.decide(take,request,false);expect(deps.cancel).toHaveBeenCalledWith(request);
 await expect(approvals.decide(take,randomUUID(),true)).rejects.toThrow('no longer waiting');
});
