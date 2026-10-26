import {test,expect} from 'vitest';
import {defaultCoinbasePriceMappings,coinbasePriceMappingSchema} from '../../../src/shared/coinbase-field-mappings';
import {previewPriceMapping,inspectPriceMapping} from '../../../src/main/data-sources/coinbase-stream/price-mapping-preview';
import {createCoinbaseProtocol} from '../../../src/main/data-sources/coinbase-stream/protocol';
const now=Date.parse('2026-10-19T12:00:00Z');
const raw={channel:'market_trades',sequence_num:0,timestamp:new Date(now).toISOString(),events:[{type:'update',trades:[{trade_id:'1',product_id:'BTC-USD',price:'100',size:'0.1',side:'BUY',time:new Date(now).toISOString(),alternative:{price:'101'}}]}]};
const messages={cursor:1,total:1,startedAt:now,messages:[{id:1,receivedAt:now,type:'json' as const,text:JSON.stringify(raw),bytes:300}]};
test('Coinbase default and edited price paths preview and drive typed live trades',()=>{
 expect(previewPriceMapping(messages,defaultCoinbasePriceMappings,now).price).toBe('100');
 const mapping={...defaultCoinbasePriceMappings,price:['alternative','price']};
 expect(previewPriceMapping(messages,mapping,now).price).toBe('101');
 const parser=createCoinbaseProtocol(['BTC-USD'],{},[],mapping);parser.accept(JSON.stringify(raw));
 expect(parser.trades('BTC-USD')[0]).toMatchObject({price:'101',product_id:'BTC-USD',origin:'live'});
 expect(()=>previewPriceMapping(messages,mapping,now+16000)).toThrow('fresh trade');
 expect(()=>coinbasePriceMappingSchema.parse({...mapping,price:['__proto__','price']})).toThrow();
 const invalid=createCoinbaseProtocol(['BTC-USD'],{},[],{...mapping,price:['missing']});
 expect(()=>invalid.accept(JSON.stringify(raw))).toThrow();expect(()=>previewPriceMapping(messages,{...mapping,price:['missing']},now)).toThrow();
});

test('trade inspection returns bounded safe fields and rejects stale samples',()=>{
 const withSecret={...raw,events:[{type:'update',trades:[{...raw.events[0].trades[0],api_key:'hidden'}]}]};
 const inspected=inspectPriceMapping({...messages,messages:[{...messages.messages[0],text:JSON.stringify(withSecret)}]},now);
 expect(inspected.fields.find(field=>field.path.join('.')==='alternative.price')?.sample).toBe('101');
 expect(inspected.fields.some(field=>field.path.includes('api_key'))).toBe(false);
 expect(()=>inspectPriceMapping(messages,now+16000)).toThrow('recent trade');
 expect(()=>inspectPriceMapping({...messages,messages:[{...messages.messages[0],text:'null'}]},now)).toThrow('recent trade');
});
