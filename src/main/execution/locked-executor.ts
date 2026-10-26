import type {Executor} from './contracts';
import type {AccountQueues} from './account-queues';

// Robinhood placement for an allocation holds its account, so the
// scheduler, member instructions, mixed Takes and manual orders on that account
// take turns. One executor instance serves all of them, so it is wrapped once.
// Placement can submit several legs, each bounded by the venue queue; the account
// deadline only reports and signals, it never releases a slot early.
const PLACEMENT_DEADLINE_MS=10*60_000;

export function lockedExecutor(executor:Executor,accounts:AccountQueues,accountOf:(allocationId:string)=>Promise<string|null>):Executor{
 return {
  async executeAllocation(allocationId,options){
   const accountId=await accountOf(allocationId);
   if(!accountId)return executor.executeAllocation(allocationId,options);
   return accounts.run([accountId],()=>executor.executeAllocation(allocationId,options),{label:'robinhood placement',deadlineMs:PLACEMENT_DEADLINE_MS});
  },
  // Settlement only records sync results and already ran beside placement; unchanged.
  settleLegs:accountId=>executor.settleLegs(accountId),
 };
}
