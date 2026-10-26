export function normalizeDustThreshold(value:string):string|null {
 const trimmed=value.trim();
 if(!/^(?:\d{1,12}(?:\.\d{0,2})?|\.\d{1,2})$/.test(trimmed))return null;
 const [whole='0',fraction='']=trimmed.split('.');
 return `${BigInt(whole||'0')}.${fraction.padEnd(2,'0')}`;
}
/** Unknown/non-USD values stay visible; hiding never changes accounting totals. */
export function isCryptoDust(value:string|null,currency:string,threshold='0.10'):boolean {
 if(currency!=='USD'||value===null||!/^\d+(\.\d+)?$/.test(value)||normalizeDustThreshold(threshold)===null)return false;
 const [whole,fraction='']=value.split('.');
 const [limitWhole,limitFraction]=normalizeDustThreshold(threshold)!.split('.');
 const digits=Math.max(fraction.length,limitFraction.length);
 const amount=BigInt(whole+fraction.padEnd(digits,'0'));
 const limit=BigInt(limitWhole+limitFraction.padEnd(digits,'0'));
 return amount<limit;
}

export interface CryptoDustPolicy {hide:boolean;threshold:string}
export const defaultCryptoDustPolicy:CryptoDustPolicy={hide:true,threshold:'0.10'};
