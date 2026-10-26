import {test,expect} from 'vitest';
import {createUsageCollector} from '../../../src/main/chat-usage';
test('Claude replaces duplicate message snapshots and authoritative totals without double counting',()=>{
 const c=createUsageCollector('claude');
 const output={kind:'model.output',payload:{messageId:'m',usage:{input_tokens:12,output_tokens:3}}};c.observe(output);c.observe(output);
 expect(c.snapshot()).toMatchObject({inputTokens:12,outputTokens:3,partial:true});
 c.observe({kind:'usage.recorded',payload:{usage:{input_tokens:30,output_tokens:8,cache_read_input_tokens:40,cache_creation_input_tokens:2},costUsd:0.012}});
 expect(c.finish(true)).toMatchObject({inputTokens:30,outputTokens:8,cacheReadTokens:40,cacheWriteTokens:2,costUsd:0.012,costKind:'api-equivalent',partial:false});
});
test('Codex cumulative snapshots replace rather than add and cost remains unavailable',()=>{
 const c=createUsageCollector('chatgpt');for(const n of [12,12,25])c.observe({kind:'usage.recorded',payload:{tokenUsage:{total:{inputTokens:n,outputTokens:10,cachedInputTokens:5,reasoningOutputTokens:4}}}});
 expect(c.finish(false)).toMatchObject({inputTokens:25,outputTokens:10,cacheReadTokens:5,reasoningTokens:4,partial:true});expect(c.snapshot().costUsd).toBeUndefined();
});
test('OpenCode accumulates unique steps, distinguishes zero cost and refuses incomplete totals',()=>{
 const c=createUsageCollector('opencode');const event={kind:'usage.recorded',payload:{stepId:'one',tokens:{input:12,output:3,cache:{read:5,write:0}},cost:0}};c.observe(event);c.observe(event);
 expect(c.snapshot()).toMatchObject({inputTokens:12,outputTokens:3,costUsd:0,costKind:'provider-reported'});
 c.observe({kind:'usage.recorded',payload:{stepId:'two',tokens:{input:4,output:2},cost:0.1}});
 expect(c.finish(true)).toMatchObject({inputTokens:16,outputTokens:5,costUsd:0.1});expect(c.snapshot().cacheReadTokens).toBeUndefined();
});
test('missing or malformed reporting is never represented as zero usage or cost',()=>{
 const c=createUsageCollector('claude');c.observe({kind:'usage.recorded',payload:{usage:{input_tokens:-1,output_tokens:'5',cache_read_input_tokens:NaN},costUsd:Infinity}});
 expect(c.finish(true).inputTokens).toBeUndefined();expect(c.snapshot().outputTokens).toBeUndefined();expect(c.snapshot().costUsd).toBeUndefined();
});

test('incomplete final totals do not fall back to an earlier smaller partial count',()=>{
 const c=createUsageCollector('claude');c.observe({kind:'model.output',payload:{messageId:'m',usage:{input_tokens:5,output_tokens:2}}});c.observe({kind:'usage.recorded',payload:{usage:{output_tokens:20},costUsd:0.2}});expect(c.finish(true).inputTokens).toBeUndefined();expect(c.snapshot().outputTokens).toBe(20);
});
