import { expect, test } from 'vitest';
import { buildSourceDraft } from '../../../src/renderer/src/data-sources/source-draft';
import { sourceConfigSchema } from '../../../src/main/data-sources/config';
import { mapHttpSample } from '../../../src/main/data-sources/http-adapter';
import type { InspectedSourceField } from '../../../src/shared/data-sources';
const field = (path: string[], type: InspectedSourceField['type'] = 'number'): InspectedSourceField => ({ path, type, sample: 1, selectable: type !== 'array' });
const options = { name: 'Fixture', endpoint: 'https://fixture.example/value', credentialId: '', unit: 'points', collection: 'when-open' as const, pollIntervalMs: 15000, mode: 'history' as const, sampleEveryMs: 60000, retentionDays: 7 as const };
test('selected numeric field becomes a metric with independent polling and sampling', () => {
  const config = sourceConfigSchema.parse(buildSourceDraft({ ...options, fields: [field(['quote', 'price'])] }));
  expect(mapHttpSample(config, 'selected', { quote: { price: 12.5 }, ignored: 42 }).payload).toEqual({ kind: 'metric', value: '12.5' });
  expect(config.feeds[0].storage).toMatchObject({ fields: ['value'], sampleEveryMs: 60000 });
  expect(config.pollIntervalMs).toBe(15000);
});
test('multiple fields preserve exact paths, avoid alias collisions and only retain selected values', () => {
  const config = sourceConfigSchema.parse(buildSourceDraft({ ...options, fields: [field(['a.b'], 'string'), field(['a', 'b']), field(['ready'], 'boolean')] }));
  expect(mapHttpSample(config, 'selected', { 'a.b': 'literal', a: { b: 4 }, ready: true, ignored: 'private' }).payload).toEqual({ kind: 'event', fields: { field_1: 'literal', field_2: 4, field_3: true } });
  expect(config.feeds[0].storage.fields).toEqual(['field_1', 'field_2', 'field_3']);
  expect(() => mapHttpSample(config, 'selected', { 'a.b': 'literal', a: { b: 'changed' }, ready: true })).toThrow();
});
test('unsupported and oversized selections cannot produce source configurations', () => {
  for (const fields of [[], [field(['items'], 'array')], Array.from({ length: 33 }, (_, i) => field([String(i)]))]) expect(() => buildSourceDraft({ ...options, fields })).toThrow();
});
const market = {venue:'robinhood' as const,instance:'production' as const,kind:'equity' as const,reference:'AAPL'};
const price = {kind:'market-price' as const,market,currency:'USD' as const,policy:'replace-stale' as const,maxAgeMs:60000,allowSharedPriceWrites:true as const};
test('price destination maps only price with a separate provider timestamp and preserves feed identity', () => {
  const config = sourceConfigSchema.parse(buildSourceDraft({...options,fields:[field(['quote','price'])],destination:price,eventTimePath:['quote','time'],feedId:'existing'}));
  expect(config.feeds[0]).toMatchObject({id:'existing',unit:'USD',destination:price,eventTimePath:['quote','time'],storage:{fields:['value']}});
  const sample = mapHttpSample(config,'existing',{quote:{price:201.25,time:Date.now()}});
  expect(sample.payload).toEqual({kind:'metric',value:'201.25'});
  for (const change of [{mode:'live' as const}, {eventTimePath:[]}, {fields:[field(['a']),field(['b'])]}]) expect(() => buildSourceDraft({...options,fields:[field(['price'])],destination:price,eventTimePath:['time'],...change})).toThrow();
});
test('one metadata field remains an event, with explicit stable names and collision checks', () => {
  const input = {...options,fields:[field(['score'])],destination:{kind:'market-metadata' as const,market,namespace:'sentiment',maxAgeMs:60000},metadataKeys:['score']};
  const config = sourceConfigSchema.parse(buildSourceDraft(input));
  expect(mapHttpSample(config,'selected',{score:62}).payload).toEqual({kind:'event',fields:{score:62}});
  expect(config.feeds[0].storage.fields).toEqual(['score']);
  expect(() => buildSourceDraft({...input,metadataKeys:['constructor']})).toThrow();
  expect(() => buildSourceDraft({...input,fields:[field(['a']),field(['b'])],metadataKeys:['score','score']})).toThrow();
});
test('routed HTTP drafts preserve named mappings and selected retention with provider time',()=>{
 const destination={kind:'market-prices' as const,market:{venue:'coinbase' as const,instance:'production' as const,kind:'crypto' as const},symbolField:'product',priceField:'price',conditions:[{field:'product',op:'in' as const,values:['BTC-USD']}],currency:'USD' as const,policy:'replace-stale' as const,maxAgeMs:60000,allowSharedPriceWrites:true as const};
 const config=sourceConfigSchema.parse(buildSourceDraft({...options,destination,fields:[field(['product'],'string'),field(['price'],'string')],metadataKeys:['product','price'],eventTimePath:['time'],retainedFields:['price']}));
 expect(config.feeds[0]).toMatchObject({unit:'USD',destination,eventTimePath:['time'],storage:{fields:['price']}});
 expect(mapHttpSample(config,'selected',{product:'BTC-USD',price:'100.123',time:1000}).payload).toEqual({kind:'event',fields:{product:'BTC-USD',price:'100.123'}});
});

test('HTTP drafts preserve external identifier translation',()=>{
 const destination={kind:'market-prices' as const,market:{venue:'coinbase' as const,instance:'production' as const,kind:'crypto' as const},symbolField:'product',identifier:{kind:'external-id' as const,mappings:[{from:'vendor:42',to:'BTC-USD'}]},priceField:'price',conditions:[],currency:'USD' as const,policy:'replace-stale' as const,maxAgeMs:60000,allowSharedPriceWrites:true as const};
 const config=sourceConfigSchema.parse(buildSourceDraft({...options,destination,fields:[field(['id'],'string'),field(['price'],'string')],metadataKeys:['product','price'],eventTimePath:['time']}));
 expect(config.feeds[0].destination).toEqual(destination);
 expect(mapHttpSample(config,'selected',{id:'vendor:42',price:'100',time:1000}).payload).toEqual({kind:'event',fields:{product:'vendor:42',price:'100'}});
});

test('metadata response mapping omits null and missing fields but rejects wrong types',()=>{
 const config=sourceConfigSchema.parse({name:'Partial',endpoint:'https://fixture.example/value',feeds:[{id:'meta',name:'Metadata',unit:'points',mapping:{kind:'event',fields:{score:{path:['score'],type:'number'},note:{path:['note'],type:'string'}}},storage:{mode:'latest',fields:['score','note']},destination:{kind:'market-metadata',market,namespace:'partial',maxAgeMs:60000}}]});
 expect(mapHttpSample(config,'meta',{score:2})).toMatchObject({payload:{kind:'event',fields:{score:2}}});
 expect(mapHttpSample(config,'meta',{score:null,note:'new'})).toMatchObject({payload:{kind:'event',fields:{note:'new'}}});
 expect(()=>mapHttpSample(config,'meta',{score:'wrong'})).toThrow('type');
});
