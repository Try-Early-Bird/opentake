import type { PortfolioView } from '../../../shared/portfolio';
import type { ActivityItem } from '../components/ActivityRows';
import type { PortfolioHistoryPoint, PortfolioRange } from '../portfolio-history';
import { chartTradingDay, classifySession, type SymbolSeries } from '../market-series';
import type { Position } from './types';

export function rangePoints<T extends { observedAt: string }>(points: T[], range: PortfolioRange, now = Date.now()): T[] {
  const days = { '1w': 7, '1m': 30, '3m': 90, '1y': 366, all: 366 };
  const start = range === '1d' ? chartTradingDay(now).dayStartMs : now - days[range] * 86400000;
  return points.filter(p => Date.parse(p.observedAt) >= start && Date.parse(p.observedAt) <= now);
}
export function portfolioPoints(view: PortfolioView | null, range: PortfolioRange): PortfolioHistoryPoint[] {
  const history = (view?.history ?? []).filter(p => p.currency === view?.portfolio?.currency && (range !== '1d' || p.resolution !== 'daily'));
  const points = view?.account?.venue === 'coinbase' && range === '1d' ? history.filter(p => Date.parse(p.observedAt) >= Date.now()-86400000 && Date.parse(p.observedAt) <= Date.now()) : rangePoints(history, range);
  return points
    .map(p => ({ observedAt: p.observedAt, totalAssetValue: p.totalValue, observed: !p.reconstructed }));
}
export function portfolioHoldings(view: PortfolioView | null): (Position & { markPrice: string | null })[] {
  return (view?.positions ?? []).map(p => ({
    marketRef: `${p.assetClass}:${p.instrumentRef}`, symbol: p.symbol ?? p.instrumentRef,
    assetClass: p.assetClass, side: p.side ?? (Number(p.quantity) < 0 ? 'short' : 'long'), size: p.quantity,
    averageEntryPrice: p.averageCost ?? null, positionValue: p.marketValue,
    unrealizedPnl: p.providerUnrealizedPnl ?? null, realizedPnl: p.providerRealizedPnl ?? null, markPrice: p.markPrice,
  })).sort((a,b) => Number(b.positionValue ?? 0) - Number(a.positionValue ?? 0));
}
export function positionSeries(view: PortfolioView | null, range: PortfolioRange): Map<string, SymbolSeries> {
  const result = new Map<string, SymbolSeries>();
  for (const position of view?.positions ?? []) {
    const observed = rangePoints((view?.positionHistory ?? []).filter(p => p.instrumentRef === position.instrumentRef
      && p.assetClass === position.assetClass && p.currency === position.currency), range);
    if (observed.length === 0) continue;
    const first = Number(observed[0].markPrice), last = Number(observed.at(-1)!.markPrice);
    const day = chartTradingDay(Date.parse(observed.at(-1)!.observedAt));
    result.set(`${position.assetClass}:${position.instrumentRef}`, {
      symbol: position.symbol ?? position.instrumentRef, interval: 'hour', bounds: '24_5',
      ...(range === '1d' ? { dayStart: new Date(day.dayStartMs).toISOString(), dayEnd: new Date(day.dayEndMs).toISOString() } : {}),
      baseline: { price: observed[0].markPrice, kind: 'first_bar' }, price: observed.at(-1)!.markPrice,
      extendedPrice: null, extendedSession: null, extendedChange: null,
      change: observed.length < 2 || first === 0 ? null : { amount: String(last-first), percent: String((last-first)/first*100) },
      points: observed.map(p => ({ t: p.observedAt, c: p.markPrice, s: classifySession(Date.parse(p.observedAt)) })),
    });
  }
  return result;
}
export function portfolioActivity(view: PortfolioView | null): ActivityItem[] {
  const events:ActivityItem[]=(view?.orderActivity??[]).map(event=>({id:`order:${event.id}`,occurredAt:event.observedAt,provider:event.venue,assetClass:'order',symbol:event.symbol,displayName:event.symbol,side:event.side==='buy'?'buy':'sell',quantity:'0',price:'0',notional:null,fee:null,orderState:event.execution.state,orderType:null,timeInForce:null,orderQuantity:null,orderSubmittedAt:null,source:'app',strategy:null,orderEvent:event}));
  const sort=(items:ActivityItem[])=>[...events,...items].sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.id.localeCompare(a.id));
  const capital=(view?.capitalActivity??[]).map<ActivityItem>(event=>({
    id:`capital:${event.id}`,occurredAt:event.occurredAt,provider:'coinbase',assetClass:'capital',
    symbol:event.asset,displayName:event.takeTitle,side:null,quantity:event.quantity,price:'0',notional:null,fee:null,
    orderState:'completed',orderType:null,timeInForce:null,orderQuantity:null,orderSubmittedAt:null,source:'app',strategy:null,
    capital:event,
  }));
  const fills=(view?.executions ?? []).map<ActivityItem>(e => {
    const order = view?.orders.find(o => o.providerOrderRef === e.orderRef);
    return {
      currency:e.currency, id: `fill:${e.providerExecutionRef}`, occurredAt: e.occurredAt, provider: view?.account?.venue ?? '',
      assetClass: e.assetClass, symbol: e.symbol, displayName: e.symbol ?? 'Instrument',
      side: e.side === 'buy' || e.side === 'sell' ? e.side : null, quantity: e.quantity, price: e.price,
      // Options can have nonstandard multipliers; only use provider notional.
      notional: e.notionalAmount ?? (e.assetClass === 'equity' ? String(Number(e.quantity)*Number(e.price)) : null),
      fee: e.feeAmount ?? null, orderState: order?.state ?? 'filled', orderType: order?.orderType ?? null,
      timeInForce: order?.timeInForce ?? null, orderQuantity: order?.quantity ?? null,
      orderSubmittedAt: order?.sourceCreatedAt ?? null, source: 'external', strategy: null,
    };
  });
  if(view?.account?.venue!=='coinbase')return sort(fills);
  const representedOrders=new Set((view.executions??[]).map(e=>e.orderRef));
  const transactions=(view.accountTransactions??[]).filter(tx=>!(tx.type==='advanced_trade_fill'&&tx.orderRef&&representedOrders.has(tx.orderRef))).map<ActivityItem>(tx=>({
    id:`transaction:${tx.id}`,occurredAt:tx.occurredAt,provider:'coinbase',assetClass:'transaction',symbol:tx.asset,displayName:tx.asset,
    side:null,quantity:tx.amount,price:'0',notional:null,fee:null,orderState:tx.status,orderType:null,timeInForce:null,orderQuantity:null,orderSubmittedAt:null,source:'external',strategy:null,transaction:tx,
  }));
  return sort([...capital,...fills,...transactions]);
}

/** Asset activity is scoped by the supplied account snapshot, never by a matching Take weight. */
export function assetActivity(view: PortfolioView | null, symbol: string): ActivityItem[] {
  return portfolioActivity(view).filter(item => !item.capital &&
    (item.provider === 'coinbase' ? item.symbol?.split('-')[0] : item.symbol)?.toUpperCase() === symbol.toUpperCase());
}
