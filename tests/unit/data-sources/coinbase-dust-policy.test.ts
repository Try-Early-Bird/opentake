import {expect,test} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCryptoDustPolicy} from '../../../src/main/data-sources/coinbase-stream/dust-policy';
test('validates and persists dust policy independently of credentials and database',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'coinbase-dust-test-'));
 try{
  const policy=createCryptoDustPolicy(directory);await policy.load();
  expect(policy.get()).toEqual({hide:true,threshold:'0.10'});
  await policy.save({hide:false,threshold:'5'});
  const restored=createCryptoDustPolicy(directory);await restored.load();
  expect(restored.get()).toEqual({hide:false,threshold:'5.00'});
  expect(()=>policy.save({hide:true,threshold:'-1'})).toThrow();
  expect(()=>policy.save({hide:true,threshold:'NaN'})).toThrow();
  expect(()=>policy.save({hide:'false',threshold:'1'})).toThrow();
 }finally{await rm(directory,{recursive:true,force:true});}
});
