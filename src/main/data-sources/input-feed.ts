import {coinbaseSourceId} from '../../shared/coinbase-source';
import type {z} from 'zod';
import type {savedSourceConfig} from './saved-config';
export function coinbaseInputProduct(feedId:string){
 const match=/^price:([A-Z0-9]{1,40}-USD)$/.exec(feedId);
 return match&&match[1]!=='USD-USD'?match[1]:null;
}
/** Virtual, market-specific feeds belong only to the fixed Coinbase provider. */
export function takeInputFeed(sourceId:string,config:z.infer<typeof savedSourceConfig>,feedId:string){
 if('provider' in config&&config.provider){
  if(sourceId!==coinbaseSourceId||!coinbaseInputProduct(feedId))return undefined;
  return {id:feedId,unit:'USD',mapping:{kind:'metric' as const,valuePath:['price']}};
 }
 return config.feeds.find(feed=>feed.id===feedId);
}
export function takeInputCollection(config:z.infer<typeof savedSourceConfig>){
 return config.collection!=='off'&&(!('provider' in config&&config.provider)||config.collection==='automatic');
}
