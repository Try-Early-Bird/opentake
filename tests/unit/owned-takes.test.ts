import { overviewDetail } from '../../src/main/strategies/overview';
import { describe, expect, it } from 'vitest';
import type { BasketSummary, BasketView } from '../../src/shared/strategies';
import type { PortfolioView } from '../../src/shared/portfolio';
import type { HoldingWithPnl } from '../../src/renderer/src/strategies/follow-data';
import { ownedTakeRow } from '../../src/renderer/src/strategies/owned-takes';

const summary: BasketSummary = { strategyId: 's1', targetTakeId: 't1', title: 'Take', status: 'committed', dirty: true, archivedAt: null };
const view = { currentVersion: 'v1', versions: [{ id: 'v1', sequence: 1, createdAt: '2026-01-01', payload: { metadata: { description: 'Published idea' }, spec: { target: { cashBps: 1000 } } } }], draft: { metadata: { description: 'Uncommitted idea' }, spec: { target: { cashBps: 2000 } } } } as unknown as BasketView;
const portfolio = (values: (string | null)[]): PortfolioView => ({ strategies: [...values.map((value, index) => ({ allocationId: String(index), strategyId: 's1', value })), { strategyId: 'other', value: '9999' }], portfolio: { currency: 'USD' } }) as unknown as PortfolioView;

describe('owned take rows', () => {
  it('sums only this take’s allocations and displays the published payload', () => {
    const row = ownedTakeRow(summary, view, portfolio(['125.50', '74.50']));
    expect(row).toMatchObject({ investedValue: '200', totalPnl: null, returnPercent: null, description: 'Published idea', startedAt: '2026-01-01' });
    expect(row.spec?.target.cashBps).toBe(1000);
  });
  it('distinguishes no investment from unavailable or incomplete valuations', () => {
    expect(ownedTakeRow(summary, view, portfolio([])).investedValue).toBe('0');
    expect(ownedTakeRow(summary, view, portfolio(['100', null])).investedValue).toBeNull();
    expect(ownedTakeRow(summary, view, null)).toMatchObject({ investedValue: null, returnPercent: null });
  });
  it('uses the draft when no version is committed and does not invent an age from truncated history', () => {
    expect(ownedTakeRow({ ...summary, status: 'draft' }, { ...view, currentVersion: null, versions: [] }, portfolio([])).description).toBe('Uncommitted idea');
    expect(ownedTakeRow(summary, { ...view, versions: [{ ...view.versions[0]!, sequence: 12 }] }, portfolio([])).startedAt).toBeNull();
  });
  it('weights actual returns by capital and excludes unrelated investments', () => {
    const holding = (id: string, capital: string, percent: string | null) => ({ bucket: { id }, strategy: { id: 's1' }, valuation: { complete: true }, pnl: { capitalAllocated: capital, allTimeReturn: percent } }) as HoldingWithPnl;
    const holdings = [holding('0', '100', '10'), holding('1', '300', '-10'), holding('other', '9999', '100')];
    expect(ownedTakeRow(summary, view, portfolio(['110', '270']), holdings)).toMatchObject({ totalPnl: -20, returnPercent: -5 });
    expect(ownedTakeRow(summary, view, portfolio(['110', null]), holdings).totalPnl).toBeNull();
    expect(ownedTakeRow(summary, view, portfolio(['110.01']), [holdings[0]!]).totalPnl).toBeCloseTo(10.01);
    expect(ownedTakeRow(summary, view, portfolio(['110', '270']), [holdings[0]!, holding('1', '300', null)]).returnPercent).toBeNull();
    expect(ownedTakeRow(summary, view, portfolio(['0']), [holding('0', '0', '0')]).returnPercent).toBeNull();
  });

});

it('includes Coinbase holdings even when their current price is unavailable', () => {
 const capital = {accountId:'cb',accountLabel:'Test',takeTitle:'Take',balances:[{asset:'BTC',quantity:'0.00005',reserved:'0'}],valuation:{currency:'USD',value:'4.20'}};
 expect(ownedTakeRow(summary,view,portfolio([]),null,capital)).toMatchObject({funded:true,investedValue:'4.2',totalPnl:null});
 expect(ownedTakeRow(summary,view,portfolio([]),null,{...capital,valuation:{currency:'USD',value:null}})).toMatchObject({funded:true,investedValue:null});
 expect(ownedTakeRow(summary,view,portfolio(['10']),null,capital)).toMatchObject({funded:true,investedValue:'14.2',totalPnl:null});
 expect(ownedTakeRow(summary,view,portfolio([]),null,{...capital,balances:[],valuation:{currency:'USD',value:'0'}})).toMatchObject({funded:false,investedValue:'0'});
});

it('uses Coinbase panel P&L and combines it with Robinhood without omitting unavailable values',()=>{
 const cb={accountId:'cb',accountLabel:'Test',takeTitle:'Take',balances:[{asset:'BTC',quantity:'1',reserved:'0'}],valuation:{currency:'USD',value:'98'},pnl:{currency:'USD',gain:'-2',returnPercent:'-2'}};
 expect(ownedTakeRow(summary,view,portfolio([]),null,cb)).toMatchObject({totalPnl:-2,returnPercent:-2});
 const rh={bucket:{id:'0'},strategy:{id:'s1'},valuation:{complete:true},pnl:{capitalAllocated:'100',allTimeReturn:'10'}} as HoldingWithPnl;
 expect(ownedTakeRow(summary,view,portfolio(['110']),[rh],cb)).toMatchObject({totalPnl:8,returnPercent:4,investedValue:'208'});
 expect(ownedTakeRow(summary,view,portfolio(['110']),null,cb).totalPnl).toBeNull();
 expect(ownedTakeRow(summary,view,portfolio([]),null,{...cb,pnl:undefined}).totalPnl).toBeNull();
 expect(ownedTakeRow(summary,view,portfolio([]),null,{...cb,pnl:{...cb.pnl,currency:'EUR'}}).totalPnl).toBeNull();
 expect(ownedTakeRow(summary,view,portfolio([]),null,{...cb,pnl:{...cb.pnl,gain:'0',returnPercent:'0'}})).toMatchObject({totalPnl:0,returnPercent:0});
});


it('compact overview details preserve row output without transferring revision history', () => {
  const versions = Array.from({ length: 200 }, (_, i) => ({ ...view.versions[0], id: `v${200-i}`, sequence: 200-i }));
  for (const detail of [null, view, { ...view, versions, currentVersion: 'v150' },
    { ...view, versions: versions.map(v => ({ ...v, sequence: v.sequence + 200 })), currentVersion: 'v150' },
    { ...view, versions: [], currentVersion: null }]) {
    for (const status of ['draft', 'committed'] as const) {
      expect(ownedTakeRow({ ...summary, status }, overviewDetail(detail), portfolio(['100'])))
        .toEqual(ownedTakeRow({ ...summary, status }, detail, portfolio(['100'])));
    }
    if (detail) {
      expect(overviewDetail(detail)?.versions.length).toBeLessThanOrEqual(2);
      expect(overviewDetail(detail)).not.toHaveProperty('proposals');
    }
  }
});
