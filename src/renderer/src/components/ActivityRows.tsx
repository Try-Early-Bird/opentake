import {HoldingLogo} from './HoldingLogo';
import {cryptoLogo} from '../crypto-logos';
import type {OrderActivity} from '../../../shared/order-activity';
import {orderStateLabel} from '../../../shared/order-activity';
import {OrderActivityDetails} from './OrderActivityDetails';
import type { CapitalActivity,CoinbaseAccountTransaction } from '../../../shared/portfolio';
import { cn } from '../lib/utils';
import { assetAmount, money } from '../portfolio/format';
import { Bot } from 'lucide-react';
import { useState } from 'react';



// Robinhood-style activity list: "{instrument} {side}" over the date, with the
// notional and "{shares} shares at {price}" on the right. Rows come from the
// synced fills on the member's accounts; app-placed fills get a bot mark.

export interface ActivityItem {
  currency?:string;
  transaction?:CoinbaseAccountTransaction;
  orderEvent?:OrderActivity;
  capital?: CapitalActivity;
  id: string;
  occurredAt: string;
  provider: string;
  assetClass: string;
  symbol: string | null;
  displayName: string;
  side: 'buy' | 'sell' | null;
  quantity: string;
  price: string;
  notional: string | null;
  fee: string | null;
  orderState: string;
  orderType: string | null;
  timeInForce: string | null;
  orderQuantity: string | null;
  orderSubmittedAt: string | null;
  source: 'app' | 'external';
  /** The strategy run the fill served; id and name null when the viewer may not see that strategy. */
  strategy: {
    id: string | null;
    displayName: string | null;
    kind: 'subscribe' | 'rebalance' | 'liquidate' | 'redeem';
    trigger: string | null;
  } | null;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayWithYearFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Aug 26, 3:54 PM" in the viewer's local time zone (year added when not this year). */
export function formatActivityDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const day = date.getFullYear() === now.getFullYear() ? dayFormat.format(date) : dayWithYearFormat.format(date);
  return `${day}, ${timeFormat.format(date)}`;
}

export function formatShares(quantity: string, assetClass: string): string {
  const value = Number(quantity);
  const shares = Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 8 })
    : quantity;
  const unit = assetClass === 'crypto' ? 'unit' : assetClass === 'option' ? 'contract' : 'share';
  return `${shares} ${value === 1 ? unit : `${unit}s`}`;
}

const fullDayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fullTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

const timeInForceLabels: Record<string, string> = {
  gfd: 'Good for day',
  day: 'Good for day',
  gtc: 'Good till canceled',
  ioc: 'Immediate or cancel',
  fok: 'Fill or kill',
  opg: 'At the open',
  cls: 'At the close',
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Market sell", "Limit buy", or just "Sell" when the order type is unknown. */
export function activityAction(item: ActivityItem): string {
  const side = item.side ?? item.orderState;
  const type = item.orderType?.replaceAll('_', ' ');
  return type ? `${capitalize(type)} ${side}` : capitalize(side);
}

export function activityTitle(item: ActivityItem): string {
  if(item.transaction){
    const tx=item.transaction;
    const labels:Record<string,string>={send:'Sent',receive:'Received',fiat_deposit:'Deposit',fiat_withdrawal:'Withdrawal',transfer:tx.amount.startsWith('-')?'Transfer out':'Transfer in',advanced_trade_fill:'Trade',buy:'Buy',sell:'Sell',trade:'Trade',staking_reward:'Staking reward',earn_payout:'Reward',interest:'Interest'};
    return `${tx.asset} · ${labels[tx.type]??capitalize(tx.type.replaceAll('_',' '))}`;
  }
  if(item.orderEvent)return `${item.symbol} ${item.side} · ${orderStateLabel(item.orderEvent.execution.state)}`;
  if(item.capital)return `${item.capital.kind==='assign'?'Funds assigned to':'Funds released from'} ${item.capital.takeTitle}`;
  return `${item.displayName} ${activityAction(item).toLowerCase()}`;
}

export function timeInForceLabel(value: string | null): string {
  if (value === null) return '—';
  return timeInForceLabels[value.toLowerCase()] ?? capitalize(value.replaceAll('_', ' '));
}

function Detail({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="mt-1 text-sm font-normal text-foreground/90">{children}</dd>
    </div>
  );
}

function ActivityDetails({ item, currency }: { item: ActivityItem; currency: string }): React.JSX.Element {
  if(item.transaction){const tx=item.transaction;return <dl className="grid grid-cols-1 gap-x-8 gap-y-5 pt-2 sm:grid-cols-3">
    <Detail label="Type">{activityTitle(item)}</Detail><Detail label="Amount">{assetAmount(tx.amount, tx.asset)}</Detail>
    <Detail label="Status">{capitalize(tx.status)}</Detail><Detail label="Date">{fullTimeFormat.format(new Date(tx.occurredAt))}</Detail>
    {tx.fee&&<Detail label="Fee">{assetAmount(tx.fee.amount, tx.fee.asset)}</Detail>}{tx.networkFee&&<Detail label="Network fee">{assetAmount(tx.networkFee.amount, tx.networkFee.asset)}</Detail>}
    <Detail label="Source">Coinbase</Detail>
  </dl>;}
  if(item.orderEvent)return <OrderActivityDetails order={item.orderEvent}/>;
  if(item.capital)return <dl className="grid grid-cols-1 gap-x-8 gap-y-5 pt-2 sm:grid-cols-3">
    <Detail label="Take">{item.capital.takeTitle}</Detail>
    <Detail label="Action">{item.capital.kind==='assign'?'Assign funds':'Release funds'}</Detail>
    <Detail label="Amount">{assetAmount(item.capital.quantity, item.capital.asset)}</Detail>
    <Detail label="Completed">{fullTimeFormat.format(new Date(item.occurredAt))}</Detail>
    <Detail label="Status">Completed</Detail>
    <Detail label="Source">Opentake · Coinbase allocation</Detail>
  </dl>;
  const filledQuantity = `${formatShares(item.quantity, item.assetClass)} at ${activityMoney(item.price, item.currency??currency)}`;
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-5 pt-2 sm:grid-cols-3">
      <Detail label="Symbol">
        {item.symbol !== null ? (
          <span className="font-normal text-success">
            {item.symbol}
          </span>
        ) : '—'}
      </Detail>
      <Detail label="Type">{activityAction(item)}</Detail>
      <Detail label="Time in force">{timeInForceLabel(item.timeInForce)}</Detail>
      <Detail label="Submitted">
        {item.orderSubmittedAt !== null ? fullDayFormat.format(new Date(item.orderSubmittedAt)) : '—'}
      </Detail>
      <Detail label="Status">{capitalize(item.orderState.replaceAll('_', ' '))}</Detail>
      <Detail label="Entered quantity">
        {item.orderQuantity !== null ? Number(item.orderQuantity).toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—'}
      </Detail>
      <Detail label="Filled">{fullTimeFormat.format(new Date(item.occurredAt))}</Detail>
      <Detail label="Filled quantity">{filledQuantity}</Detail>
      <Detail label="Filled notional">{item.notional === null ? '—' : activityMoney(item.notional, item.currency??currency)}</Detail>
    </dl>
  );
}

function activityMoney(value:string,currency:string):string {
 return currency==='USD'?money(value,currency):assetAmount(value,currency);
}

export function ActivityRow({ item, currency = 'USD' }: { item: ActivityItem; currency?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const detailId = `activity-${item.id}`;
  return (
    <li
      className={cn(
        'border-b border-border transition-colors last:border-0',
        expanded ? 'rounded-lg bg-muted/40' : 'hover:bg-muted/40',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="flex w-full items-center justify-between gap-4 py-4 text-left font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
      <div className="flex min-w-0 flex-1 items-center gap-3">
      {item.provider==='coinbase'&&item.symbol&&<HoldingLogo weight={{symbol:item.symbol.split('-')[0],logoUrl:cryptoLogo(item.symbol.split('-')[0])}}/>}
      <div className="min-w-0">
        <p className="truncate text-sm row-title">{item.orderEvent?<>{item.symbol} {item.side}<span className="font-normal"> · {orderStateLabel(item.orderEvent.execution.state)}</span></>:activityTitle(item)}</p>
        <p className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
          <time dateTime={item.occurredAt} title={new Date(item.occurredAt).toLocaleString()}>
            {formatActivityDay(item.occurredAt)}
          </time>
          {item.source === 'app' && !item.capital && (
            <>
              <span aria-hidden="true">·</span>
              <Bot size={12} aria-label="Placed by Opentake" />
            </>
          )}
        </p>
      </div>
      </div>
      {/* Capped and truncated: a long account label or take title must not squeeze the title and date into a sliver. */}
      <div className="min-w-0 max-w-[50%] text-right tabular-nums">
        <p className={cn('truncate text-sm font-normal', item.side === 'sell' && 'text-foreground')}>
          {item.transaction ? assetAmount(item.transaction.amount, item.transaction.asset) : item.orderEvent ? item.orderEvent.accountLabel : item.capital ? assetAmount(item.capital.quantity, item.capital.asset) : item.notional === null ? '—' : activityMoney(item.notional, item.currency??currency)}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {item.transaction ? capitalize(item.transaction.status) : item.orderEvent ? item.orderEvent.takeTitle??'Order update' : item.capital ? 'Take allocation' : `${formatShares(item.quantity, item.assetClass)} at ${activityMoney(item.price, item.currency??currency)}`}
        </p>
      </div>
      </button>
      {expanded && (
        <div id={detailId} className="pb-4">
          <ActivityDetails item={item} currency={currency} />
        </div>
      )}
    </li>
  );
}

export function ActivityRows({items,currency='USD'}:{items:ActivityItem[];currency?:string}): React.JSX.Element {
 return <ul>{items.map(item=><ActivityRow key={item.id} item={item} currency={currency}/>)}</ul>;
}

export function ActivityRowsSkeleton({ rows = 3 }: { rows?: number }): React.JSX.Element {
  return (
    <ul aria-label="Loading activity">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex items-center justify-between border-b border-border py-4 last:border-0">
          <div className="space-y-2">
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-2 text-right">
            <div className="ml-auto h-4 w-14 animate-pulse rounded bg-muted" />
            <div className="h-3 w-36 animate-pulse rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  );
}
