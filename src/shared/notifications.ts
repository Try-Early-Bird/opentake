import type {OrderActivity} from './order-activity';
/** Only register kinds whose producers and destinations exist. */
/** Take feed kinds plus two hosted left to an operator: an order of unknown outcome and a take that overspent. */
export type TakeEventKind = 'strategy_archived' | 'close_failed' | 'cash_shortfall' | 'outside_sale' | 'take_overspent' | 'order_unknown' | 'holding_not_bought' | 'symbol_delisted' | 'missing_evidence';
/** Missing evidence, account-wide: account reads keep failing while takes hold money. */
export type NotificationKind = 'rule_notification' | 'action_update' | 'capital_update' | 'order_update' | 'connection_attention' | 'run_approval_needed' | 'orders_need_confirmation' | 'trading_waiting' | 'account_data_stale' | 'shares_appeared' | TakeEventKind;
export type NotificationContext = { venue: string; connectionId: string; accountId?: string } | { takeId: string } | { strategyId: string };
export interface NotificationKey {
  kind: NotificationKind;
  context: NotificationContext;
  source: { type: 'rule' | 'action' | 'connection' | 'tool_approval' | 'platform_approval' | 'trading_queue' | 'take_event' | 'order'; id: string };
  eventKey: string;
}
export interface NotificationInput extends NotificationKey {
  action?:import('./action-notification').ActionProgress;
  account?:{venue:'coinbase'|'robinhood';label:string;takeTitle?:string};
  order?:OrderActivity;
  tier: 'act_now' | 'know_today' | 'digest';
  requiresAction: boolean;
  occurredAt: string;
  expiresAt?: string;
  title: string;
  body: string;
  trading?: { queueItemId:string; actions:('confirm'|'cancel')[]; summary:string; strategyName:string };
  /** A take event (take-event-notifications.ts): what the bell row shows and where its decision is made. */
  takeEvent?: { venue?:'coinbase'|'robinhood'; event:TakeEventKind; allocationId:string; strategyName:string; symbol:string|null; detail:string|null };
}
/** Host producers use the same scoped identity for recording and resolution. */
export interface NotificationWriter {
  record(input: NotificationInput, origin?: 'live' | 'recovery'): Promise<{ id: string }>;
  resolve(key: NotificationKey): Promise<void>;
}
export interface NotificationItem extends NotificationInput {
  id: string;
  sequence: string;
  seen: boolean;
  resolvedAt: string | null;
}
export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: string | null;
  throughSequence: string;
  unreadCount: number;
  actionRequiredCount: number;
}
export type NotificationTarget = {type:'order';order:OrderActivity} | { type:'strategy'; strategyId:string } | { type: 'attention' } | { type: 'take'; takeId: string } | { type: 'connection'; connectionId: string; venue: string };
export interface NotificationNavigation { id: string; target: NotificationTarget }
export interface NotificationsAPI {
  act(id:string,action:'confirm'|'cancel'):Promise<void>;
  list(cursor?: string): Promise<NotificationPage>;
  markSeen(throughSequence: string): Promise<void>;
  target(id: string): Promise<NotificationTarget>;
  navigation(): Promise<NotificationNavigation | null>;
  acknowledge(id: string): Promise<void>;
}
