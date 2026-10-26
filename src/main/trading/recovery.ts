import type {TradingVenue} from '../../shared/trading';
export interface OrderIdentity {venue:TradingVenue;accountId:string;clientRef:string}
export interface OrderEvidence extends OrderIdentity {providerRef:string}
/** Absence cannot prove rejection. Ambiguous identities cannot authorize a binding. */
export function recoverOrder<T extends OrderEvidence>(identity:OrderIdentity,evidence:readonly T[]):T|null{
 const matches=evidence.filter(e=>e.venue===identity.venue&&e.accountId===identity.accountId&&e.clientRef===identity.clientRef);
 if(matches.length>1)throw new Error('Ambiguous provider binding');
 return matches[0]??null;
}
