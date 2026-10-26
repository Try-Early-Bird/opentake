import {test,expect} from 'vitest';
import {createUsageCollector} from '../../../src/main/chat-usage';
import {usageBudgetError} from '../../../src/main/usage-budget';
import {createRunBudget} from '../../../src/main/run-budget';
for(const provider of ['claude','chatgpt','opencode'] as const)test(`${provider} stops on reported token threshold, retaining partial usage`,()=>{
 const c=createUsageCollector(provider);const run=createRunBudget(new AbortController().signal);
 const event=provider==='claude'?{kind:'model.output',payload:{messageId:'m',usage:{output_tokens:12}}}:provider==='chatgpt'?{kind:'usage.recorded',payload:{tokenUsage:{total:{outputTokens:12}}}}:{kind:'usage.recorded',payload:{stepId:'s',tokens:{output:12},cost:0.05}};
 try{const value=c.observe(event)!;expect(usageBudgetError(provider,{claudeCostUsd:null,outputTokens:13},value)).toBeUndefined();
 const error=usageBudgetError(provider,{claudeCostUsd:null,outputTokens:12},value);expect(error?.message).toContain('output-token');run.cancel(error);expect(run.signal.aborted).toBe(true);expect(()=>run.toolDispatch()).toThrow('output-token');expect(c.finish(false)).toMatchObject({outputTokens:12,partial:true});
 }finally{run.finish();}
});
test('OpenCode cost threshold is provider-specific and unknown usage never becomes zero',()=>{
 const usage={source:'fixture',costKind:'provider-reported' as const,partial:true,costUsd:0.2};const settings={claudeCostUsd:null,opencodeCostUsd:0.1,outputTokens:10};
 expect(usageBudgetError('opencode',settings,usage)?.message).toContain('reported-cost');
 expect(usageBudgetError('chatgpt',settings,usage)).toBeUndefined();
 expect(usageBudgetError('opencode',settings,{...usage,costUsd:undefined})).toBeUndefined();
 expect(usageBudgetError('opencode',{claudeCostUsd:null},usage)).toBeUndefined();
});
test('a Grok rule run stops when Grok reports incomplete usage, because its token gate cannot be checked',()=>{
 const c=createUsageCollector('grok');
 const complete=c.observe({kind:'usage.recorded',status:'complete',payload:{usage:{inputTokens:10,outputTokens:5}}} as never)!;
 expect(complete.incomplete).toBeUndefined();expect(usageBudgetError('grok',{claudeCostUsd:null,outputTokens:100,requireCompleteUsage:true},complete)).toBeUndefined();
 const partial=c.observe({kind:'usage.recorded',status:'complete',payload:{usage:{inputTokens:10,outputTokens:5,usageIsIncomplete:true}}} as never)!;
 expect(partial.incomplete).toBe(true);
 expect(usageBudgetError('grok',{claudeCostUsd:null,outputTokens:100,requireCompleteUsage:true},partial)?.message).toContain('incomplete usage');
 // Chat keeps its behavior: incomplete counts alone never stop an ordinary response.
 expect(usageBudgetError('grok',{claudeCostUsd:null,outputTokens:100},partial)).toBeUndefined();
});
