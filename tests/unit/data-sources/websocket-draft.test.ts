import {test,expect} from 'vitest';
import {buildWebsocketFeeds,routedMappingError,websocketFields} from '../../../src/renderer/src/data-sources/websocket-draft';
import {websocketSourceConfig} from '../../../src/main/data-sources/websocket/adapter';
import type {WebsocketSourceConfig} from '../../../src/shared/websocket-sources';
import type {InspectedSourceField} from '../../../src/shared/data-sources';
const fields:InspectedSourceField[]=[{path:['product'],type:'string',sample:'BTC-USD',selectable:true},{path:['last'],type:'string',sample:'120',selectable:true},{path:['volume'],type:'number',sample:42,selectable:true}];
const original:WebsocketSourceConfig={transport:'websocket',name:'Test',collection:'automatic',freshnessMs:15000,connection:{endpoint:'wss://fixture.example/prices',auth:{mode:'none'},subscription:{body:{op:'subscribe'}},acknowledgement:{success:{path:['op'],equals:'ok'},failure:{path:['op'],equals:'error'}}},feeds:[{id:'quotes',name:'Quotes',unit:'USD',eventTimePath:['time'],mapping:{kind:'event',fields:{symbol:{path:['product'],type:'string'},price:{path:['last'],type:'string'},volume:{path:['volume'],type:'number'}}},storage:{mode:'history',fields:['price'],sampleEveryMs:60000,retentionDays:7},destination:{kind:'market-prices',market:{venue:'coinbase',instance:'production',kind:'crypto'},symbolField:'symbol',priceField:'price',conditions:[{field:'volume',op:'gte',value:10}],currency:'USD',policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true}}]};
const input=()=>({original,fields,name:'Test',unit:'USD',dataMode:'json' as const,destination:original.feeds[0].destination!,timestamp:['time'],storage:original.feeds[0].storage});
test('editing routed WebSocket mappings preserves field keys, policy, timestamps and selected retention',()=>{
 const feeds=buildWebsocketFeeds(input());expect(feeds).toEqual(original.feeds);
 expect(websocketSourceConfig.parse({...original,feeds}).feeds[0].destination).toEqual(original.feeds[0].destination);
 const reordered=buildWebsocketFeeds({...input(),fields:[fields[2],fields[1],fields[0]]});expect(reordered[0].destination).toEqual(original.feeds[0].destination);
 expect(websocketFields([fields[1]],original.feeds[0].mapping)[0].key).toBe('price');
});
test('editor rejects removed routing or condition fields and leaves additional feeds unchanged',()=>{
 expect(()=>buildWebsocketFeeds({...input(),fields:fields.slice(0,1)})).toThrow('Choose string');
 expect(()=>buildWebsocketFeeds({...input(),fields:fields.slice(0,2)})).toThrow('condition');
 expect(()=>buildWebsocketFeeds({...input(),timestamp:[]})).toThrow('timestamp');
 const more={...original,feeds:[...original.feeds,{...original.feeds[0],id:'second'}]};
 expect(buildWebsocketFeeds({...input(),original:more})[1]).toEqual(more.feeds[1]);
 expect(()=>buildWebsocketFeeds({...input(),dataMode:'text'})).toThrow('JSON');
});
test('new routed mappings preserve string prices and reject incomplete holdings or condition values',()=>{
 const destination={...original.feeds[0].destination!,symbolField:'field_1',priceField:'field_2',conditions:[]} as Extract<NonNullable<WebsocketSourceConfig['feeds'][number]['destination']>,{kind:'market-prices'}>;
 expect(buildWebsocketFeeds({...input(),original:undefined,destination})[0].mapping.kind).toBe('event');
 expect(routedMappingError({...destination,conditions:[{field:'field_3',op:'gt',value:NaN}]},websocketFields(fields),['time'])).toMatch(/condition/);
 expect(routedMappingError({...destination,holdings:{accountIds:[],maxAgeMs:900000}},websocketFields(fields),['time'])).toMatch(/account/);
});
test('existing fixed string-price mapping stays a metric when edited',()=>{
 const destination={kind:'market-price' as const,market:{venue:'robinhood' as const,instance:'production' as const,kind:'equity' as const,reference:'AAPL'},currency:'USD' as const,policy:'replace-stale' as const,maxAgeMs:60000,allowSharedPriceWrites:true as const};
 const feeds=buildWebsocketFeeds({...input(),original:undefined,fields:[fields[1]],destination});
 expect(feeds[0].mapping).toEqual({kind:'metric',valuePath:['last']});
 expect(websocketSourceConfig.parse({...original,feeds}).feeds[0].destination).toEqual(destination);
});

test('editor retains explicit ID maps and rejects incomplete or incompatible IDs',()=>{
 const base=input();if(base.destination.kind!=='market-prices')throw Error();
 const destination={...base.destination,identifier:{kind:'external-id' as const,mappings:[{from:'vendor:42',to:'BTC-USD'}]}};
 const feed=buildWebsocketFeeds({...base,destination})[0];
 expect(feed.destination).toEqual(destination);
 expect(websocketSourceConfig.parse({...original,feeds:[feed]}).feeds[0].destination).toEqual(destination);
 expect(()=>buildWebsocketFeeds({...base,destination:{...destination,identifier:{kind:'external-id',mappings:[]}}})).toThrow('ID mappings');
 expect(()=>buildWebsocketFeeds({...base,destination:{...destination,identifier:{kind:'symbol'}}})).toThrow('Robinhood');
});

test('WebSocket metadata drafts preserve namespace, field names and reject text or duplicate fields',()=>{
 const destination={kind:'market-metadata' as const,market:{venue:'robinhood' as const,instance:'production' as const,kind:'equity' as const,reference:'AAPL'},namespace:'sentiment',maxAgeMs:60000};
 const feed=buildWebsocketFeeds({...input(),destination,metadataKeys:['product','last','volume']})[0];
 expect(feed.destination).toEqual(destination);
 expect(feed.mapping).toMatchObject({kind:'event',fields:{last:{path:['last'],type:'string'}}});
 expect(websocketSourceConfig.parse({...original,feeds:[feed]}).feeds[0].destination).toEqual(destination);
 expect(()=>buildWebsocketFeeds({...input(),destination,metadataKeys:['same','same','volume']})).toThrow('unique');
 expect(()=>buildWebsocketFeeds({...input(),destination,dataMode:'text'})).toThrow('JSON');
 expect(()=>buildWebsocketFeeds({...input(),destination:{...destination,namespace:'__proto__'}})).toThrow('namespace');
});
