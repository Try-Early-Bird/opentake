import { z } from 'zod';
export const coinbaseCapitalRequest = z.object({
 takeId: z.uuid(), kind: z.enum(['assign','release']), asset: z.enum(['USD','USDC']),
 quantity: z.string().regex(/^(0|[1-9]\d{0,39})(\.\d{1,36})?$/).refine(value => /[1-9]/.test(value), 'Enter an amount greater than zero.'),
}).strict();
export type CoinbaseCapitalRequest = z.infer<typeof coinbaseCapitalRequest>;
export interface CoinbaseCapitalView {
 pnl?:{gain:string;returnPercent:string|null;currency:string}|null;
 valuation?:{currency:string;value:string|null};
 buyingPower?: {asset:string;amount:string}[];
 risk?: {allocationId:string;policy:CoinbaseRiskPolicy};
 accountId: string; accountLabel: string; takeTitle: string;
 balances: {asset:string; quantity:string; reserved:string;price?:string|null;value?:string|null}[];
}
export interface CoinbaseCapitalReview extends CoinbaseCapitalRequest {
 id:string; accountLabel:string; takeTitle:string; expiresAt:string;
}

const riskAmount = z.string().regex(/^(0|[1-9]\d{0,39})(\.\d{1,36})?$/).nullable();
export const coinbaseRiskPolicy = z.object({currency:z.enum(['USD','USDC']).nullable(),maxDailyNotional:riskAmount,maxLoss:riskAmount}).strict().refine(p=>(p.maxDailyNotional===null&&p.maxLoss===null)||p.currency!==null,'Choose a limit currency.');
export type CoinbaseRiskPolicy = z.infer<typeof coinbaseRiskPolicy>;
export const coinbaseRiskRequest = z.object({takeId:z.uuid(),accountId:z.uuid(),allocationId:z.uuid(),expected:coinbaseRiskPolicy,policy:coinbaseRiskPolicy}).strict();
export type CoinbaseRiskRequest = z.infer<typeof coinbaseRiskRequest>;
