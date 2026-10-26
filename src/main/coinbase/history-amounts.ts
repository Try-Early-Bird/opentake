import { decimalToScaledInteger as units } from '../allocations/decimal';
import type { CoinbaseHistory } from './history';
export const signedHistoryAmount=(value:string)=>value.startsWith('-')?-units(value.slice(1),36):units(value,36);
/** Advanced Trade posts gross quote movements; commission is a separate quote debit.
 * The base-wallet copy of a fill must not also debit its commission. */
export function transactionDelta(tx:CoinbaseHistory['transactions'][number]):bigint {
 const gross=signedHistoryAmount(tx.amount);
 return tx.type==='advanced_trade_fill' && tx.fee?.asset===tx.asset ? gross-units(tx.fee.amount,36) : gross;
}
export function walletBalance(wallet:NonNullable<CoinbaseHistory['wallets']>[number]):bigint|null {
 if(wallet.balance!==undefined)return units(wallet.balance,36);
 return wallet.available!==null&&wallet.held!==null?units(wallet.available,36)+units(wallet.held,36):null;
}

/** Portfolio breakdown's crypto quantities are float32 display values. */
export function sameDisplayQuantity(exact:string,display:string):boolean {
 const a=Math.fround(Number(exact)),b=Math.fround(Number(display));
 return Number.isFinite(a)&&Number.isFinite(b)&&a===b;
}

/** Only v2 balances with an explicit currency exponent may round sub-unit rewards.
 * The ledger remains exact; this comparison cannot excuse a whole currency unit. */
export function reconciledWalletBalance(wallet:NonNullable<CoinbaseHistory['wallets']>[number],ledger:bigint):bigint|null {
 const actual=walletBalance(wallet);
 if(actual===ledger)return ledger;
 const precision=wallet.balancePrecision;
 if(actual===null||ledger<0n||precision===undefined||wallet.available!==null||wallet.held!==null)return null;
 const quantum=10n**BigInt(36-precision);
 if(actual%quantum!==0n)return null;
 return ((ledger+quantum/2n)/quantum)*quantum===actual?ledger:null;
}
