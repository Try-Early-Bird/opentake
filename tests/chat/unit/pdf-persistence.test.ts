import { test,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../../src/main/migrations';
import { createTakes } from '../../../src/main/takes';
import { nativeHistory } from '../../../src/main/native-chat-history';
import type { TakeExecutor } from '../../../src/main/take-runtime';

test('eight PDF page images survive drafts, reopening, sends and follow-up replay',async()=>{
 const db=new PGlite();await migrate(db);
 const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const selection={provider:'claude' as const,model:'synthetic'};
 const models=async()=>({ok:true as const,source:'runtime' as const,models:[{value:'synthetic',label:'Synthetic',imageInput:true}]});
 const seen:Awaited<ReturnType<typeof nativeHistory>>[]=[];
 const execute:TakeExecutor=async input=>{seen.push(await nativeHistory(input.messages,input.image));input.text('Read the PDF.');};
 let service=createTakes(lifecycle,execute,models);
 const settle=async()=>{for(let n=0;n<300;n++){if(!service.busy())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Run did not finish');};
 try{
  await service.start();const id=await service.create();
  const images=[];
  for(let page=1;page<=8;page++){
   const meta={id:randomUUID(),name:`report.pdf — page ${page}.jpg`,mime:'image/jpeg',width:1,height:1,bytes:1};
   await service.storeImage(id,meta,'AA==');images.push(meta.id);
  }
  const text='Uploaded PDF reference "report.pdf".\nPage 1:\nSynthetic report';
  await service.update(id,{draft:text,draftImages:images});
  await service.close();service=createTakes(lifecycle,execute,models);await service.start();
  expect((await service.load(id)).draftImages).toHaveLength(8);
  await service.send({requestId:randomUUID(),takeId:id,parentId:null,text,images,selection});await settle();
  const take=await service.load(id);
  await service.send({requestId:randomUUID(),takeId:id,parentId:take.headId,text:'Explain page 8',selection});await settle();
  expect(seen).toHaveLength(2);
  expect(seen[1][0].parts.filter(p=>p.type==='image')).toHaveLength(8);
  expect(JSON.stringify(seen[1])).toContain('report.pdf — page 8.jpg');
  await expect(service.update(id,{draftImages:[...images,randomUUID()]})).rejects.toThrow();
 }finally{await service.close();await db.close();}
});
