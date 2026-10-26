import { expect, test, vi } from 'vitest';
import { createCredentials } from '../../../src/main/credentials';
import { createHttpAdapter, httpFeedDefinitions } from '../../../src/main/data-sources/http-adapter';
import { sourceConfigSchema } from '../../../src/main/data-sources/config';
import { inspectSourceResponse } from '../../../src/main/data-sources/inspection';
import { credentialEchoValues } from '../../../src/main/data-sources/credential-echo';

test('collection rejects echoed request credentials in selected values and paths, without blocking unrelated fields', async () => {
 const records = new Map<string,string>();
 const store = {available:()=>true,get:async(id:string)=>records.get(id)??null,set:async(id:string,value:string)=>{records.set(id,value);},has:async(id:string)=>records.has(id),delete:async(id:string)=>{records.delete(id);}};
 const credentials=createCredentials(store);
 for(const auth of ['Bearer token','Custom header','Basic auth']) {
  const secret='fixture-password';
  const saved=await credentials.save({name:'Fixture '+auth,provider:'Fixture',type:'http-api',value:JSON.stringify({url:'https://fixture.example',auth,secret,header:'X-API-Key',username:'fixture-user'})});
  const credential=saved.find(item=>item.name==='Fixture '+auth)!;
  const config=sourceConfigSchema.parse({name:'Fixture',endpoint:'https://fixture.example/data',credentialId:credential.id,feeds:[{id:'event',name:'Record',unit:'record',mapping:{kind:'event',fields:{result:{path:['result'],type:'string'}}},storage:{mode:'latest',fields:['result']}}]});
  const source={id:'11111111-1111-4111-8111-111111111111',ownerId:'22222222-2222-4222-8222-222222222222',revision:1,enabled:true,validated:true,config};
  let body:unknown={result:'safe',unselected:secret};
  const adapter=createHttpAdapter({read:async()=>body},async()=>source,store);
  if(adapter.transport!=='http') throw Error();
  const context={feed:httpFeedDefinitions(source)[0],signal:new AbortController().signal,epoch:1,emit:vi.fn(),connected:vi.fn(),heartbeat:vi.fn(),fail:vi.fn()};
  await adapter.poll(context); expect(context.emit).toHaveBeenCalledOnce();
  const echoes=auth==='Basic auth'?[secret,'fixture-user:'+secret,Buffer.from('fixture-user:'+secret).toString('base64')]:[secret];
  for(const echo of echoes){
   context.emit.mockClear();context.fail.mockClear();body={result:'echo '+echo};
   await adapter.poll(context);
   expect(context.emit).not.toHaveBeenCalled();expect(context.fail).toHaveBeenCalledWith('invalid_data',{configuration:true});
   expect(JSON.stringify(context.fail.mock.calls)).not.toContain(secret);
  }
  config.feeds[0].mapping={kind:'event',fields:{result:{path:[secret],type:'string'}}};body={[secret]:'innocent'};
  context.emit.mockClear();await adapter.poll(context);expect(context.emit).not.toHaveBeenCalled();
 }
});
test('inspection and collection share Basic credential variants, including numeric echoes',()=>{
 const hidden=credentialEchoValues({kind:'basic',value:Buffer.from('fixture:123456789').toString('base64')});
 expect(inspectSourceResponse({value:123456789,other:42},hidden).fields.map(field=>field.path)).toEqual([['other']]);
 expect(credentialEchoValues()).toEqual([]);
});
