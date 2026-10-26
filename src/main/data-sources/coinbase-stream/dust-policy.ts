import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {atomicPrivateWrite} from '../../private-files';
import {defaultCryptoDustPolicy,normalizeDustThreshold,type CryptoDustPolicy} from '../../../shared/crypto-dust';
const schema=z.object({hide:z.boolean(),threshold:z.string().max(32).refine(value=>normalizeDustThreshold(value)!==null).transform(value=>normalizeDustThreshold(value)!)}).strict();
export function createCryptoDustPolicy(profile:string){
 const path=join(profile,'crypto-dust-settings.json');
 let current:CryptoDustPolicy={...defaultCryptoDustPolicy},writes:Promise<unknown>=Promise.resolve();
 return {
  get:()=>current,
  async load(){try{current=schema.parse(JSON.parse(await readFile(path,'utf8')));}catch{/* Default until renderer restores its validated preference. */}},
  save(raw:unknown){
   const value=schema.parse(raw);
   const write=writes.catch(()=>{}).then(async()=>{
    if(value.hide===current.hide&&value.threshold===current.threshold)return;
    await atomicPrivateWrite(path,Buffer.from(JSON.stringify(value)));current=value;
   });
   writes=write;return write;
  },
 };
}
