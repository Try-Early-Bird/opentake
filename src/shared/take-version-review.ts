import type {BasketSpec} from './strategies';
export interface TakeVersionReview {
 versionId:string;currentVersionId:string;versionSequence:number;currentVersionSequence:number;
 currentWeights:{symbol:string;bps:number}[];nextWeights:{symbol:string;bps:number}[];
 currentRules:BasketSpec['rebalance']&{cashBps:number};nextRules:BasketSpec['rebalance']&{cashBps:number};
}
