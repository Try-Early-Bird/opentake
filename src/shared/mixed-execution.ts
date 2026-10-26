import {z} from 'zod';
import type {BasketSpec} from './strategies';
export const mixedPreviewRequest=z.object({takeId:z.uuid(),operationId:z.uuid(),versionId:z.uuid(),routeRevision:z.uuid(),amountUsd:z.string().regex(/^[0-9]{1,12}(\.[0-9]{1,2})?$/).refine(v=>Number(v)>0),coinbaseCurrency:z.enum(['USD','USDC'])}).strict();
export type MixedPreviewRequest=z.infer<typeof mixedPreviewRequest>;
export type {InvestmentVenue as MixedVenue} from './investment-venues';
import type {InvestmentVenue as MixedVenue} from './investment-venues';
export interface MixedFundingLeg {
 venue:MixedVenue;accountId:string;currency:'USD'|'USDC';amountUsd:string;quantity:string;
 /** Original whole-Take weights are retained independently of the local sleeve. */
 weights:BasketSpec['target']['weights'];sleeve:BasketSpec;
}
export interface MixedLegPreview {
 venue:MixedVenue;accountId:string;currency:'USD'|'USDC';quantity:string;
 state:'ready'|'waiting_market'|'blocked';reason:string|null;
 /** All monetary values are in this leg's funding currency, including fees. */
 orders:{symbol:string;side:'buy';notional:string;fee:string}[];
 existingCash?:string;retainedCash:string;available:string;expiresAt:string;evidence:string;
}
export interface MixedPreview {
 id:string;takeId:string;versionId:string;routeRevision:string;amountUsd:string;
 state:'ready'|'waiting_market'|'blocked';expiresAt:string;legs:MixedLegPreview[];
 /** True only when both venue adapters support coordinated reservation and dispatch. */
 executionEnabled:boolean;
}

export type MixedLegState = 'reserved' | 'dispatching' | 'pending' | 'waiting_market' | 'completed' | 'partial' | 'cancelled' | 'attention';
export interface MixedExecutionLeg {venue:MixedVenue;accountId:string;operationId:string;reference:string;state:MixedLegState;message:string|null}
export interface MixedExecution {id:string;takeId:string;previewId:string;state:'funded'|'running'|'completed'|'attention';legs:MixedExecutionLeg[]}

export const mixedLegFinished=(state:MixedLegState)=>['completed','partial','cancelled'].includes(state);
