import { expect, test } from 'vitest';
import { customSourceCapabilities, managedSourceCapabilities } from '../../../src/renderer/src/data-sources/source-capabilities';
import type { CustomDataSource } from '../../../src/shared/data-sources';
const source:CustomDataSource={id:'fixture',revision:1,enabled:false,validated:true,config:{name:'Fixture',endpoint:'https://fixture.example',collection:'when-open',pollIntervalMs:60000,feeds:[{id:'value',name:'Value',unit:'USD',mapping:{kind:'metric',valuePath:['price']},storage:{mode:'latest',fields:['value'],sampleEveryMs:60000,retentionDays:7}}]}};
test('custom capabilities preserve validation and destination review gates',()=>{
 expect(customSourceCapabilities(source)).toMatchObject({edit:true,collection:true,interval:'review',storage:'feed',destination:false});
 expect(customSourceCapabilities({...source,validated:false}).collection).toBe(false);
 expect(customSourceCapabilities({...source,config:{...source.config,collection:'off'}}).collection).toBe(false);
 const mapped=structuredClone(source);mapped.config.feeds[0].destination={kind:'market-price',market:{venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'},currency:'USD',policy:'fill-missing',maxAgeMs:60000,allowSharedPriceWrites:true};
 expect(customSourceCapabilities(mapped)).toMatchObject({destination:true,collection:false});
 expect(customSourceCapabilities({...mapped,enabled:true}).collection).toBe(true);
 mapped.config.feeds.push({...mapped.config.feeds[0],id:'second'});
 expect(customSourceCapabilities(mapped).edit).toBe(false);
});
test('managed capabilities allow inline cadence without exposing custom mappings',()=>{
 expect(managedSourceCapabilities).toEqual({edit:false,collection:true,interval:'inline',storage:'account',destination:false});
});
