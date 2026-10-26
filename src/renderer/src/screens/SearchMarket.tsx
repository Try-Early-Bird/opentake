import { Link, Navigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { marketHitSchema, type MarketHit } from '../../../shared/search';
import { MarketDetail } from './MarketDetail';
import { AddToListMenu } from '../components/AddToListMenu';

// The route carries a locator, not trusted instrument data. Resolve the provider
// reference before handing a Robinhood equity to the legacy symbol-based view.
export function SearchMarket() {
  const { market } = useParams({ from: '/markets/$market' });
  const [result, setResult] = useState<{ locator: string; hit: MarketHit | null } | null>(null);
  useEffect(() => {
    let live = true;
    const resolve = async () => {
      try {
        if (market.length > 2400) throw new Error('Invalid market');
        const hit = marketHitSchema.parse(JSON.parse(market));
        const resolved = await window.dataSources.marketSearch.resolve(hit);
        if (live) setResult({ locator: market, hit: resolved });
      } catch { if (live) setResult({ locator: market, hit: null }); }
    };
    void resolve(); return () => { live = false; };
  }, [market]);
  if (!result || result.locator !== market) return <p role="status">Loading market…</p>;
  const hit = result.hit;
  if (hit?.identity.venue === 'coinbase' && hit.identity.instance === 'production' && hit.identity.kind === 'crypto') return <Navigate to="/coinbase/$product" params={{ product: hit.identity.reference }} search={{}} replace />;
  if (!hit || hit.identity.venue !== 'robinhood' || hit.identity.instance !== 'production') return <section className="space-y-3"><h1 className="text-xl font-medium">Market unavailable</h1><p>This exact market could not be resolved. Check its venue connection or search again.</p><Link to="/settings" search={{ section: 'connections' }} className="underline">Manage connections</Link></section>;
  if (hit.identity.kind === 'crypto') return <section className="space-y-4">
    <p className="text-xs text-muted-foreground">{hit.venueLabel} · Crypto</p>
    <div className="flex items-start justify-between gap-4"><div><h1 className="text-xl font-medium">{hit.name}</h1><p className="text-sm text-muted-foreground">{hit.symbol}</p></div><AddToListMenu target={{ kind: 'market', market: { identity: hit.identity, symbol: hit.symbol, name: hit.name } }} /></div>
  </section>;
  if (!['equity', 'stock', 'etf'].includes(hit.identity.kind)) return <h1 className="text-xl font-medium">Market unavailable</h1>;
  return <><p className="mb-3 text-xs text-muted-foreground">{hit.venueLabel} · {hit.typeLabel}</p><MarketDetail key={JSON.stringify(hit.identity)} resolvedSymbol={hit.symbol} /></>;
}
