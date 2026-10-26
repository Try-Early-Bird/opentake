import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { planContext, contextUnits, contextLimit } from '../../../src/main/take-context';
import { createTakes } from '../../../src/main/takes';
import { migrate } from '../../../src/main/migrations';
import type { TakeMessage } from '../../../src/shared/takes';
const selection={provider:'claude' as const,model:'sonnet'};
function branch():TakeMessage[]{
 const messages:TakeMessage[]=[];
 for(let i=0;i<20;i++)messages.push({id:randomUUID(),parentId:messages.at(-1)?.id??null,role:i%2?'assistant':'user',text:i%2?'Assistant evidence '+String(i)+' '+ 'x'.repeat(15000):'User constraint '+i,images:[],createdAt:'2026-10-02T12:00:00Z',selection,state:'completed',tools:[]});
 return messages;
}
test('condenses only older assistant output, preserves instructions, users, images and recent turns',()=>{
 const messages=branch();messages[0].images=[{id:randomUUID(),name:'reference.png',mime:'image/png',width:100,height:100,bytes:123}];
 const before=JSON.stringify(messages);const result=planContext(messages,'SYSTEM MUST STAY',[]);
 expect(result.summaries.length).toBeGreaterThan(0);expect(result.info.inputUnits).toBeLessThanOrEqual(contextLimit);
 expect(JSON.stringify(messages)).toBe(before);expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
 for(let i=0;i<messages.length;i+=2)expect(result.messages[i]).toEqual(messages[i]);
 expect(contextUnits(result.messages,'SYSTEM MUST STAY',[])).toBe(result.info.inputUnits);
 expect(result.messages[1].role).toBe('assistant');expect(result.messages[1].replay).toBeUndefined();
});
test('retains tool provenance, failed and unknown outcomes, and labels excerpts as historical data',()=>{
 const messages=branch();messages[1].runId=randomUUID();messages[1].tools=[{id:'call1',name:'portfolio',state:'failed',startedAt:messages[1].createdAt}];
 messages[1].replay=[{role:'assistant',content:[{type:'tool_use',id:'call1',name:'portfolio',input:{account:'fixture'}},{type:'tool_use',id:'call2',name:'quotes',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call1',content:'host busy '+ 'x'.repeat(20000),is_error:true}]}];
 const result=planContext(messages,'',[]);const summary=result.summaries.find(s=>s.messageId===messages[1].id)!;
 expect(summary.text).toContain('failed');expect(summary.text).toContain('outcome unknown');expect(summary.text).toContain('untrusted data');expect(summary.text).toContain('host busy');
 expect(summary.provenance.runId).toBe(messages[1].runId);expect(summary.provenance.toolCalls[0].state).toBe('failed');
});
test('reuse is source- and algorithm-bound; small branches stay exact and oversized fixed context fails clearly',()=>{
 const messages=branch();const first=planContext(messages,'',[]);expect(planContext(messages,'',[],first.summaries).info.summaryIds).toEqual(first.info.summaryIds);
 const changed=structuredClone(messages);changed[1].text+=' changed';expect(planContext(changed,'',[],first.summaries).summaries[0].id).not.toBe(first.summaries[0].id);
 expect(planContext(messages.slice(-3),'',[]).messages).toEqual(messages.slice(-3));
 expect(()=>planContext(messages,'i'.repeat(contextLimit),[])).toThrow('context limit');
 expect(()=>planContext(messages,'',[{schema:'s'.repeat(contextLimit)}])).toThrow('context limit');
 const users=messages.map(m=>({...m,role:'user' as const,text:'x'.repeat(contextLimit)}));expect(()=>planContext(users,'',[])).toThrow('User messages');
 expect(contextUnits([{...messages[0],images:[{id:'image',name:'image',mime:'image/png',bytes:1,width:1,height:1}]}],'',[])).toBeGreaterThan(8000);
});
test('send persists summaries and run references atomically, reuses on retry, and keeps full history and branch isolation',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 let seen:TakeMessage[]=[];const service=createTakes(lifecycle,async input=>{seen=input.messages;input.text('Done');},async()=>({ok:true as const,source:'runtime' as const,models:[{value:'sonnet',label:'Sonnet'}]}));
 try{
  await service.start();const id=await service.create();const messages=branch();
  await db.query("INSERT INTO take_platform_context(take_id,accounts) VALUES($1,'[\"fixture-platform\"]')",[id]);
  for(const m of messages)await db.query('INSERT INTO take_messages(id,take_id,parent_id,data) VALUES($1,$2,$3,$4)',[m.id,id,m.parentId,JSON.stringify(m)]);
  const send=async(parentId:string)=>{await service.send({requestId:randomUUID(),takeId:id,parentId,text:'Continue',selection});for(let i=0;i<100&&service.busy();i++)await new Promise(r=>setTimeout(r,5));expect(service.busy()).toBe(false);};
  await send(messages.at(-1)!.id);
  const summaries=(await db.query<{id:string}>('SELECT id FROM take_context_summaries WHERE take_id=$1',[id])).rows;expect(summaries.length).toBeGreaterThan(0);expect(seen[1].text).toContain('Condensed historical');
  expect((await service.load(id)).messages.find(m=>m.id===messages[1].id)).toEqual(messages[1]);
  const config=(await db.query<{configuration:{context:{summaryIds:string[]}}}>('SELECT configuration FROM take_runs WHERE take_id=$1',[id])).rows[0].configuration;
  expect(new Set(config.context.summaryIds)).toEqual(new Set(summaries.map(s=>s.id)));
  await send(messages.at(-1)!.id);expect((await db.query('SELECT id FROM take_context_summaries WHERE take_id=$1',[id])).rows).toHaveLength(summaries.length);
  await send(messages[0].id);expect(seen).toHaveLength(2);expect(seen[0]).toEqual(messages[0]);
  expect((await service.load(id)).messages.at(-1)?.context).toBeUndefined();
  expect((await db.query<{accounts:string[]}>('SELECT accounts FROM take_platform_context WHERE take_id=$1',[id])).rows[0].accounts).toEqual(['fixture-platform']);
  await service.remove(id);expect((await db.query('SELECT id FROM take_context_summaries')).rows).toHaveLength(0);
 }finally{await service.close();await db.close();}
});

test('admits preserved recent context above the old cap and rejects above the hard cap',()=>{
 const messages=branch().slice(-2);messages[1].text='x'.repeat(150_000);
 const result=planContext(messages,'fixed instructions',[{name:'fixture_tool'}]);
 expect(result.info.inputUnits).toBeGreaterThan(100_000);
 expect(result.messages).toEqual(messages);expect(result.summaries).toEqual([]);
 const overhead=contextUnits([{...messages[1],text:''}],'',[]);
 const boundary={...messages[1],text:'x'.repeat(contextLimit-overhead)};
 expect(planContext([boundary],'',[]).info.inputUnits).toBe(contextLimit);
 expect(()=>planContext([{...boundary,text:boundary.text+'x'}],'',[])).toThrow('context limit');
});
