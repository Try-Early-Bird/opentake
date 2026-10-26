import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import type {BasketSpec} from '../../shared/strategies';
import type {MixedPreview,MixedVenue,MixedFundingLeg,MixedLegPreview} from '../../shared/mixed-execution';
import type {MixedExecutionAdapter} from './coordinator';
import type {createCoinbaseOrderReviews} from '../coinbase/order-reviews';
import type {createCoinbaseInvestments} from '../coinbase/investment';
import type {Planner,Executor} from '../execution/contracts';
export type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export type Query=Pick<Transaction,'query'>;
export type Allocation={id:string;account_id:string;version_id:string;status:string;restore_required:boolean};
export interface Context {takeId:string;strategyId:string;versionId:string;routeRevision:string;spec:BasketSpec;routes:{venue:MixedVenue;accountId:string}[];available:Record<MixedVenue,Record<string,string>>;blocked:string[];allocations:Partial<Record<MixedVenue,Allocation>>;claimsHash:string;evidence:string;usdcUsdRate?:string;rateObservedAt?:number}
export type InvestmentDependencies={
 clock?:()=>number;enabled():boolean;refresh(venue:MixedVenue,accountId:string):Promise<unknown>;
 usdcRate(accountId:string):Promise<string>;
 checkRobinhood(accountId:string,symbols:string[]):Promise<void>;
 coinbaseOrders:ReturnType<typeof createCoinbaseOrderReviews>;
 coinbaseInvestments:ReturnType<typeof createCoinbaseInvestments>;
 planner:Planner;executor:Executor;
};
export type FundingPreviewBase=Pick<MixedLegPreview,'venue'|'accountId'|'currency'|'quantity'|'available'|'evidence'|'expiresAt'>;
/** Venue adapters cannot move money during preview. reserve only writes local
 * ledger state on the coordinator's transaction; dispatch/reconcile use the
 * persisted child identity. These guarantees apply to every venue. */
export interface InvestmentVenueAdapter extends MixedExecutionAdapter {
 assertIdle(db:Query,strategyId:string):Promise<void>;
 readAccount(db:Query,strategyId:string,accountId:string,withBalances:boolean):Promise<{allocation:Allocation|undefined;available:Record<string,string>;claims:unknown}>;
 preview(leg:MixedFundingLeg,context:Context,base:FundingPreviewBase):Promise<MixedLegPreview>;
 reserve(tx:Transaction,preview:MixedPreview,leg:{venue:MixedVenue;accountId:string;operationId:string},context:Context):Promise<string>;
}
