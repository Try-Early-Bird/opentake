import {getFinancialRetention} from '../allocations/retention';
import type {createDatabaseLifecycle} from '../database';
import {backgroundDatabaseWork} from '../database-client';
import {decimalToScaledInteger as units,scaledIntegerToDecimal as decimal} from '../allocations/decimal';
import {coinbaseSourceId} from '../../shared/coinbase-source';
import type {CoinbaseValuationInput} from './live-valuation';
import type {StreamPrice} from './stream-price-store';
const scale=10n**36n;
/** Complete valuations only: never silently carry stale or missing prices into a chart. */
export function sampleCoinbaseValuation(saved:CoinbaseValuationInput,holdingsAt:number,time:number,quotes:StreamPrice[]){
 const prices:StreamPrice[]=[];
 const incomplete=(reason:string)=>({quality:'incomplete' as const,reason,totalValue:null,prices});
 if(time<holdingsAt||time-holdingsAt>900000)return incomplete('stale_holdings');
 if(saved.warnings?.length||saved.portfolio.currency!=='USD')return incomplete('unsupported_holdings');
 const byProduct=new Map(quotes.map(q=>[q.product,q]));let total=0n,reported=0n;
 try{
  for(const position of saved.spotPositions){
   const quantity=units(position.quantity,36),value=units(position.marketValue,36);
   if(quantity<0n||value<0n||position.currency!=='USD')return incomplete('unsupported_holdings');
   reported+=value;
   if(position.isCash){if(position.asset!=='USD')return incomplete('unsupported_cash');total+=value;continue;}
   if(quantity===0n){if(value!==0n)return incomplete('holdings_coverage');continue;}
   const quote=byProduct.get(position.asset+'-USD');
   if(!quote||!Number.isFinite(quote.eventTime)||time-quote.eventTime>15000||quote.eventTime>time+2000)return incomplete('missing_price');
   const price=units(quote.price,36);if(price<=0n)return incomplete('invalid_price');
   total+=quantity*price/scale;prices.push({...quote});
  }
  const difference=reported-units(saved.portfolio.totalValue,36);
  if(difference>scale/100n||difference<-(scale/100n))return incomplete('holdings_coverage');
  return {quality:'complete' as const,reason:null,totalValue:decimal(total,36),prices};
 }catch{return incomplete('invalid_value');}
}
export function createCoinbaseValuationSnapshots(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,snapshot:()=>{revision:number;quotes:StreamPrice[]},allowed:()=>boolean,now=Date.now,onError:()=>void=()=>{}){
 let timer:ReturnType<typeof setInterval>|undefined,work:Promise<void>|undefined,closed=false,lastBucket=-1,lastCleanup=-Infinity;
 async function flush(){
  if(!allowed())return;const time=now(),bucket=Math.floor(time/60000)*60000;
  if(bucket===lastBucket)return;const current=snapshot();
  await backgroundDatabaseWork(()=>database.use(db=>db.transaction(async tx=>{
   if(!allowed())return;
   const source=(await tx.query(`SELECT s.id FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision WHERE s.id=$1 AND s.current_revision=$2 AND s.enabled AND s.validated AND r.config->>'collection'<>'off' FOR SHARE OF s`,[coinbaseSourceId,current.revision])).rows[0];
   if(!source)return;
   const rows=(await tx.query<{account_id:string;observed_at:Date;data:CoinbaseValuationInput;state:string|null}>(`SELECT DISTINCT ON (o.account_id) o.account_id,o.observed_at,o.data,s.state
    FROM coinbase_portfolio_observations o JOIN linked_accounts a ON a.id=o.account_id JOIN platform_connections c ON c.id=a.connection_id
    LEFT JOIN coinbase_portfolio_sync s ON s.account_id=a.id
    WHERE c.owner_id=(SELECT id FROM local_owners LIMIT 1) AND c.venue='coinbase' AND c.status='connected'
    ORDER BY o.account_id,o.observed_at DESC,o.id DESC`)).rows;
   for(const row of rows){
    const valuation=row.state==='completed'?sampleCoinbaseValuation(row.data,row.observed_at.getTime(),time,current.quotes):{quality:'incomplete',reason:'account_sync_unavailable',totalValue:null,prices:[]};
    await tx.query(`INSERT INTO coinbase_valuation_snapshots(account_id,bucket,observed_at,holdings_observed_at,source_revision,quality,reason,total_value,currency,prices)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,bucket) DO NOTHING`,[row.account_id,new Date(bucket),new Date(time),row.observed_at,current.revision,valuation.quality,valuation.reason,valuation.totalValue,row.data.portfolio.currency,JSON.stringify(valuation.prices)]);
   }
   if(time-lastCleanup>=3600000){
    // Retain minute detail for 30 days, then the latest complete/incomplete evidence per hour.
    await tx.query(`DELETE FROM coinbase_valuation_snapshots WHERE (account_id,bucket) IN
     (SELECT account_id,bucket FROM (SELECT account_id,bucket,row_number() OVER
      (PARTITION BY account_id,date_trunc('hour',bucket),quality ORDER BY bucket DESC) AS rank
      FROM coinbase_valuation_snapshots WHERE bucket<$1) old WHERE rank>1)`,[new Date(time-30*86400000)]);
    const retention=await getFinancialRetention(tx);
    if(retention!==null)await tx.query('DELETE FROM coinbase_valuation_snapshots WHERE bucket<$1',[new Date(time-retention*86400000)]);
   }
   if(!allowed())throw Error('Sampling suspended');
  })));
  lastBucket=bucket;if(time-lastCleanup>=3600000)lastCleanup=time;
 }
 function tick(){if(closed)return Promise.resolve();if(!work)work=flush().catch(onError).finally(()=>{work=undefined;});return work;}
 return {tick,start(){if(!closed&&!timer){void tick();timer=setInterval(()=>void tick(),60000);}},async close(){closed=true;if(timer)clearInterval(timer);await work;}};
}
