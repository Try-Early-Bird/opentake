import type { DataLease, DataSnapshot } from './data-sources';
export interface CoinbaseBookView {
  product: string; observedAt: string;
  bids: Array<{ price: string; size: string; cumulativeSize: string }>;
  asks: Array<{ price: string; size: string; cumulativeSize: string }>;
}
export interface CoinbaseStreamTrade {
  trade_id: string; product_id: string; price: string; size: string;
  /** Provider maker side, not aggressor side. */
  side: 'BUY' | 'SELL'; time: string; origin: 'live' | 'backfill';
}
export interface CoinbaseStreamRead {
  leaseId: string;
  snapshot: null | {
    product: string; connection: DataSnapshot['connection']; issue: DataSnapshot['issue'];
    /** Continuity is separate from book.observedAt and individual trade times. */
    continuity: 'live' | 'unavailable';
    book: CoinbaseBookView | null; trades: CoinbaseStreamTrade[];
  };
}
export interface CoinbaseStreamInspection {
  connection: string;
  issue?: DataSnapshot['issue'];
  subscriptions: Array<{product:string;channels:string[];uses:string[];accounts?:string[];lastTick?:string|null;confirmed:boolean}>;
  messages: import('./websocket-sources').WebsocketMessages;
}
export interface CoinbaseStreamAPI {
  inspectMappings():Promise<import('./data-sources').DataSourceInspection>;
  previewMappings(config:import('./websocket-sources').WebsocketSourceConfig):Promise<{product:string;price:string;time:string}>;
  source():Promise<import('./websocket-sources').WebsocketSource>;
  saveSource(revision:number,config:import('./websocket-sources').WebsocketSourceConfig):Promise<import('./websocket-sources').WebsocketSource>;
  setDustPolicy(policy:import('./crypto-dust').CryptoDustPolicy):Promise<void>;
  reconnect():Promise<void>;
  inspect(after?:number):Promise<CoinbaseStreamInspection>;
  messages(leaseId: string, after?: number): Promise<import('./websocket-sources').WebsocketMessages>;
  acquire(product: string, mode?: 'prices'|'book'): Promise<DataLease>;
  renew(ids: string[]): Promise<DataLease[]>;
  read(ids: string[]): Promise<CoinbaseStreamRead[]>;
  release(ids: string[]): Promise<void>;
}
