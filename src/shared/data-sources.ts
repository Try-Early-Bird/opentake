import type {SourceMarketIdentifier} from './source-market-identifiers';
import type { WebsocketRequest } from './websocket-sources';
import type { CoinbaseStreamAPI } from './coinbase-stream';
import type { PortfolioAPI } from './portfolio';
import type { ManagedPollSetting } from './managed-polls';
import type { MarketHit, SearchAPI } from './search';
/** Validated, renderer-safe data. Network configuration and auth scope stay in the host. */
export type DataPayload =
  | { kind: 'text'; value: string }
  | { kind: 'metric'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'event'; fields: Record<string, string | number | boolean | null> }
  | { kind: 'quote'; price: string }
  | { kind: 'candle'; start: number; end: number; open: string; high: string; low: string; close: string; volume: string }
  | { kind: 'book'; bids: [string, string][]; asks: [string, string][] }
  | { kind: 'trade'; price: string; size: string; side: 'maker_buy' | 'maker_sell' | 'unknown' };

export interface DataObservation {
  sourceId: string;
  feedId: string;
  configVersion: number;
  schemaVersion: number;
  adapterId: string;
  adapterVersion: string;
  /** Identifies the runtime instance across host restarts. */
  runtimeId?: string;
  epoch: number;
  unit: string;
  market?: { venue: string; product: string; base: string; quote: string };
  eventTime: number | null;
  receivedAt: number;
  timeBasis: 'provider' | 'receipt';
  /** Accepted provider timestamp ahead of receipt time; never silently normalized. */
  clockSkewMs: number;
  origin: 'live' | 'backfill';
  providerId?: string;
  sequence?: string;
  payload: DataPayload;
}
export type DataQuality = 'missing' | 'fresh' | 'stale' | 'gap' | 'invalid';
export type DataConnection = 'idle' | 'connecting' | 'live' | 'retrying' | 'blocked';
export type DataIssue = 'invalid_data' | 'gap' | 'capacity' | 'timeout' | 'transport' | 'clock_changed' | 'suspended';
export interface DataSnapshot {
  connection: DataConnection;
  quality: DataQuality;
  latest: DataObservation | null;
  issue: DataIssue | null;
  /** Provider receipt, independent of latest valid observation. */
  lastReceivedAt: number | null;
}

/** Catalog reference only: the host resolves auth scope, parameters and adapter. */
export interface DataFeedRef { sourceId: string; feedId: string; configVersion: number; schemaVersion: number }
export interface DataFeedInfo extends DataFeedRef { kind: DataPayload['kind']; unit: string }
export interface DataLease { leaseId: string; expiresInMs: number; renewAfterMs: number }
export interface DataLeaseRead { leaseId: string; snapshot: DataSnapshot | null }
export type SourceConfigurationRequest = {action:'market-suggestions';venue:'robinhood'|'coinbase';query:string} | import('./rule-proposals').RuleReviewRequest | import('./strategy-rules').RuleEvidenceRequest | import('./strategy-rules').RuleShadowRequest | import('./strategy-rules').RuleDraftRequest | import('./take-inputs').TakeInputRequest | WebsocketRequest | {action:'coinbase-account-source';accountId:string} | {action:'coinbase-account-save';setting:import('./coinbase-field-mappings').CoinbaseAccountSourceSetting} | { action: 'managed-list'; accountId?:string } | { action: 'managed-save'; setting: ManagedPollSetting } | ({ action: 'inspect' } & SourceInspectionRequest) | { action: 'list' } | { action: 'market-price'; market: MarketHit['identity'] } | { action: 'market-metadata'; market: MarketHit['identity'] } | { action: 'destination-status'; id: string } | { action: 'save'; config: unknown; existing?: { id: string; revision: number } }
  | { action: 'preview'; id: string; revision: number } | { action: 'enable'; id: string; revision: number; enabled: boolean };
export interface DataSourcesAPI {
  coinbaseStream: CoinbaseStreamAPI;
  marketSearch: SearchAPI;
  marketDetails: PortfolioAPI['market'];
  marketSeries: PortfolioAPI['series'];
  coinbaseMarket: PortfolioAPI['coinbaseMarkets']['detail'];
  coinbaseSeries: PortfolioAPI['coinbaseMarkets']['series'];
  managedSettings(accountId?:string): Promise<ManagedPollSetting[]>;
  saveManagedSetting(setting: ManagedPollSetting): Promise<ManagedPollSetting>;
  storedMarketPrice(market: MarketHit['identity']): Promise<StoredMarketPrice>;
  marketMetadata(market: MarketHit['identity']): Promise<MarketMetadataSnapshot>;
  customSources(): Promise<CustomDataSource[]>;
  saveSource(config: CustomSourceConfig, existing?: { id: string; revision: number }): Promise<CustomDataSource>;
  previewSource(id: string, revision: number): Promise<{ samples: Array<{ payload: DataPayload; eventTime: number | null; origin: 'live' | 'backfill' }>; destinations: DestinationWritePreview[] }>;
  enableSource(id: string, revision: number, enabled: boolean): Promise<void>;
  inspect(request: SourceInspectionRequest): Promise<DataSourceInspection>;
  configure(request: SourceConfigurationRequest): Promise<unknown>;
  inventory(): Promise<DataSourceInventory>;
  list(): Promise<DataFeedInfo[]>;
  acquire(feed: DataFeedRef): Promise<DataLease>;
  renew(leaseIds: string[]): Promise<DataLease[]>;
  read(leaseIds: string[]): Promise<DataLeaseRead[]>;
  release(leaseIds: string[]): Promise<void>;
}

/** Saved collection metadata only; no account balances, payloads or credential references. */
export interface ManagedDataFeed {
  enabled?: boolean;
  id: string;
  name: string;
  description: string;
  state: 'waiting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'partial';
  lastUpdatedAt: string | null;
}
export interface ManagedDataSource {
  id: string;
  venue: 'robinhood' | 'coinbase';
  label: string;
  connected: boolean;
  /** Saved feed choices could not be read; background sync is using the defaults. */
  settingsUnreadable?: true;
  feeds: ManagedDataFeed[];
}
export interface DataSourceInventory { sources: ManagedDataSource[] }

export interface InspectedSourceField {
  path: string[];
  type: 'string' | 'number' | 'boolean' | 'null' | 'array';
  sample: string | number | boolean | null;
  selectable: boolean;
}
export interface DataSourceInspection { fields: InspectedSourceField[]; truncated: boolean; inferredFrom: 'single-response' }
export interface SourceInspectionRequest { endpoint: string; credentialId?: string }

export type SourceWriteCondition = {field:string;op:'equals';value:string|number|boolean|null}|{field:string;op:'in';values:Array<string|number|boolean|null>}|{field:string;op:'gt'|'gte'|'lt'|'lte';value:number};
export interface CustomSourceConfig {
  name: string; endpoint: string; credentialId?: string;
  collection: 'automatic' | 'when-open' | 'off'; pollIntervalMs: number;
  feeds: Array<{
    id: string; name: string; unit: string;
    mapping: { kind: 'metric' | 'boolean'; valuePath: string[] } | { kind: 'event'; fields: Record<string, { path: string[]; type: 'string' | 'number' | 'boolean' | 'null' }> };
    eventTimePath?: string[];
    destination?: { kind: 'custom-feed' }
      | { kind: 'market-price'; market: { venue: 'robinhood'; instance: 'production'; kind: 'equity'; reference: string }; currency: 'USD'; policy: 'fill-missing' | 'replace-stale'; maxAgeMs: number; allowSharedPriceWrites: true }
      | {kind:'market-prices';market:({venue:'robinhood';instance:'production';kind:'equity'}|{venue:'coinbase';instance:'production';kind:'crypto'});symbolField:string;identifier?:SourceMarketIdentifier;priceField:string;holdings?:{accountIds:string[];maxAgeMs:number};conditions:SourceWriteCondition[];currency:'USD';policy:'fill-missing'|'replace-stale';maxAgeMs:number;allowSharedPriceWrites:true}
      | { kind: 'market-metadata'; market: MarketHit['identity']; namespace: string; maxAgeMs: number };
    storage: { mode: 'live' | 'latest' | 'history'; fields: string[]; sampleEveryMs: number; retentionDays: 1 | 7 | 30 | 90 };
  }>;
}
export interface CustomDataSource { id: string; revision: number; enabled: boolean; validated: boolean; config: CustomSourceConfig }

export interface DestinationWritePreview {
  feedId: string; target: string;
  outcome: 'would-write' | 'written' | 'stale' | 'invalid' | 'missing-market' | 'preserved' | 'namespace-conflict' | 'filtered' | 'holdings-unavailable';
  current?: unknown; proposed?: unknown;
}

/** Only active, validated, current-revision metadata is exposed. Staleness is explicit. */
export interface MarketMetadataSnapshot {
  market: MarketHit['identity'];
  namespaces: Array<{
    namespace: string; sourceId: string; revision: number; feedId: string;
    fields: Record<string, string | number | boolean | null>;
    updatedAt:number;
    fieldUpdates:Record<string,{updatedAt:number|null;eventTime:number|null;quality:'fresh'|'stale'}>;
    receivedAt: number; eventTime: number | null; quality: 'fresh' | 'stale'; maxAgeMs: number;
  }>;
  truncated: boolean;
}

/** Cached display data, not an execution quote or proof of an active connection. */
export interface StoredMarketPrice {
  market: MarketHit['identity']; quality: 'fresh' | 'stale' | 'missing' | 'unsupported' | 'invalid';
  quote: null | {
    payload: {kind:'quote';price:string}; currency:string; receivedAt:number; eventTime:number|null;
    timeBasis:'receipt'|'provider'; origin:'stored'; provider:string;
    sourceId:string|null; revision:number|null; feedId:string|null; maxAgeMs:number;
  };
}
