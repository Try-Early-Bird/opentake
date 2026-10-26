import type {BasketSpec} from './strategies';
export interface CoinbaseLifecycle {
 rebalanceWarning?:{code:'below_minimum'|'insufficient_funds';checkedAt:string;nextRetryAt:string|null;cash?:{currency:string;required:string;available:string;shortfall:string}}|null;
 pending:boolean;funded:boolean;takeId:string;accountId:string;allocationId:string;accountLabel:string;archived:boolean;
 versionSequence?:number;currentVersionSequence?:number;versionId:string;currentVersionId:string;driftEnabled:boolean;canEnableDrift:boolean;
 currentRules:BasketSpec['rebalance']&{cashBps:number};nextRules:BasketSpec['rebalance']&{cashBps:number};
 blocked:string|null;evidence:string;
 changes:{allocationId:string;takeTitle:string;asset:string;before:string;after:string}[];
 currentWeights:{symbol:string;bps:number}[];nextWeights:{symbol:string;bps:number}[];
}
export interface CoinbaseLifecycleDecision {takeId:string;evidence:string;action:'reconcile'|'release'|'adopt'|'enable_drift'|'disable_drift'}
