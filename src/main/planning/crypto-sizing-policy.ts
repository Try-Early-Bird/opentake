import {z} from 'zod';
import {amount,format} from '../allocations/ledger';
import {cryptoDecimal} from '../orders/crypto-preview-contract';
import {cryptoBuyMaximumDebit} from '../orders/crypto-transport';
import type {SizingPolicy} from './basket-sizing';
const schema=z.object({quantityIncrement:cryptoDecimal,minimumQuantity:cryptoDecimal,maximumQuantity:cryptoDecimal,minimumNotional:cryptoDecimal.nullable()});
/** Validated metadata from the normal account snapshot, shared by previews and
 * the planner. Invalid limits never become permissive defaults. */
export function cryptoSizingPolicy(raw:unknown,mark:string):SizingPolicy|null{
 const parsed=schema.safeParse(raw);if(!parsed.success)return null;
 const p=parsed.data,price=amount(mark),step=amount(p.quantityIncrement),min=amount(p.minimumQuantity),max=amount(p.maximumQuantity);
 if(price<=0n||step<=0n||min<=0n||max<min)return null;
 const quantityMinimum=min*price/10n**18n,quoteMinimum=amount(p.minimumNotional??'1');
 const minimum=quantityMinimum>quoteMinimum?quantityMinimum:quoteMinimum;
 if(minimum<=0n)return null;
 return {quantityIncrement:p.quantityIncrement,minimumOrderNotionalUsd:format(minimum),maximumOrderNotionalUsd:format(max*price/10n**18n),maximumBuyDebit:n=>cryptoBuyMaximumDebit(n,'market')};
}
