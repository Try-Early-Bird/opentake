// Local, CC0 Cryptocurrency Icons catalog. No equity-ticker lookup or remote tracking.
const icons=import.meta.glob('../../../node_modules/cryptocurrency-icons/svg/color/*.svg',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
export function cryptoLogo(symbol:string):string|null {
 return icons[`../../../node_modules/cryptocurrency-icons/svg/color/${symbol.toLowerCase()}.svg`]??null;
}
