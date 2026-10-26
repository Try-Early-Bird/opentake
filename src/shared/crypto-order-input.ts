/** Normalize only valid thousands grouping; never reinterpret a decimal comma. */
export function cryptoOrderNumber(value:string):string {
 const trimmed=value.trim();
 if(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed))return trimmed.replaceAll(',','');
 if(/^\d+(\.\d+)?$/.test(trimmed))return trimmed;
 throw Error('Enter a number such as 90000 or 90,000. Use a decimal point for cents.');
}
