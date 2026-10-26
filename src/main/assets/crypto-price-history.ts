import type {createDatabaseLifecycle} from '../database';
import {z} from 'zod';
import {cryptoDecimal} from '../orders/crypto-preview-contract';
import {amount} from '../allocations/ledger';
import {easternClock,shiftEasternDate} from '../market-series/sessions';
import {marketKey} from '../../shared/search';
const sample=z.object({pairId:z.string().min(1),symbol:z.string().min(1),routing:z.string().min(1).nullable(),observedAt:z.iso.datetime({offset:true}),mark:cryptoDecimal,previousClose:cryptoDecimal.nullable()});
export type CryptoPriceSample=z.infer<typeof sample>;
/** Robinhood only, scoped by account, exact pair and routing. Missing intervals
 * stay absent. Previous close is midnight Eastern because requests omit timezone. */
export function createCryptoPriceHistory(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,clock=Date.now){
 return {
  async record(accountId:string,raw:readonly CryptoPriceSample[]){
   const now=clock(),samples=raw.map(value=>sample.parse(value));
   await database.use(db=>db.transaction(async tx=>{
    for(const q of samples){
     const at=Date.parse(q.observedAt);
     if(at>now||now-at>60000||amount(q.mark)<=0n)continue;
     const previous=q.previousClose!==null&&amount(q.previousClose)>0n?q.previousClose:null;
     const ref=marketKey({identity:{venue:'robinhood',instance:'production',kind:'crypto',reference:q.pairId}});
     await tx.query(`INSERT INTO robinhood_crypto_price_samples(account_id,instrument_ref,symbol,routing,bucket_at,observed_at,mark_price,previous_close,close_day)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,instrument_ref,routing,bucket_at) DO UPDATE SET
      observed_at=excluded.observed_at,mark_price=excluded.mark_price,previous_close=excluded.previous_close,close_day=excluded.close_day
      WHERE excluded.observed_at>robinhood_crypto_price_samples.observed_at`,[accountId,ref,q.symbol,q.routing??'unknown',new Date(Math.floor(at/60000)*60000).toISOString(),q.observedAt,q.mark,previous,previous?shiftEasternDate(easternClock(at).date,-1):null]);
    }
   }));
  },
  async read(accountId:string,instrumentRef:string,routing:string,from:string,to:string){
   const start=z.iso.datetime().parse(from),end=z.iso.datetime().parse(to);
   if(start>end)throw Error('Invalid history range');
   return database.use(async db=>({source:'robinhood' as const,routing,
    samples:(await db.query<{observedAt:Date;price:string;previousClose:string|null;closeDay:string|null}>(`SELECT observed_at AS "observedAt",mark_price::text AS price,previous_close::text AS "previousClose",close_day::text AS "closeDay" FROM robinhood_crypto_price_samples WHERE account_id=$1 AND instrument_ref=$2 AND routing=$3 AND observed_at >= $4 AND observed_at <= $5 ORDER BY observed_at`,[accountId,instrumentRef,routing,start,end])).rows,
    // Coverage is observed only; callers must not carry prices through gaps.
    coverage:'observed_only' as const}));
  },
 };
}
