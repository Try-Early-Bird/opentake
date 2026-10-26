import {instrumentKey,instrumentSchema,type StrategyInstrument} from '../../shared/strategies';
import type {DatabaseClient} from '../database-client';
import {marketKey} from '../../shared/search';
/** Decode only the canonical identity we persist. A display ticker never
 * supplies a pair ID, and noncanonical/other-venue keys cannot fall back. */
export function cryptoInstrumentFromRef(ref:string,symbol:string):StrategyInstrument|null{
 try{
  const [venue,instance,reference,kind]=JSON.parse(ref);
  const parsed=instrumentSchema.safeParse({venue,symbol,market:{venue,instance,reference,kind}});
  return parsed.success&&parsed.data.market?.kind==='crypto'&&instrumentKey(parsed.data)===ref?parsed.data:null;
 }catch{return null;}
}
/** Removed targets remain sellable only through this allocation's exact ledger
 * identity. Fill accounting can resolve the identity after the last unit sold. */
export async function ownedCryptoInstrument(db:Pick<DatabaseClient,'query'>,allocationId:string,pairId:string,requirePositive=true){
 const ref=marketKey({identity:{venue:'robinhood',instance:'production',kind:'crypto',reference:pairId}});
 const rows=(await db.query<{symbol:string}>(`SELECT min(symbol) AS symbol FROM strategy_attribution_entries
  WHERE allocation_id=$1 AND instrument_ref=$2 AND asset_class='crypto'
  HAVING count(DISTINCT symbol)=1 AND ($3::boolean=false OR sum(quantity_delta)>0)`,[allocationId,ref,requirePositive])).rows;
 return rows.length===1?cryptoInstrumentFromRef(ref,rows[0]!.symbol):null;
}

/** A known account denial blocks funding as well as order submission. */
export async function hasCryptoAccessDenial(db:Pick<DatabaseClient,'query'>,accountId:string):Promise<boolean>{
  return (await db.query(`SELECT 1 FROM order_intents WHERE account_id=$1 AND asset_class='crypto' AND status='rejected'
   AND (error_code IN ('provider_invalid_request_region_restricted','provider_invalid_request_agentic_disabled','provider_invalid_request_account_restricted')
    OR lower(placement_result->>'rejectionDiagnostic') LIKE '%agentic trading is not available to%residents%') LIMIT 1`,[accountId])).rows.length>0;
}
