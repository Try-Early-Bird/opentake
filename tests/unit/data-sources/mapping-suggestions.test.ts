import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {marketSuggestions,marketSuggestionRequest} from '../../../src/main/data-sources/market-suggestions';
import {suggestedFields,suggestedMetadataKey} from '../../../src/renderer/src/data-sources/mapping-suggestions';
import type {InspectedSourceField} from '../../../src/shared/data-sources';
const field=(name:string,type:InspectedSourceField['type']='string',selectable=true):InspectedSourceField=>({path:['quote',name],type,sample:null,selectable});
test('field suggestions rank compatible names without guessing incompatible types',()=>{
 const fields=[field('other'),field('price','number'),field('lastPrice'),field('symbol'),field('price','string',false),field('timestamp','number')];
 expect(suggestedFields(fields,'price').map(x=>[x.field.path[1],x.suggested])).toEqual([['lastPrice',true],['other',false],['symbol',false]]);
 expect(suggestedFields(fields,'identifier')[0].field.path[1]).toBe('symbol');
 expect(suggestedFields(fields,'timestamp').map(x=>x.field.path[1])).toEqual(['timestamp','price']);
 expect(suggestedMetadataKey(field('__proto__'),[])).toBe('field');
 expect(suggestedMetadataKey(field('sentiment score'),['sentiment_score'])).toBe('sentiment_score_2');
});
test('market suggestions are bounded local venue-specific identities with literal search',async()=>{
 const db=new PGlite();await migrate(db);
 try{
  await db.query("INSERT INTO market_quotes(symbol,price,observed_at) VALUES('AAPL',100,now()),('MSFT',100,now())");
  for(const [id,quote] of [['BTC-USD','USD'],['BTC-USDC','USDC'],['ETH-USD','USD']])await db.query("INSERT INTO public_price_cache(provider,pair,kind,interval_seconds,bucket,data,fetched_at) VALUES('coinbase',$1,'product',0,0,$2,now())",[id,JSON.stringify({id,venue:'coinbase',base:id.split('-')[0],quote})]);
  expect(await marketSuggestions(db,'robinhood','aa')).toEqual(['AAPL']);
  expect(await marketSuggestions(db,'coinbase','btc')).toEqual(['BTC-USD']);
  expect(await marketSuggestions(db,'coinbase','AAPL')).toEqual([]);
  expect(await marketSuggestions(db,'robinhood','%')).toEqual([]);
  expect(await marketSuggestions(db,'coinbase','')).toEqual(['BTC-USD','ETH-USD']);
  expect(()=>marketSuggestionRequest.parse({action:'market-suggestions',venue:'coinbase',query:'x'.repeat(81)})).toThrow();
 }finally{await db.close();}
});

test('shared selector respects Coinbase string timestamps and retains missing saved paths',async()=>{
 const {mappingFieldItems}=await import('../../../src/renderer/src/data-sources/mapping-suggestions');
 const fields=[field('time'),field('timestamp','number'),field('price')].map(field=>({key:JSON.stringify(field.path),field}));
 const items=mappingFieldItems(fields,'timestamp','["old_time"]','string');
 expect(items.find(item=>item.value==='["quote","time"]')?.label).toContain('Suggested');
 expect(items.some(item=>item.value==='["quote","timestamp"]')).toBe(false);
 expect(items.find(item=>item.value==='["old_time"]')?.label).toContain('missing or incompatible');
 expect(mappingFieldItems([],'price','["price"]','string',false)[1].label).toBe('price · configured');
});
