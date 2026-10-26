import {z} from 'zod';
import type {DatabaseClient} from '../database-client';
export const marketSuggestionRequest=z.object({action:z.literal('market-suggestions'),venue:z.enum(['robinhood','coinbase']),query:z.string().trim().max(80)}).strict();
/** Local market identities only; never discovers accounts or requests broker data. */
export async function marketSuggestions(db:Pick<DatabaseClient,'query'>,venue:'robinhood'|'coinbase',query:string):Promise<string[]>{
 const term=query.trim().toUpperCase();
 if(venue==='robinhood')return (await db.query<{id:string}>(`SELECT symbol AS id FROM market_quotes WHERE strpos(symbol,$1)>0 AND symbol ~ '^[A-Z][A-Z0-9.-]{0,11}$' ORDER BY (symbol=$1) DESC,symbol LIMIT 20`,[term])).rows.map(r=>r.id);
 return (await db.query<{id:string}>(`SELECT pair AS id FROM public_price_cache WHERE provider='coinbase' AND kind='product' AND interval_seconds=0 AND bucket=0
 AND pair ~ '^[A-Z0-9._]+-USD$' AND data->>'id'=pair AND data->>'venue'='coinbase' AND data->>'quote'='USD' AND (data->>'base')||'-USD'=pair
 AND strpos(pair,$1)>0 ORDER BY (pair=$1) DESC,pair LIMIT 20`,[term])).rows.map(r=>r.id);
}
