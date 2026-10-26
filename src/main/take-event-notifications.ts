import type { DatabaseClient as PGlite } from './database-client';
import type { NotificationInput, TakeEventKind } from '../shared/notifications';
import { classifyUnexplainedIncrease } from './allocations/reinvestment-inference';

// Derived feed items (delistings, shortfalls, outside sales and archive
// closures), kept as durable local notifications the way trading-notifications.ts
// keeps the queue: each pass derives what is true now, records anything new
// once, and resolves what is no longer true. Notices that need a decision are
// act-now; holdings not bought and delistings are informational, as hosted.
// Self-hosted additions: an order of unknown outcome and a take that overspent
// its cash, both of which hosted left to an operator.

const DAY = 86_400_000;
interface EventRow { event: TakeEventKind; allocation_id: string; strategy_id: string; name: string | null; symbol: string | null; detail: string | null; at: Date | string;
  /** Distinguishes a later occurrence of the same event: a notice is recorded once per key and never revived. */
  occurrence: string }

const ACT_NOW = new Set<TakeEventKind>(['strategy_archived', 'close_failed', 'cash_shortfall', 'outside_sale', 'take_overspent', 'order_unknown', 'missing_evidence']);
// Causes the member resolves on the take's own cards; any other open case is a fill the books could not match (missing_evidence).
const SHORTFALL_CAUSES = ['cash_shortfall', 'position_shortfall', 'negative_subledger_balance'];
/** Account reads failing this long, while takes hold money, is worth telling the member. */
const STALE_MS = 60 * 60_000;

function copy(row: EventRow): { title: string; body: string } {
  const name = row.name ?? 'Your take', symbol = row.symbol ?? 'A holding';
  switch (row.event) {
    case 'strategy_archived':
      return row.detail === 'failed'
        ? { title: `You archived ${name}`, body: 'Its sells did not go through. Retry or choose again; nothing trades until you decide.' }
        : { title: `You archived ${name}`, body: 'Nothing trades until you choose to hold or sell its positions.' };
    case 'close_failed':
      return { title: `Closing ${name} did not go through`, body: 'Retry the same sells or choose again on the take.' };
    case 'cash_shortfall':
      return { title: `Cash left ${name}`, body: `Cash your ${name} investment held has left your Robinhood account. It is paused until you keep following, close it, or add the money back.` };
    case 'outside_sale':
      return { title: `${symbol} sold outside Opentake`, body: `A sale of ${symbol} in Robinhood included shares your ${name} investment held. It is paused until you choose to keep following or close it.` };
    case 'take_overspent':
      return { title: `${name} spent more cash than it held`, body: 'An order was paid for partly from your own cash. Cover the difference or close the take.' };
    case 'order_unknown':
      return { title: `${row.detail === 'sell' ? 'Sell' : 'Buy'} ${symbol}: outcome unknown`, body: `Robinhood did not confirm or refuse this order for ${name}, so the take waits. Check Robinhood, then clear it if it is not there.` };
    case 'holding_not_bought':
      return { title: `${symbol} could not be bought`, body: `${symbol} could not be bought for your ${name} investment, so that share of your money is waiting as cash. It keeps trying; open it to retry now or close out.` };
    case 'symbol_delisted':
      return { title: `${symbol} no longer trades`, body: `${name} released it at its last price; check your account for what you received.` };
    case 'missing_evidence':
      return { title: `${symbol} fill not matched`, body: `A ${symbol} fill in your Robinhood account could not be matched to ${name}, so it is paused until it is. It retries on each sync; open the take to review.` };
  }
}

/** What needs the member, or happened to their takes, derived from current state. */
export async function takeEvents(db: Pick<PGlite, 'query'>, now: number): Promise<EventRow[]> {
  const since = new Date(now - 30 * DAY).toISOString();
  const title = `(SELECT v.metadata->>'title' FROM strategies s LEFT JOIN strategy_versions v ON v.id=s.current_version_id WHERE s.id=a.strategy_id)`;
  const unreleased = `a.status IN ('active','paused','diverged')`;
  return (await db.query<EventRow>(`
   SELECT CASE WHEN c.reason='archive' THEN 'strategy_archived' ELSE 'close_failed' END AS event,a.id AS allocation_id,a.strategy_id,${title} AS name,NULL AS symbol,c.status AS detail,c.updated_at AS at,c.updated_at::text AS occurrence
    FROM strategy_allocation_closures c JOIN strategy_allocations a ON a.id=c.allocation_id
    WHERE ${unreleased} AND (c.status='failed' OR (c.reason='archive' AND c.status='awaiting'))
   UNION ALL
   SELECT CASE c.cause WHEN 'cash_shortfall' THEN 'cash_shortfall' WHEN 'position_shortfall' THEN 'outside_sale' ELSE 'take_overspent' END,a.id,a.strategy_id,${title},
    (SELECT max(e.symbol) FROM strategy_attribution_entries e WHERE e.account_id=c.account_id AND e.instrument_ref=c.instrument_ref),NULL,c.created_at,c.id::text
    FROM strategy_reconciliation_cases c JOIN strategy_allocations a ON c.impacts @> jsonb_build_array(jsonb_build_object('allocationId',a.id::text))
    WHERE c.resolved_at IS NULL AND c.cause IN ('cash_shortfall','position_shortfall','negative_subledger_balance') AND ${unreleased}
   UNION ALL
   SELECT 'missing_evidence',a.id,a.strategy_id,${title},
    coalesce((SELECT max(e.symbol) FROM strategy_attribution_entries e WHERE e.account_id=c.account_id AND upper(e.symbol)=upper(c.instrument_ref)),c.instrument_ref),NULL,c.created_at,c.id::text
    FROM strategy_reconciliation_cases c JOIN strategy_allocations a ON c.impacts @> jsonb_build_array(jsonb_build_object('allocationId',a.id::text))
    WHERE c.resolved_at IS NULL AND c.cause<>ALL($2::text[]) AND ${unreleased}
   UNION ALL
   SELECT 'order_unknown',a.id,a.strategy_id,${title},l.symbol,l.side,l.updated_at,l.id::text
    FROM strategy_executions l JOIN strategy_allocations a ON a.id=l.allocation_id WHERE l.status='placement_unknown' AND ${unreleased}
     AND NOT EXISTS(SELECT 1 FROM order_activity e WHERE e.venue='robinhood' AND e.account_id=a.account_id AND e.order_id=l.order_intent_id)
   UNION ALL
   -- Hosted: a leg that failed in the last 30 days whose symbol the investment still does not hold.
   SELECT 'holding_not_bought',a.id,a.strategy_id,${title},l.symbol,NULL,max(l.terminal_at),to_char(max(l.terminal_at),'YYYY-MM-DD')
    FROM strategy_executions l JOIN strategy_allocations a ON a.id=l.allocation_id
    WHERE l.status='failed' AND l.side='buy' AND l.terminal_at>$1::timestamptz AND ${unreleased}
     AND NOT EXISTS(SELECT 1 FROM strategy_attribution_entries e WHERE e.allocation_id=a.id AND upper(e.symbol)=l.symbol GROUP BY e.allocation_id HAVING sum(e.quantity_delta)>0)
    GROUP BY a.id,a.strategy_id,l.symbol
   UNION ALL
   SELECT 'symbol_delisted',a.id,a.strategy_id,${title},d.symbol,NULL,d.updated_at,d.delisted_on::text
    FROM symbol_delistings d JOIN strategy_allocations a ON EXISTS(SELECT 1 FROM strategy_attribution_entries e WHERE e.allocation_id=a.id AND upper(e.symbol)=d.symbol)
    WHERE d.delisted_on IS NOT NULL AND d.delisted_on>($1::timestamptz)::date AND ${unreleased}
  `, [since, SHORTFALL_CAUSES])).rows;
}

export function takeEventKey(row: Pick<EventRow, 'event' | 'allocation_id' | 'symbol' | 'occurrence'>): string {
  return [row.event, row.allocation_id, row.symbol ?? '', row.occurrence].join(':').slice(0, 200);
}

/** Trailing dividend yields in percent by symbol; read from the provider outside the database transaction. */
export type DividendYields = (symbols: string[]) => Promise<ReadonlyMap<string, number>>;

export async function syncTakeEventNotifications(db: Pick<PGlite, 'transaction' | 'query'>, now: number, recovery = false, dividendYields?: DividendYields) {
  const appeared = await appearedShares(db, now);
  // A failed yield read leaves the verdict at unexplained rather than guessing a dividend.
  const yields = appeared.length && dividendYields ? await dividendYields([...new Set(appeared.map(row => row.symbol))]).catch(() => new Map<string, number>()) : new Map<string, number>();
  await db.transaction(async tx => {
    const rows = await takeEvents(tx, now);
    const keys = rows.map(takeEventKey);
    for (const stale of await staleAccounts(tx, now)) {
      // Keyed by the last good read: a later outage after recovery is a new notice.
      const key = `account_data_stale:${stale.account_id}:${new Date(stale.last_good).toISOString()}`;
      keys.push(key);
      const notice: NotificationInput = {
        kind: 'account_data_stale', tier: 'act_now', requiresAction: true, eventKey: key,
        context: { venue: 'robinhood', connectionId: stale.connection_id, accountId: stale.account_id }, source: { type: 'take_event', id: key },
        occurredAt: new Date(now).toISOString(), title: 'Can’t read your Robinhood account',
        body: `Opentake has not been able to read your account since ${new Date(stale.last_good).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, so your takes wait to trade. Check the connection in Settings.`,
      };
      await tx.query('SELECT record_local_notification($1::jsonb,$2)', [JSON.stringify(notice), recovery]);
    }
    for (const row of appeared) {
      const verdict = classifyUnexplainedIncrease({ symbol: row.symbol, increase: row.increase, dividendYieldPercent: yields.get(row.symbol) ?? null, markPriceUsd: row.mark_price, cashChangeUsd: row.cash_change });
      const key = `shares_appeared:${row.account_id}:${row.symbol}:${new Date(row.observed_at).toISOString()}`.slice(0, 200);
      keys.push(key);
      const shares = `${Number(row.increase)} ${row.symbol}`;
      const notice: NotificationInput = {
        kind: 'shares_appeared', tier: 'know_today', requiresAction: false, eventKey: key,
        context: { venue: 'robinhood', connectionId: row.connection_id, accountId: row.account_id }, source: { type: 'take_event', id: key },
        occurredAt: new Date(row.observed_at).toISOString(), title: `${shares} appeared with no order`,
        body: verdict.verdict === 'probable_reinvestment'
          ? `It looks like a reinvested dividend (worth $${verdict.worthUsd}, and your cash fell to match), but it isn’t counted in any take. Check Robinhood if it isn’t yours.`
          : 'Nothing in your Robinhood orders explains it, so it isn’t counted in any take. Check Robinhood for a transfer or other change.',
      };
      await tx.query('SELECT record_local_notification($1::jsonb,$2)', [JSON.stringify(notice), recovery]);
    }
    for (const row of rows) {
      const act = ACT_NOW.has(row.event), key = takeEventKey(row), text = copy(row);
      const notice: NotificationInput = {
        kind: row.event, tier: act ? 'act_now' : 'know_today', requiresAction: act, eventKey: key,
        context: { strategyId: row.strategy_id }, source: { type: 'take_event', id: key },
        occurredAt: new Date(row.at).toISOString(), title: text.title.slice(0, 120), body: text.body.slice(0, 240),
        takeEvent: { event: row.event, allocationId: row.allocation_id, strategyName: row.name ?? 'Your take', symbol: row.symbol, detail: row.detail },
      };
      await tx.query('SELECT record_local_notification($1::jsonb,$2)', [JSON.stringify(notice), recovery]);
    }
    await tx.query(`UPDATE notifications SET resolved_at=coalesce(resolved_at,$1::timestamptz) WHERE payload->'source'->>'type'='take_event' AND coalesce(payload->'takeEvent'->>'venue','robinhood')='robinhood' AND resolved_at IS NULL AND NOT (payload->>'eventKey'=ANY($2::text[]))`,
      [new Date(now).toISOString(), keys]);
  });
}

/**
 * Shares that appeared with no order behind them (an operator alert, shares_appeared).
 * A reinvested dividend arrives as a drip order and is attributed from it; when no buy explains an
 * increase between two position reads, the member is told rather than the shares attributed on a
 * guess. Hosted compares only the latest two snapshots, so its alert lasts one sync; here each
 * changed pair in the last 30 days is a notice of its own, so it stays in the bell. Only accounts a
 * take trades, symbols already held at the earlier read (as hosted), and never across a recorded
 * share event such as a split.
 */
async function appearedShares(db: Pick<PGlite, 'query'>, now: number) {
  return (await db.query<{ account_id: string; connection_id: string; symbol: string; increase: string; mark_price: string | null; cash_change: string | null; observed_at: Date }>(`
   WITH reads AS (
    SELECT o.account_id,o.observed_at,o.position_snapshot_id,lag(o.position_snapshot_id) OVER w AS previous_snapshot,lag(o.observed_at) OVER w AS previous_at
     FROM account_observations o
     WHERE o.resource='equity_positions' AND o.account_id IN (SELECT account_id FROM strategy_allocations WHERE status IN ('active','paused','diverged'))
     WINDOW w AS (PARTITION BY o.account_id ORDER BY o.observed_at)
   ), changed AS (
    SELECT * FROM reads WHERE previous_snapshot IS NOT NULL AND previous_snapshot<>position_snapshot_id AND observed_at>$1::timestamptz
   ), held AS (
    SELECT c.account_id,c.observed_at,c.previous_at,upper(n->>'symbol') AS symbol,(n->>'quantity')::numeric AS quantity,n->>'markPrice' AS mark_price,
     (SELECT (t->>'quantity')::numeric FROM position_snapshots p,jsonb_array_elements(p.data) t WHERE p.id=c.previous_snapshot AND upper(t->>'symbol')=upper(n->>'symbol') LIMIT 1) AS earlier
     FROM changed c JOIN position_snapshots s ON s.id=c.position_snapshot_id,jsonb_array_elements(s.data) n WHERE n->>'symbol' IS NOT NULL
   ), cash AS (
    SELECT o.account_id,o.observed_at,(f.data->>'cash')::numeric AS cash FROM account_observations o JOIN portfolio_snapshots f ON f.id=o.portfolio_snapshot_id WHERE o.resource='portfolio'
   )
   SELECT h.account_id,l.connection_id,h.symbol,(h.quantity-h.earlier)::text AS increase,h.mark_price,h.observed_at,
    ((SELECT c.cash FROM cash c WHERE c.account_id=h.account_id AND c.observed_at<=h.observed_at ORDER BY c.observed_at DESC LIMIT 1)
     -(SELECT c.cash FROM cash c WHERE c.account_id=h.account_id AND c.observed_at<=h.previous_at ORDER BY c.observed_at DESC LIMIT 1))::text AS cash_change
    FROM held h JOIN linked_accounts l ON l.id=h.account_id
    WHERE h.earlier IS NOT NULL AND h.quantity>h.earlier
     AND NOT EXISTS(SELECT 1 FROM account_executions e WHERE e.account_id=h.account_id AND upper(e.data->>'symbol')=h.symbol AND e.data->>'side'='buy'
      AND e.occurred_at>h.previous_at-interval '1 day' AND e.occurred_at<=h.observed_at+interval '1 day')
     AND NOT EXISTS(SELECT 1 FROM symbol_share_events x WHERE x.symbol=h.symbol AND x.effective_on BETWEEN (h.previous_at-interval '1 day')::date AND (h.observed_at+interval '1 day')::date)
    ORDER BY h.observed_at LIMIT 20`, [new Date(now - 30 * DAY).toISOString()])).rows;
}

/** Selected accounts with money in takes whose position, balance or order reads have failed since the last good one an hour or more ago. */
async function staleAccounts(db: Pick<PGlite, 'query'>, now: number) {
  return (await db.query<{ account_id: string; connection_id: string; last_good: Date }>(`
   SELECT a.id AS account_id,a.connection_id,min(r.last_good) AS last_good FROM linked_accounts a
   CROSS JOIN LATERAL (SELECT res,(SELECT max(finished_at) FROM account_sync_runs WHERE account_id=a.id AND resource=res AND state='completed') AS last_good,
     (SELECT state FROM account_sync_runs WHERE account_id=a.id AND resource=res ORDER BY started_at DESC LIMIT 1) AS latest
    FROM unnest(ARRAY['portfolio','equity_positions','equity_orders']) AS res) r
   WHERE a.selected AND EXISTS(SELECT 1 FROM strategy_allocations s WHERE s.account_id=a.id AND s.status IN ('active','paused','diverged'))
    AND r.latest='failed' AND r.last_good IS NOT NULL AND r.last_good<$1::timestamptz
   GROUP BY a.id,a.connection_id`, [new Date(now - STALE_MS).toISOString()])).rows;
}
