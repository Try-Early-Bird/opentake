import {defaultCoinbasePriceMappings} from './coinbase-field-mappings';
import { z } from 'zod';
import type { WebsocketSourceConfig } from './websocket-sources';
export const coinbaseSubscriptionSchema = z.object({
  holdings: z.boolean(), views: z.boolean(),
  products: z.array(z.string().regex(/^[A-Z0-9]{1,40}-USD$/).refine(value=>value!=='USD-USD','Choose a tradable market')).max(100)
    .refine(items => new Set(items).size === items.length, 'Markets must be unique'),
}).strict();
export type CoinbaseSubscriptions = z.infer<typeof coinbaseSubscriptionSchema>;
export const defaultCoinbaseSubscriptions: CoinbaseSubscriptions = {holdings:true,views:true,products:[]};
export const coinbaseSourceId = 'ccbb0000-0000-4000-8000-000000000001';
export const defaultCoinbaseSourceConfig: WebsocketSourceConfig = {
  transport:'websocket',name:'Coinbase market data',collection:'automatic',freshnessMs:15000,
  provider:{kind:'coinbase-market',priceMappings:defaultCoinbasePriceMappings,subscriptions:defaultCoinbaseSubscriptions},
  connection:{endpoint:'wss://advanced-trade-ws.coinbase.com',dataMode:'text',auth:{mode:'none'},
    subscription:{body:{type:'subscribe',channel:'market_trades'}},
    acknowledgement:{success:{path:['channel'],equals:'subscriptions'},failure:{path:['type'],equals:'error'}}},
  feeds:[{id:'messages',name:'Messages',unit:'text',mapping:{kind:'text'},storage:{mode:'live',fields:['value'],sampleEveryMs:60000,retentionDays:7}}],
};
