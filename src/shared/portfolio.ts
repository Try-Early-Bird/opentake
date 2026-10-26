import type { MarketResearchRequest } from './market-research';
import type {CoinbaseMarketsAPI} from './coinbase-markets';
import type { PlannedPortfolioTake } from './strategy-account-plan';
import type {BasketSpec} from './strategies';
import type {MarketDetail, MarketSeries, PriceRange} from './market-series';
export type AccountResource = 'crypto_orders' | 'crypto_positions' | 'portfolio' | 'equity_positions' | 'option_positions' | 'equity_orders' | 'option_orders' | 'spot_orders' | 'spot_fills';
export interface PortfolioAccount { maskedNumber?: string; balance?: { totalValue: string; currency: string; observedAt: string } | null; id: string; venue: string; label: string; selected: boolean; available: boolean; accountType?: string | null; optionLevel?: string | null }
export interface ResourceStatus { resource: AccountResource; observedAt: string | null; state: string; errorCode: string | null; stale: boolean }
export interface PortfolioStrategy {
 allocationId:string;strategyId:string;takeId:string|null;title:string;description:string;status:string;
 requiresReconciliation:boolean;spec:BasketSpec;cash:string;value:string|null;
 positions:{instrumentRef:string;symbol:string|null;quantity:string}[];
 importedAsOf:string|null;
}
/** Which history backs a portfolio range; 1D stays intraday and is composed from the legs' series. */
export type AllocationHistoryRange='1m'|'3m'|'1y'|'all';
/** An allocation's value at each day's close, from its ledger and daily closes. */
export interface AllocationHistory {allocationId:string;range:AllocationHistoryRange;points:{day:string;totalValue:string}[]}
export interface PositionAttribution {allocationId:string;strategyId:string;title:string;quantity:string}
export interface CoinbaseSpotPosition { averageEntryPrice?:string|null; unrealizedPnl?:string|null; takeAllocations?:PositionAttribution[]; instrumentRef: string; asset: string; quantity: string; marketValue: string; availableValue: string | null; currency: string; isCash: boolean }
export interface CoinbaseHistoryReconciliation {
 asset:string;ledgerQuantity:string;portfolioQuantity:string;walletQuantity:string|null;difference:string;
 types:{type:string;count:number;quantity:string;firstAt:string;lastAt:string}[];
}
export interface CapitalActivity {
 id:string; occurredAt:string; kind:'assign'|'release'; asset:string; quantity:string;
 takeId:string; takeTitle:string;
}
export interface CoinbaseAccountTransaction {
 id:string;asset:string;amount:string;type:string;status:string;occurredAt:string;
 fee?:{asset:string;amount:string};networkFee?:{asset:string;amount:string};orderRef?:string;
}
export interface PortfolioView {
 accountTransactions?:CoinbaseAccountTransaction[];
 orderActivity?: import('./order-activity').OrderActivity[];
 capitalActivity?: CapitalActivity[];
 coinbaseHistory?: { reconciliation?: CoinbaseHistoryReconciliation[]; state: 'complete' | 'partial' | 'failed'; checkedAt: string; transactionCount: number; walletCount: number; completedWallets: number; issue: string | null; valuation?: 'complete' | 'unavailable'; valuationIssue?: string | null; dailyValuation?: 'complete' | 'unavailable'; dailyValuationIssue?: string | null };
 plannedTakes?: PlannedPortfolioTake[];
 spotPositions?: CoinbaseSpotPosition[];
 selfDirectedSpotPositions?: CoinbaseSpotPosition[];
 strategies?:PortfolioStrategy[];selfDirectedPositions?:PortfolioView['positions'];reservedCash?:string;selfDirectedCash?:string|null;allocationWarnings?:string[];
 account: PortfolioAccount | null;
 accounts: PortfolioAccount[];
 resources: ResourceStatus[];
 history: { resolution?: 'daily'; reconstructed?: boolean; observedAt: string; totalValue: string; currency: string }[];
 portfolio: { totalValue: string; cash: string | null; buyingPower: string | null; currency: string } | null;
 positionHistory: { instrumentRef: string; assetClass: string; observedAt: string; markPrice: string; currency: string }[];
 positions: { instrumentRef: string; symbol: string | null; quantity: string; markPrice: string | null; marketValue: string | null; currency: string; assetClass: 'equity' | 'option' | 'crypto'; side?: 'long' | 'short' | 'flat'; averageCost?: string | null; providerUnrealizedPnl?: string | null; providerRealizedPnl?: string | null }[];
 orders: { providerOrderRef: string; symbol: string | null; side: string | null; state: string; quantity: string | null; sourceCreatedAt: string | null; orderType?: string | null; timeInForce?: string | null; assetClass: string }[];
 executions: { currency?:string; providerExecutionRef: string; orderRef: string; symbol: string | null; side: string | null; quantity: string; price: string; occurredAt: string; notionalAmount?: string | null; feeAmount?: string | null; origin?: string; assetClass: string }[];
 gaps: { resource: string; fromAt: string; toAt: string; reason: string }[];
}
export interface PortfolioActivityCursor {at:string;id:string}
export type PortfolioActivityPage=Pick<PortfolioView,'executions'|'orders'|'capitalActivity'|'orderActivity'|'accountTransactions'>&{nextCursor:PortfolioActivityCursor|null};
export interface PortfolioAPI { research(input:MarketResearchRequest):Promise<unknown>; activity(accountId:string,cursor?:PortfolioActivityCursor):Promise<PortfolioActivityPage>; coinbaseMarkets:CoinbaseMarketsAPI; market(symbol:string):Promise<MarketDetail>; fundamentals(symbols:string[]):Promise<Record<string,Record<string,unknown>>>; search(query:string):Promise<{symbol:string;displayName:string}[]>; logo(symbol:string):Promise<string|null>; strategyHistory(allocationId:string,range:AllocationHistoryRange):Promise<AllocationHistory>; importStrategies():Promise<{status:"cancelled"}|{status:"imported";imported:number;skipped:number}>; series(accountId:string,range:PriceRange,symbols?:string[]):Promise<MarketSeries>; snapshot(accountId?: string): Promise<PortfolioView>; refresh(accountId?: string): Promise<void>; importHistory(): Promise<{status:'cancelled'} | {status:'imported';imported:number;skipped:number}> }
