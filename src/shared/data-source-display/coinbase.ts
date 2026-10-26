import type { CoinbaseMarketSnapshot } from '../coinbase-markets';
import type { DataSourcesAPI } from '../data-sources';

/** Adopt shared stored quotes only for the same public product observation.
 * Authenticated details, chart baselines and execution quotes retain their own authority. */
export async function loadCoinbaseDisplay(
  product: string, accountId: string | undefined,
  detail: (product:string, accountId?:string)=>Promise<CoinbaseMarketSnapshot>,
  storedPrice: DataSourcesAPI['storedMarketPrice'],
):Promise<CoinbaseMarketSnapshot> {
  const result=await detail(product,accountId);
  if(accountId||result.source!=='public')return result;
  try {
    const cached=await storedPrice({venue:'coinbase',instance:'production',kind:'crypto',reference:product});
    const q=cached.quote,m=cached.market;
    if(!q||!['fresh','stale'].includes(cached.quality)||m.venue!=='coinbase'||m.instance!=='production'||m.kind!=='crypto'||m.reference!==product||m.pair!==undefined||m.contract!==undefined||q.provider!=='coinbase'||q.currency!==result.market.quote||result.market.id!==product||q.receivedAt!==Date.parse(result.observedAt))return result;
    return {...result,market:{...result.market,price:q.payload.price},stale:result.stale||cached.quality==='stale'};
  }catch{
    // Cached projection is optional: keep the existing display on an IPC/read failure.
    return result;
  }
}
