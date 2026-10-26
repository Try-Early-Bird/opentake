import {z} from 'zod';
import type {InvestmentVenue} from './investment-venues';
export const mixedWithdrawalRequest=z.object({takeId:z.uuid(),kind:z.enum(['reduce','close']),amountUsd:z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).optional(),coinbaseCurrency:z.enum(['USD','USDC']),sellSymbols:z.array(z.string().regex(/^(coinbase|robinhood):[A-Z0-9.-]+$/)).optional()}).strict();
export type MixedWithdrawalRequest=z.infer<typeof mixedWithdrawalRequest>;
export interface MixedWithdrawalLeg {
 venue:InvestmentVenue;accountId:string;accountLabel:string;reference:string;operationId:string;
 evidence:string;amount:string;currency:'USD'|'USDC';estimatedProceeds:string;cashReturned:string;cashRows?:{asset:string;quantity:string}[];
 orders:{symbol:string;quantity:string|null;notional:string;selected:boolean;sellable:boolean}[];
 state:'ready'|'pending'|'waiting_market'|'completed'|'attention';message:string|null;
}
export interface MixedWithdrawal {
 id:string;takeId:string;kind:'reduce'|'close';amountUsd:string;state:'preview'|'running'|'completed'|'attention'|'expired';
 expiresAt:string;legs:MixedWithdrawalLeg[];message:string|null;
}
