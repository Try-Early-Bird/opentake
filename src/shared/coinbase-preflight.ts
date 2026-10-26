import {z} from 'zod';
export const coinbasePreflightRequest=z.object({takeId:z.uuid(),quote:z.enum(['USD','USDC']),quantity:z.string().regex(/^(0|[1-9]\d{0,39})(\.\d{1,36})?$/)}).strict();
export type CoinbasePreflightRequest=z.infer<typeof coinbasePreflightRequest>;
export interface CoinbasePreflight {
 ok:boolean;amount:string;minimumAmount:string|null;
 legs:{symbol:string;weightPercent:number;notional:string}[];
 retainedCash:string;reason:string|null;allocationReason?:string;existingCashUsed?:string;
}
