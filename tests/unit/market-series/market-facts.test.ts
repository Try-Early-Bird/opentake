import {expect,test} from 'vitest';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMarketFacts,LOGO_MISS_TTL_MS} from '../../../src/main/market-series/market-facts';
import {ConnectionFailure} from '../../../src/main/connection-errors';

const png=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
const connected={status:async()=>({status:'connected'}) as never};

test('logos are fetched once, cached on disk, and misses are remembered until they expire',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opentake-logos-'));let now=Date.now();
 try{
  const requests:string[]=[];
  const fetcher=(async(url:string)=>{requests.push(url);return url.includes('/VTI.')?new Response(png):new Response('<html>',{status:200});}) as unknown as typeof fetch;
  const facts=createMarketFacts({...connected,readTool:async()=>({})},dir,fetcher,()=>now);
  const url=await facts.logo('VTI');
  expect(url).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  // A fresh instance reads the profile copy without going upstream.
  expect(await createMarketFacts({...connected,readTool:async()=>({})},dir,fetcher,()=>now).logo('VTI')).toBe(url);
  expect(requests).toEqual(['https://financialmodelingprep.com/image-stock/VTI.png']);
  // A non-image answer is a miss: no logo, remembered, retried after the TTL.
  expect(await facts.logo('ZZZZ')).toBeNull();
  expect(await facts.logo('ZZZZ')).toBeNull();
  expect(requests.filter(r=>r.includes('ZZZZ'))).toHaveLength(1);
  now+=LOGO_MISS_TTL_MS+60_000;
  expect(await facts.logo('ZZZZ')).toBeNull();
  expect(requests.filter(r=>r.includes('ZZZZ'))).toHaveLength(2);
  await expect(facts.logo('../etc')).rejects.toThrow('Invalid symbol');
  expect((await readdir(dir)).sort()).toEqual(['VTI','ZZZZ.missing']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a transient upstream failure is not remembered as a miss',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opentake-logos-'));
 try{
  let calls=0;
  const fetcher=(async()=>{calls++;if(calls===1)throw new Error('offline');return new Response(png);}) as unknown as typeof fetch;
  const facts=createMarketFacts({...connected,readTool:async()=>({})},dir,fetcher);
  expect(await facts.logo('VTI')).toBeNull();
  expect(await facts.logo('VTI')).toMatch(/^data:image\/png;base64,/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('market detail takes the name from search and the symbol record from fundamentals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opentake-logos-'));
 try{
  const reads:string[]=[];
  const facts=createMarketFacts({...connected,readTool:async(name:string)=>{
   await Promise.resolve();
   reads.push(name);return name==='search'
   ?{data:{results:[{symbol:'VT',instrument_id:'a',simple_name:'Other'},{symbol:'VTI',instrument_id:'b',simple_name:'Vanguard Total Stock Market ETF'}]}}
   :{results:[{symbol:'VTI',market_cap:'1',dividends:[{amount:'1'}]}]};}},dir,fetch,()=>Date.now());
  expect(await facts.detail('VTI')).toEqual({symbol:'VTI',displayName:'Vanguard Total Stock Market ETF',fundamentals:{symbol:'VTI',market_cap:'1',dividends:[{amount:'1'}]}});
  await facts.detail('VTI');
  expect(reads).toEqual(['search','get_equity_fundamentals']);
  const offline=createMarketFacts({status:async()=>({status:'disconnected'}) as never,readTool:async()=>{throw new Error('unreachable');}},dir);
  expect(await offline.detail('VTI')).toEqual({symbol:'VTI',displayName:'VTI',fundamentals:null});
 }finally{await rm(dir,{recursive:true,force:true});}
});
