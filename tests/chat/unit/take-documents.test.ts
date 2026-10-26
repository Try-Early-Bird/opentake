import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,test,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate,migrations } from '../../../src/main/migrations';
import { createTakes } from '../../../src/main/takes';
import { createTakeDocuments } from '../../../src/main/take-documents';
import { documentLimits,documentTool } from '../../../src/shared/chat-documents';
import type { TakeMessage } from '../../../src/shared/takes';
import { auditToolResult,codexToolOutput,replayToolContent } from '../../../src/main/tool-output';

const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function folder(){const path=await mkdtemp(join(tmpdir(),'pdf-files-'));folders.push(path);return join(path,'attachments','pdf');}
const selection={provider:'claude' as const,model:'synthetic'};
const models=async()=>({ok:true as const,source:'runtime' as const,models:[{value:'synthetic',label:'Synthetic',imageInput:true}]});
async function upload(service:ReturnType<typeof createTakeDocuments>,takeId:string,name='report.pdf',bytes=Buffer.from('%PDF-fixture')){
 const {id}=await service.action('begin',{takeId,name,bytes:bytes.length}) as {id:string};
 for(let offset=0,ordinal=0;offset<bytes.length;offset+=documentLimits.chunkBytes,ordinal++){
  await service.action('chunk',{id,ordinal,data:bytes.subarray(offset,offset+documentLimits.chunkBytes).toString('base64')});
 }
 return await service.action('finish',{id}) as {id:string;pages:number};
}
async function settle(service:ReturnType<typeof createTakes>){for(let i=0;i<300;i++){if(!service.busy())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Run did not settle');}
test('instruction sets without PDF reading still answer and tell the model the PDFs are unreadable',async()=>{
 const db=new PGlite();await migrate(db);
 const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const directory=await folder();
 const docs=createTakeDocuments(lifecycle,()=>directory,async()=>({pages:['Synthetic text']}));
 const seen:TakeMessage[][]=[];let runId='';
 const executor=async(input:any)=>{seen.push(input.messages);runId=input.id;input.text('Done');};
 const restricted=createTakes(lifecycle,executor,models,async()=>[]);await restricted.start();
 try{
  const id=await restricted.create(),meta=await upload(docs,id);
  await restricted.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Read it',documents:[meta.id],selection});await settle(restricted);
  expect(seen[0][0].text).toContain('PDF reading is turned off');
  const run=(await db.query<{configuration:{documentIds:string[]}}>('SELECT configuration FROM take_runs WHERE id=$1',[runId])).rows[0];
  expect(run.configuration.documentIds).toEqual([]);
 }finally{await restricted.close();await db.close();}
});
test('long documents stay out of message text, retain original bytes, and support scoped retrieval after reopening',async()=>{
 const db=new PGlite();await migrate(db);
 const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const pages=Array.from({length:40},(_,i)=>`Page ${i+1}: `+'ordinary report text '.repeat(400));pages[39]+=' unique latepage earnings marker';
 const directory=await folder();
 const docs=createTakeDocuments(lifecycle,()=>directory,async(_data,page)=>page?{image:'AA=='}:{pages});
 let seen:TakeMessage[][]=[];let runId='';
 const executor=async(input:any)=>{seen.push(input.messages);runId=input.id;input.text('Done');};
 let takes=createTakes(lifecycle,executor,models,async()=>[documentTool]);await takes.start();
 try{
  const id=await takes.create(),meta=await upload(docs,id);
  expect(meta.pages).toBe(40);
  await takes.update(id,{draft:'Summarize earnings',draftDocuments:[meta.id]});await takes.close();
  takes=createTakes(lifecycle,executor,models,async()=>[documentTool]);await takes.start();
  expect((await takes.load(id)).draftDocuments?.[0].id).toBe(meta.id);
  await takes.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Summarize earnings',documents:[meta.id],selection});await settle(takes);
  expect(seen[0][0].text).toContain('opentake_documents');
  expect(seen[0][0].text).not.toContain('ordinary report text');
  expect((await takes.load(id)).messages.find(m=>m.role==='user')?.text).toBe('Summarize earnings');
  // Synthetic active run enables direct retrieval tests without any provider.
  await db.query("UPDATE take_runs SET state='running' WHERE id=$1",[runId]);
  const result=await docs.tool(runId,{action:'search',query:'unique latepage'});
  expect(JSON.parse((result.content[0] as {text:string}).text).matches[0].page).toBe(40);
  const read=await docs.tool(runId,{action:'read',documentId:meta.id,page:40});
  const value=JSON.parse((read.content[0] as {text:string}).text);
  expect(value.nextOffset).toBe(6000);expect(value.totalCharacters).toBeGreaterThan(6000);
  const tail=await docs.tool(runId,{action:'read',documentId:meta.id,page:40,offset:value.nextOffset});
  expect(JSON.stringify(tail)).toContain('unique latepage');
  const visual=await docs.tool(runId,{action:'image',documentId:meta.id,page:40});
  expect(visual.content[1]).toMatchObject({type:'image',mimeType:'image/jpeg'});
  const other=await takes.create(),foreign=await upload(docs,other,'private.pdf');
  await expect(docs.tool(runId,{action:'read',documentId:foreign.id,page:1})).rejects.toThrow('conversation branch');
  await db.query("UPDATE take_runs SET configuration=jsonb_set(configuration,'{documentIds}','[]') WHERE id=$1",[runId]);
  await expect(docs.tool(runId,{action:'read',documentId:meta.id,page:1})).rejects.toThrow('conversation branch');
  expect(await readFile(join(directory,meta.id+'.pdf'),'utf8')).toBe('%PDF-fixture');
  await takes.remove(id);await docs.collect();
  await expect(readFile(join(directory,meta.id+'.pdf'))).rejects.toThrow();
  expect((await db.query('SELECT id FROM take_documents WHERE id=$1',[meta.id])).rows).toHaveLength(0);
 }finally{await takes.close();await db.close();}
});
test('upload bounds, rollback, chunk retry and response budgets are enforced',async()=>{
 const db=new PGlite();await migrate(db);
 const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const directory=await folder();
 let calls=0;const docs=createTakeDocuments(lifecycle,()=>directory,async()=>{calls++;return {pages:['text '.repeat(1800),'']};});
 const takes=createTakes(lifecycle,async()=>{},models);await takes.start();
 try{
  const takeId=await takes.create();
  await expect(docs.action('begin',{takeId,name:'huge.pdf',bytes:documentLimits.bytes+1})).rejects.toThrow();
  const {id}=await docs.action('begin',{takeId,name:'retry.pdf',bytes:12}) as {id:string};
  await expect(docs.action('finish',{id})).rejects.toThrow('Incomplete');
  expect(calls).toBe(0);
  const data=Buffer.from('%PDF-fixture').toString('base64');
  await docs.action('chunk',{id,ordinal:0,data});await docs.action('chunk',{id,ordinal:0,data});
  await docs.action('finish',{id});await docs.action('finish',{id});expect(calls).toBe(1);
  const run=randomUUID();
  await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running',$4)",[run,takeId,randomUUID(),JSON.stringify({documentIds:[id],documentUnits:6500,documentImages:0})]);
  await expect(docs.tool(run,{action:'image',documentId:id,page:1})).rejects.toThrow('image-capable');
  await docs.tool(run,{action:'read',documentId:id,page:1});
  await expect(docs.tool(run,{action:'read',documentId:id,page:1,offset:6000})).rejects.toThrow('context budget');
  await takes.update(takeId,{draftDocuments:[id]});
  await docs.action('discard',{id});expect((await takes.load(takeId)).draftDocuments).toHaveLength(1);
  await takes.update(takeId,{draftDocuments:[]});await docs.action('discard',{id});
  expect((await db.query('SELECT id FROM take_documents WHERE id=$1',[id])).rows).toHaveLength(0);
 }finally{await takes.close();await db.close();}
});
test('document migration appends cleanly to an existing database without changing earlier checksums',async()=>{
 const db=new PGlite();
 try{
  await migrate(db,migrations.filter(m=>m.version<82));
  const prior=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  await migrate(db);
  expect((await db.query('SELECT * FROM app_migrations WHERE version<82 ORDER BY version')).rows).toEqual(prior);
  await migrate(db);
  expect((await db.query('SELECT * FROM app_migrations WHERE version=82')).rows).toHaveLength(1);
 }finally{await db.close();}
});
test('page images reach Codex as images and do not become base64 text in replay',()=>{
 const result={content:[{type:'text',text:'PDF report page 12'},{type:'image',mimeType:'image/jpeg',data:'aGVsbG8='}]};
 expect(codexToolOutput(result)[1]).toEqual({type:'inputImage',imageUrl:'data:image/jpeg;base64,aGVsbG8='});
 expect(replayToolContent(result)).toContain('omitted from replay');
 expect(replayToolContent(result)).not.toContain('aGVsbG8=');
 const audited=auditToolResult(result) as typeof result;
 expect(audited.content[0]).toEqual(result.content[0]);
 expect(JSON.stringify(audited)).not.toContain('aGVsbG8=');
});
test('a failed page render returns its image reservation',async()=>{
 const db=new PGlite();await migrate(db);
 const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const directory=await folder();let fail=true;
 const docs=createTakeDocuments(lifecycle,()=>directory,async(_data,page)=>{if(!page)return {pages:['Synthetic text']};if(fail)throw new Error('synthetic render failure');return {image:'AA=='};});
 let runId='';
 const executor=async(input:any)=>{runId=input.id;input.text('Done');};
 const takes=createTakes(lifecycle,executor,models,async()=>[documentTool]);await takes.start();
 try{
  const id=await takes.create(),meta=await upload(docs,id);
  await takes.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Look',documents:[meta.id],selection});await settle(takes);
  await db.query("UPDATE take_runs SET state='running',configuration=configuration||'{\"documentImages\":1}' WHERE id=$1",[runId]);
  await expect(docs.tool(runId,{action:'image',documentId:meta.id,page:1})).rejects.toThrow('synthetic render failure');
  fail=false;
  const visual=await docs.tool(runId,{action:'image',documentId:meta.id,page:1});
  expect(visual.content[1]).toMatchObject({type:'image'});
  await expect(docs.tool(runId,{action:'image',documentId:meta.id,page:1})).rejects.toThrow('budget reached');
 }finally{await takes.close();await db.close();}
});
