import {resolveSourceMarketIdentifier,marketIdentifierError} from '../../shared/source-market-identifiers';
import {writeCustomCryptoPrice} from './crypto-prices';
import {heldEquityMarket,heldCryptoMarket} from './held-markets';
import type { DatabaseClient } from '../database-client';
import type { DataObservation } from '../../shared/data-sources';
import { marketKey } from '../../shared/search';
import type { CustomSourceConfig } from './config';

type Query = Pick<DatabaseClient, 'query'>;
type Feed = CustomSourceConfig['feeds'][number];
export interface DestinationResult { target: string; outcome: 'would-write' | 'written' | 'stale' | 'invalid' | 'missing-market' | 'preserved' | 'namespace-conflict' | 'filtered' | 'holdings-unavailable'; current?: unknown; proposed?: unknown }
/** Caller owns the source-revision fence and transaction; dry run never mutates. */
export async function applyDestination(db: Query, owner: string, feed: Feed, observation: DataObservation, now: number, dryRun = false, routed = false): Promise<DestinationResult | null> {
  const destination = feed.destination;
  if (!destination || destination.kind === 'custom-feed') return null;
  if(destination.kind==='market-prices'){
    const rejected=(outcome:DestinationResult['outcome']):DestinationResult=>({target:'market_quotes:routed',outcome});
    if(observation.payload.kind!=='event')return rejected('invalid');
    const fields=observation.payload.fields;
    for(const c of destination.conditions){
      if(!Object.hasOwn(fields,c.field))return rejected('filtered');
      const value=fields[c.field];
      const matches=c.op==='equals'?value===c.value:c.op==='in'?c.values.includes(value):
        typeof value==='number'&&Number.isFinite(value)&&(c.op==='gt'?value>c.value:c.op==='gte'?value>=c.value:c.op==='lt'?value<c.value:value<=c.value);
      if(!matches)return rejected('filtered');
    }
    const incoming=fields[destination.symbolField],price=fields[destination.priceField];
    if(typeof incoming!=='string'||typeof price!=='string')return rejected('invalid');
    if(marketIdentifierError(destination.market.venue,destination.identifier))return rejected('invalid');
    const symbol=resolveSourceMarketIdentifier(incoming,destination.identifier);
    if(symbol===null)return rejected('missing-market');
    if(destination.market.venue==='coinbase'){
      if(destination.holdings){const held=await heldCryptoMarket(db,owner,destination.holdings,symbol,now);if(held!=='held')return rejected(held==='unavailable'?'holdings-unavailable':'filtered');}
      return writeCustomCryptoPrice(db,destination,observation,symbol,price,now,dryRun);
    }
    if(!/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol))return rejected('invalid');
    if(destination.holdings){
      const held=await heldEquityMarket(db,owner,destination.holdings,symbol,now);
      if(held!=='held')return rejected(held==='unavailable'?'holdings-unavailable':'filtered');
    }
    const {symbolField,identifier,priceField,conditions,holdings,...policy}=destination;
    return applyDestination(db,owner,{...feed,destination:{...policy,kind:'market-price',market:{...destination.market,reference:symbol}}},
      {...observation,payload:{kind:'metric',value:price}},now,dryRun,true);
  }
  const target = destination.kind === 'market-price' ? `market_quotes:${destination.market.reference}` : `market-metadata:${marketKey({ identity: destination.market })}:${destination.namespace}`;
  const result = (outcome: DestinationResult['outcome'], current?: unknown, proposed?: unknown): DestinationResult => ({ target, outcome, ...(current === undefined ? {} : { current }), ...(proposed === undefined ? {} : { proposed }) });
  const time = observation.eventTime ?? observation.receivedAt;
  if (observation.origin !== 'live' || time > now || observation.receivedAt > now || now - time > destination.maxAgeMs || now - observation.receivedAt > destination.maxAgeMs) return result('stale');
  if (destination.kind === 'market-price') {
    if (observation.payload.kind !== 'metric' || observation.unit !== 'USD' || observation.eventTime === null) return result('invalid');
    const price = observation.payload.value;
    const provider = observation.adapterId;
    if (provider !== 'custom-http' && provider !== 'custom-websocket') return result('invalid');
    // Exact numeric(38,18) domain. Do not coerce exponent notation or round precision.
    if (!/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/.test(price) || !/[1-9]/.test(price)) return result('invalid');
    const row = (await db.query<{ price: string | null; observed_at: Date; last_trade_at: Date | null; price_provider: string; price_source_id: string | null; price_source_feed: string | null }>(
      'SELECT price::text,observed_at,last_trade_at,price_provider,price_source_id,price_source_feed FROM market_quotes WHERE symbol=$1 FOR UPDATE', [destination.market.reference])).rows[0];
    if (!row) return result('missing-market'); // Symbol-only source data never creates a market.
    const current = { price: row.price, provider: row.price_provider, observedAt: row.observed_at.toISOString() };
    const proposed = { price, currency: 'USD', provider, eventTime: new Date(time).toISOString() };
    if (row.price !== null && time <= (row.last_trade_at?.getTime() ?? row.observed_at.getTime())) return result('preserved', current, proposed);
    const own = row.price_source_id === observation.sourceId && row.price_source_feed === observation.feedId;
    if (routed && own && now-row.observed_at.getTime()<5000) return result('preserved',current,proposed);
    if (row.price !== null && !own && (destination.policy === 'fill-missing' || now - row.observed_at.getTime() <= destination.maxAgeMs)) return result('preserved', current, proposed);
    if (!dryRun) await db.query(`UPDATE market_quotes SET price=$2,last_trade_at=$3,observed_at=$4,
      price_provider=$8,price_source_id=$5,price_source_revision=$6,price_source_feed=$7 WHERE symbol=$1`,
      [destination.market.reference, price, new Date(time).toISOString(), new Date(observation.receivedAt).toISOString(), observation.sourceId, observation.configVersion, observation.feedId, provider]);
    return result(dryRun ? 'would-write' : 'written', current, proposed);
  }
  if (observation.payload.kind !== 'event') return result('invalid');
  const identity = marketKey({ identity: destination.market });
  const row = (await db.query<{ source_id: string; feed_id: string; fields: Record<string, unknown>; field_timestamps: Record<string,{updatedAt:number;eventTime:number|null}>; observed_at: Date; event_time: Date | null }>(
    'SELECT source_id,feed_id,fields,field_timestamps,observed_at,event_time FROM market_source_metadata WHERE owner_id=$1 AND market_key=$2 AND namespace=$3 FOR UPDATE', [owner, identity, destination.namespace])).rows[0];
  if (row && (row.source_id !== observation.sourceId || row.feed_id !== observation.feedId)) return result('namespace-conflict');
  if (row && (time <= (row.event_time ?? row.observed_at).getTime() || observation.receivedAt <= row.observed_at.getTime())) return result('preserved');
  const selected = Object.fromEntries(feed.storage.fields.filter(key => Object.hasOwn(observation.payload.kind === 'event' ? observation.payload.fields : {}, key)).map(key => [key, observation.payload.kind === 'event' ? observation.payload.fields[key] : null]).filter(([, value]) => value !== null));
  // Null and absent fields preserve existing data; other namespaces are never read/merged.
  if (!Object.keys(selected).length) return result('preserved');
  const merged = { ...(row?.fields ?? {}), ...selected };
  if (Object.keys(merged).length > 64 || Buffer.byteLength(JSON.stringify(merged)) > 12000) return result('invalid');
  const timestamps={...(row?.field_timestamps??{}),...Object.fromEntries(Object.keys(selected).map(key=>[key,{updatedAt:observation.receivedAt,eventTime:observation.eventTime,provenance:{runtimeId:observation.runtimeId,epoch:observation.epoch,revision:observation.configVersion,adapterId:observation.adapterId,adapterVersion:observation.adapterVersion,origin:observation.origin}}]))};
  if (!dryRun) await db.query(`INSERT INTO market_source_metadata(owner_id,market_key,namespace,source_id,revision,feed_id,fields,observed_at,event_time,field_timestamps)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner_id,market_key,namespace) DO UPDATE SET
    revision=excluded.revision,fields=excluded.fields,observed_at=excluded.observed_at,event_time=excluded.event_time,field_timestamps=excluded.field_timestamps`,
    [owner, identity, destination.namespace, observation.sourceId, observation.configVersion, observation.feedId, JSON.stringify(merged), new Date(observation.receivedAt).toISOString(), observation.eventTime === null ? null : new Date(time).toISOString(),JSON.stringify(timestamps)]);
  return result(dryRun ? 'would-write' : 'written', row?.fields ?? {}, merged);
}

export async function recordDestinationResult(db: Query, observation: DataObservation, result: DestinationResult, now: number) {
  await db.query(`INSERT INTO data_source_destination_status(source_id,feed_id,revision,target,outcome,checked_at) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(source_id,feed_id) DO UPDATE SET revision=excluded.revision,target=excluded.target,outcome=excluded.outcome,checked_at=excluded.checked_at`,
    [observation.sourceId, observation.feedId, observation.configVersion, result.target, result.outcome, new Date(now).toISOString()]);
}
