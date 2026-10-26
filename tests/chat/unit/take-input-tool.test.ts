import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createTakeInputChat} from '../../../src/main/data-sources/take-input-chat';
import {callOpentakeTool} from '../../../src/main/opentake-mcp/server';
import {toolCatalog} from '../../../src/main/opentake-mcp/catalog';
import type {TakeInputSnapshot} from '../../../src/shared/take-inputs';
test('input tool is discoverable, read-only and rejects target or source overrides',async()=>{
 const definition=toolCatalog().find(tool=>tool.name==='opentake_read_take_inputs');expect(definition?.annotations.readOnlyHint).toBe(true);
 const takeInputs=vi.fn(async()=>({status:'blocked',reason:'no-inputs',inputs:[]})),status=vi.fn(),read=vi.fn();
 expect((await callOpentakeTool({takeInputs,status,read},'opentake_read_take_inputs',{})).isError).not.toBe(true);
 expect(takeInputs).toHaveBeenCalledTimes(1);
 for(const input of [{targetTakeId:randomUUID()},{sourceId:randomUUID()},{endpoint:'https://example.com'},null])expect((await callOpentakeTool({takeInputs,status,read},'opentake_read_take_inputs',input)).isError).toBe(true);
 expect(takeInputs).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled();expect(status).not.toHaveBeenCalled();
});
test('input tool binds the active run to its Take and strips unbound payload fields',async()=>{
 const db=new PGlite();await migrate(db);const take=randomUUID(),run=randomUUID(),source=randomUUID(),now=Date.now();let active=true;
 const snapshot:TakeInputSnapshot={takeId:take,bindingRevision:1,acceptedVersion:randomUUID(),capturedAt:now,status:'ready',reason:null,inputs:[{binding:{key:'sentiment',sourceId:source,sourceRevision:2,feedId:'signals',field:'score',kind:'event',unit:'score',maxAgeMs:15000},value:0.75,quality:'fresh',ageMs:0,observation:{sourceId:source,feedId:'signals',configVersion:2,schemaVersion:1,adapterId:'fixture',adapterVersion:'1',epoch:1,unit:'score',eventTime:now,receivedAt:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{score:0.75,unbound:'Do not expose this sibling field'}}}}]};
 const read=vi.fn(async()=>snapshot),service=createTakeInputChat({use:async fn=>fn(db)},read,()=>active);
 try{
  await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Fixture','{}' FROM local_owners",[take]);
  await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')",[run,take,randomUUID()]);
  const result=await service(run);expect(read).toHaveBeenCalledWith(take);expect(result.inputs[0]).toMatchObject({key:'sentiment',value:0.75,source:{id:source,revision:2,field:'score'}});expect(JSON.stringify(result)).not.toContain('unbound');
  active=false;await expect(service(run)).rejects.toThrow('stopped');active=true;
  read.mockImplementationOnce(async()=>{active=false;return snapshot;});await expect(service(run)).rejects.toThrow('stopped');active=true;
  read.mockResolvedValueOnce({...snapshot,status:'blocked',reason:'inputs-unavailable',inputs:[{...snapshot.inputs[0],value:null,quality:'source-changed',observation:null}]});expect(await service(run)).toMatchObject({status:'blocked',inputs:[{value:null,quality:'source-changed'}]});
  read.mockResolvedValueOnce({...snapshot,takeId:randomUUID()});await expect(service(run)).rejects.toThrow('scope');
  await db.query('UPDATE takes SET archived_at=now() WHERE id=$1',[take]);await expect(service(run)).rejects.toThrow('unavailable');
 }finally{await db.close();}
});
