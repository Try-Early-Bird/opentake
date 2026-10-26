import type {OrderStatus} from './trading';
import { z } from 'zod';
export const DEFAULT_QUOTE_CHANGE_TOLERANCE_BPS=50;
export const orderReviewRequest=z.object({takeId:z.uuid(),quote:z.enum(['USD','USDC']),purchaseOnly:z.literal(true).optional(),close:z.literal(true).optional(),sellSymbols:z.array(z.string().regex(/^[A-Z0-9]+$/)).max(20).optional(),deployAmount:z.string().regex(/^(0|[1-9]\d{0,20})(\.\d{1,18})?$/).optional(),withdrawAmount:z.string().regex(/^(0|[1-9]\d{0,20})(\.\d{1,18})?$/).optional()}).strict().refine(r=>r.sellSymbols===undefined||r.close===true,'Sell choices require closing the Take.');
export interface CoinbaseWithdrawalBand {minimumAmount:string;maximumAmount:string;possible:boolean;holdingsValue:string}
export interface CoinbaseProposedOrder {
 execution?:OrderStatus;
 filledQuantity?:string;
 orderType?:'market'|'limit';product:string;side:'buy'|'sell';baseSize:string;limitPrice:string;notional:string;
 fee:string;previewId:string;debits:{asset:string;quantity:string}[];
}
export interface CoinbaseOrderReview {
 withdrawal?:{band?:CoinbaseWithdrawalBand;remainingValue?:string;requestedAmount:string;estimatedProceeds:string;close?:boolean;residue?:{asset:string;quantity:string}[]};
 closePositions?:{symbol:string;quantity:string;value:string;unrealized:string|null;sellable:boolean}[];
 closeCash?:{asset:string;quantity:string}[];
 closed?:boolean;
 reconfirmationRequired?:boolean;
 previousQuoteOrders?:Pick<CoinbaseProposedOrder,'product'|'side'|'baseSize'|'limitPrice'|'notional'|'fee'>[];
 rebalance?:{quoteRevision?:number;scheduledOn:string;phase?:'initial'|'buy';trigger?:'schedule'|'drift'|'rule';ruleRequestId?:string};
 returnedAmount?:string;
 needsConfirmation?:boolean;
 valuation?:string;
 id:string;takeId:string;accountLabel:string;takeTitle:string;quote:'USD'|'USDC';
 phase:'buy'|'sell';orders:CoinbaseProposedOrder[];skipped:string[];
 expiresAt:string;state:'preview'|'confirmed'|'cancelled'|'expired'|'settled';
}
