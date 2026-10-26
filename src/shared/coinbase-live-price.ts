import type { CoinbaseStreamRead } from './coinbase-stream';
/** Heartbeats establish continuity, not freshness of a last-trade price. */
export function freshCoinbaseTrade(snapshot: CoinbaseStreamRead['snapshot'], product: string, now: number): string | null {
  if (!snapshot || snapshot.product !== product || snapshot.connection !== 'live' || snapshot.continuity !== 'live') return null;
  const trade = snapshot.trades.find(item => item.product_id === product && item.origin === 'live');
  if (!trade) return null;
  const age = now - Date.parse(trade.time), price = Number(trade.price);
  return Number.isFinite(age) && age >= -2000 && age <= 15_000 && Number.isFinite(price) && price > 0 ? trade.price : null;
}
