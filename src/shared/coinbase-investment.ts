import {z} from 'zod';
import type {CoinbaseCapitalView} from './coinbase-capital';
import type {CoinbaseOrderReview} from './coinbase-orders';
export const coinbaseInvestmentRequest=z.object({operationId:z.uuid(),takeId:z.uuid(),accountId:z.uuid(),asset:z.enum(['USD','USDC']),quantity:z.string().regex(/^(0|[1-9]\d{0,39})(\.\d{1,36})?$/)}).strict();
export type CoinbaseInvestmentRequest=z.infer<typeof coinbaseInvestmentRequest>;
export interface CoinbaseInvestmentView {id:string;state:'started'|'funded'|'ready'|'dispatched'|'cancelled';capital:CoinbaseCapitalView;review:CoinbaseOrderReview|null;needsConfirmation:boolean;error:string|null;cashStatus?:string;requestedAmount?:string;asset?:'USD'|'USDC'}
