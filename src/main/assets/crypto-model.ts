import {basketCalendar} from '../trading/session-policy';
import type {DatabaseClient} from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import {instrumentKey,type BasketSpec} from '../../shared/strategies';
import {easternClock,shiftEasternDate} from '../market-series/sessions';
import {computeModelValuations,scheduledRebalanceDays,type ModelValuationRow,type DailyClose} from '../strategies/model-valuation';

type Query=Pick<DatabaseClient,'query'>;
type Version={id:string;sequence:number;spec:BasketSpec};
type Baseline={observed_at:Date;routes:Record<string,string>;valuation:ModelValuationRow};
type Quote={ref:string;routing:string;observed_at:Date;price:string};
export const isRobinhoodCryptoModel=(spec:BasketSpec)=>spec.target.weights.length>0&&spec.target.weights.every(w=>w.instrument.venue==='robinhood'&&w.instrument.market?.kind==='crypto');
export const hasRobinhoodCrypto=(spec:BasketSpec)=>spec.target.weights.every(w=>w.instrument.venue==='robinhood')&&spec.target.weights.some(w=>w.instrument.market?.kind==='crypto');
const modelKey=(i:BasketSpec['target']['weights'][number]['instrument'])=>i.market?instrumentKey(i):i.symbol.toUpperCase();
const allocation=(v:Version,day:string)=>({id:v.id,sequence:v.sequence,effectiveOn:day,cashPercent:v.spec.target.cashBps/100,weights:v.spec.target.weights.map(w=>({symbol:modelKey(w.instrument),weightPercent:w.bps/100}))});
export type CryptoModelResult={ready:true;baselineAt:string;rows:ModelValuationRow[];current:ModelValuationRow}|{ready:false;reason:'unsupported_basket'|'baseline_pending'|'quotes_unavailable'|'routing_changed'|'history_gap'};

/** Observed models start at a saved live baseline, never at an invented past price.
 * Reads replay the existing model engine from that immutable baseline. */
export function createCryptoModel(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,clock=Date.now,equityCloses?:(symbols:string[],from:string,q:Query)=>Promise<Map<string,DailyClose[]>>){
 async function quotes(q:Query,accountId:string,refs:string[]){
  return (await q.query<Quote>(`SELECT DISTINCT ON(instrument_ref,routing) instrument_ref AS ref,routing,observed_at,mark_price::text AS price
   FROM robinhood_crypto_price_samples WHERE account_id=$1 AND instrument_ref=ANY($2::text[]) AND observed_at <= $3 AND observed_at >= $4
   ORDER BY instrument_ref,routing,observed_at DESC`,[accountId,refs,new Date(clock()).toISOString(),new Date(clock()-60000).toISOString()])).rows;
 }
 async function allQuotes(q:Query,accountId:string,spec:BasketSpec){
  const crypto=spec.target.weights.filter(w=>w.instrument.market).map(w=>modelKey(w.instrument));
  const equity=spec.target.weights.filter(w=>!w.instrument.market).map(w=>modelKey(w.instrument));
  const prices=await quotes(q,accountId,crypto);
  if(equity.length)prices.push(...(await q.query<Quote>(`SELECT symbol AS ref,'equity' AS routing,observed_at,price::text AS price FROM market_quotes WHERE symbol=ANY($1::text[]) AND price>0 AND observed_at>=$2 AND observed_at<=$3`,[equity,new Date(clock()-60000).toISOString(),new Date(clock()).toISOString()])).rows);
  return prices;
 }
 async function baseline(q:Query,accountId:string,versionId:string){return (await q.query<Baseline>('SELECT observed_at,routes,valuation FROM robinhood_crypto_model_baselines WHERE account_id=$1 AND version_id=$2',[accountId,versionId])).rows[0];}
 async function seed(q:Query,accountId:string,v:Version){
  if(!hasRobinhoodCrypto(v.spec)||await baseline(q,accountId,v.id))return;
  const refs=v.spec.target.weights.map(w=>modelKey(w.instrument)),fresh=await allQuotes(q,accountId,v.spec);
  if(refs.some(ref=>fresh.filter(p=>p.ref===ref&&p.routing!=='unknown').length!==1)||fresh.some(p=>p.routing==='unknown'))return;
  const day=easternClock(clock()).date;
  const valuation=computeModelValuations({allocations:[allocation(v,day)],days:[day],closesBySymbol:new Map(fresh.map(p=>[p.ref,[{day,close:p.price}]]))})[0];
  if(!valuation)return;
  await q.query(`INSERT INTO robinhood_crypto_model_baselines(account_id,version_id,observed_at,routes,valuation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[accountId,v.id,new Date(clock()).toISOString(),JSON.stringify(Object.fromEntries(fresh.map(p=>[p.ref,p.routing]))),JSON.stringify(valuation)]);
 }
 async function read(q:Query,accountId:string,v:Version):Promise<CryptoModelResult>{
  if(!hasRobinhoodCrypto(v.spec))return {ready:false,reason:'unsupported_basket'};
  const saved=await baseline(q,accountId,v.id);
  if(!saved)return {ready:false,reason:'baseline_pending'};
  const refs=Object.keys(saved.routes),fresh=await allQuotes(q,accountId,v.spec);
  if(refs.some(ref=>fresh.filter(p=>p.ref===ref).length!==1))return {ready:false,reason:'quotes_unavailable'};
  if(fresh.some(p=>saved.routes[p.ref]!==p.routing))return {ready:false,reason:'routing_changed'};
  const first=saved.valuation.valuedOn,today=easternClock(clock()).date;
  const samples=(await q.query<{ref:string;routing:string;day:string;close:string}>(`SELECT DISTINCT ON(instrument_ref,routing,close_day) instrument_ref AS ref,routing,close_day::text AS day,previous_close::text AS close
   FROM robinhood_crypto_price_samples WHERE account_id=$1 AND instrument_ref=ANY($2::text[]) AND close_day>$3 AND close_day<$4 AND observed_at<=$5
   ORDER BY instrument_ref,routing,close_day,observed_at DESC`,[accountId,refs,first,today,new Date(clock()).toISOString()])).rows.filter(p=>saved.routes[p.ref]===p.routing);
  const closes=new Map<string,DailyClose[]>(refs.map(ref=>[ref,samples.filter(p=>p.ref===ref).map(p=>({day:p.day,close:p.close}))]));
  const equity= v.spec.target.weights.filter(w=>!w.instrument.market).map(w=>modelKey(w.instrument));
  if(equity.length){
   if(!equityCloses)return {ready:false,reason:'history_gap'};
   const stockCloses=await equityCloses(equity,first,q);
   for(const key of equity)closes.set(key,stockCloses.get(key)??[]);
  }
  const calendar=[first,...basketCalendar(v.spec,shiftEasternDate(first,1),shiftEasternDate(today,-1))];
  const rebalances=scheduledRebalanceDays(calendar,v.spec.rebalance);
  const banded=v.spec.rebalance.driftBandPoints!==null||v.spec.rebalance.driftBandRelative!==null;
  const complete=(day:string)=>refs.every(ref=>closes.get(ref)!.some(c=>c.day===day));
  if(calendar.slice(1).some(day=>(banded||rebalances.has(day))&&!complete(day)))return {ready:false,reason:'history_gap'};
  const days=calendar.slice(1).filter(complete);
  const rows=computeModelValuations({allocations:[allocation(v,first)],previous:saved.valuation,previousDay:first,days,closesBySymbol:closes,rebalanceDays:rebalances,driftBands:v.spec.rebalance,exactCloseSymbols:new Set(refs)});
  // Today's mark changes value, never repeats a daily model rebalance on every poll.
  const current=computeModelValuations({allocations:[allocation(v,first)],previous:rows.at(-1)??saved.valuation,days:[today],closesBySymbol:new Map(fresh.map(p=>[p.ref,[{day:today,close:p.price}]])),exactCloseSymbols:new Set(refs)})[0]!;
  return {ready:true,baselineAt:new Date(saved.observed_at).toISOString(),rows:[saved.valuation,...rows],current};
 }
 return {read,seed,
  async refresh(accountId:string){await database.use(db=>db.transaction(async q=>{
   const versions=(await q.query<Version>(`SELECT DISTINCT v.id,v.sequence,v.spec FROM strategy_versions v JOIN strategies s ON s.id=v.strategy_id
    WHERE s.archived_at IS NULL AND (s.current_version_id=v.id OR EXISTS(SELECT 1 FROM strategy_allocations a WHERE a.accepted_version_id=v.id AND a.account_id=$1 AND a.status IN ('active','paused','diverged')))`,[accountId])).rows;
   for(const v of versions)await seed(q,accountId,v);
  }));}
 };
}
