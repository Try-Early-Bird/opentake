import { createTakeOverview } from '../../src/main/strategies/overview';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createTakeHistory } from '../../src/main/take-history';
import { createNotifications } from '../../src/main/notifications';
import { createCoinbasePortfolio } from '../../src/main/coinbase/portfolio';
import { createExecutionScheduler } from '../../src/main/execution/scheduler';
import { createCoinbaseScheduler } from '../../src/main/coinbase/scheduler';
import { NoCoinbaseOrdersError } from '../../src/main/coinbase/order-reviews';
import { createStrategies } from '../../src/main/strategies/service';
import { createCoinbaseCapital } from '../../src/main/coinbase/capital';
import { createCoinbaseTakePerformance } from '../../src/main/coinbase/take-performance';
import type { createFixture, Venue } from './fixture';

type Fixture = Awaited<ReturnType<typeof createFixture>>;
export interface FakeBehavior { delayMs?: number; slowCall?: number; slowMs?: number; rejectCall?: number }

export function createServices(fixture: Fixture, behavior: FakeBehavior = {}) {
  const { database, clock } = fixture;
  const unexpectedCalls: string[] = [];
  const calls: { venue: Venue; id: string; trigger: string; startedMs: number; outcome: 'ok' | 'error' }[] = [];
  const forbidden = (name: string) => () => {
    unexpectedCalls.push(name);
    throw new Error(`Unexpected performance fixture call: ${name}`);
  };
  // Full production objects have additional methods. Missing fake methods fail closed.
  function strictFake<T extends object>(methods: Partial<T>, label: string): T {
    return new Proxy(methods, { get(target, key) {
      return Reflect.has(target, key) ? Reflect.get(target, key) : forbidden(`${label}.${String(key)}`);
    } }) as T;
  }
  async function fakeCall(venue: Venue, id: string, trigger: string) {
    const call = { venue, id, trigger, startedMs: performance.now(), outcome: 'ok' as 'ok' | 'error' };
    calls.push(call);
    const number = calls.length;
    const wait = number === behavior.slowCall ? behavior.slowMs ?? 5000 : behavior.delayMs ?? 0;
    if (wait) await delay(wait);
    if (number === behavior.rejectCall) { call.outcome = 'error'; throw new Error('Synthetic provider failure'); }
  }
  const robinhood = createExecutionScheduler(database, {
    clock,
    planner: {
      async planAllocation(id, trigger) {
        await fakeCall('robinhood', id, trigger);
        return { allocationId: id, planId: null, disposition: 'up_to_date', reasonCode: null, executionIds: [], sleeves: [] };
      },
      planLiquidation: forbidden('planLiquidation'),
    },
    executor: { executeAllocation: forbidden('executeAllocation'), settleLegs: forbidden('settleLegs') },
  });
  const coinbase = createCoinbaseScheduler(database,
    strictFake<Parameters<typeof createCoinbaseScheduler>[1]>({
      async preview(input) {
        if (!input || typeof input !== 'object' || !('takeId' in input) || typeof input.takeId !== 'string') throw new Error('Invalid synthetic preview input');
        await fakeCall('coinbase', input.takeId, 'schedule');
        throw new NoCoinbaseOrdersError('No orders needed');
      },
    }, 'coinbase.orders'),
    strictFake<Parameters<typeof createCoinbaseScheduler>[2]>({ busy: () => false }, 'coinbase.execution'),
    () => true, clock);
  const history = createTakeHistory(database);
  const portfolio = createCoinbasePortfolio(database, {
    list: async () => fixture.accounts.filter(a => a.venue === 'coinbase').map(a => ({
      accountId: a.id, connectionId: a.connectionId, venue: 'coinbase' as const, environment: 'live' as const,
      label: 'Synthetic', portfolioName: 'Synthetic', maskedReference: 'Synthetic', status: 'connected' as const,
      checkedAt: new Date(clock()).toISOString(), permissions: { view: true as const, trade: false, transfer: false as const },
      capabilities: { accountRead: true, chat: false, trading: false }, issue: null,
    })),
    chatScope: forbidden('portfolio.chatScope'), assertChatScope: forbidden('portfolio.assertChatScope'), readChat: forbidden('portfolio.readChat'),
  }, clock);
  const notifications = createNotifications(database, { now: clock, deliver: () => {}, openDesktop: forbidden('openDesktop'), badge: () => {} });
  const strategies = createStrategies(database, { active: () => false, ensure: forbidden('strategies.ensure'), verify: forbidden('strategies.verify'), clock });
  const takePerformance = createCoinbaseTakePerformance(database, {
    candles: forbidden('prices.candles'),
    dailySpot: async product => {
      if (product !== 'USDC-USD') return forbidden('prices.dailySpot')();
      return '1'; // Synthetic cached conversion; no provider/cache-miss latency included.
    },
  }, clock);
  const capital = createCoinbaseCapital(database, clock, forbidden('capital.refresh'), takePerformance.summary);
  // Legacy list + per-row branch, retained as the pre-optimization control.
  async function takeDetails() {
    const rows = await strategies.list(false);
    return Promise.all(rows.map(async row => {
      const detail = await strategies.read(row.targetTakeId);
      // The renderer also catches unavailable Coinbase routes for Robinhood-only Takes.
      const funding = await capital.view(row.targetTakeId, true).catch(() => null);
      return { row, detail, funding };
    }));
  }
  return { history, portfolio, notifications, robinhood, coinbase, calls, unexpectedCalls, takeDetails, takeOverview:createTakeOverview(strategies,capital), strategies, capital,
    async stop() { await notifications.stop(); } };
}
