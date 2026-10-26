import type {PriceRange, SymbolSeries} from './market-series';
export interface CoinbaseMarket {
 id:string; venue:'coinbase'; base:string; quote:string; name:string;
 price:string|null; change24h:string|null; volume24h:string|null;
 quoteVolume24h?:string|null; high24h?:string|null; low24h?:string|null;
 marketCap?:string|null; description?:string|null;
 status:string; tradingDisabled:boolean;
}
export interface CoinbaseMarketSnapshot {market:CoinbaseMarket; observedAt:string; stale:boolean; source?:'public'|'authenticated'}
export interface CoinbaseMarketSeries {series:SymbolSeries|null; stale:boolean; observedAt:string}
export interface CoinbaseMarketsAPI {
 detail(product:string,accountId?:string):Promise<CoinbaseMarketSnapshot>;
 series(product:string,range:PriceRange):Promise<CoinbaseMarketSeries>;
}
