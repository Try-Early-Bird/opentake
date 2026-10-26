/** Crypto quote units may not be ISO currencies, and small asset prices need more than cents. */
export function cryptoPrice(value:string|number,currency:string):string {
 const amount=Number(value);if(!Number.isFinite(amount))return '—';
 const precision=amount!==0&&Math.abs(amount)<1?{maximumSignificantDigits:8}:{minimumFractionDigits:2,maximumFractionDigits:8};
 const fiat=['USD','EUR','GBP','CAD','AUD','JPY','CHF'].includes(currency);
 return new Intl.NumberFormat('en-US',{...precision,...(fiat?{style:'currency',currency}: {})}).format(amount)+(fiat?'':` ${currency}`);
}

/** Provider-reported volume in the exact market quote currency. */
export function cryptoVolume(value:string,currency:string):string {
 const amount=Number(value);if(!Number.isFinite(amount))return '—';
 const fiat=['USD','EUR','GBP','CAD','AUD','JPY','CHF'].includes(currency);
 return new Intl.NumberFormat('en-US',{notation:'compact',minimumFractionDigits:2,maximumFractionDigits:2,...(fiat?{style:'currency',currency}: {})}).format(amount)+(fiat?'':` ${currency}`);
}
