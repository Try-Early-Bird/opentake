import type { DatabaseClient } from '../database-client';
import { marketIdentitySchema, marketKey } from '../../shared/search';
import type { MarketMetadataSnapshot } from '../../shared/data-sources';
import { savedSourceConfig } from './saved-config';

/** Read one exact market, never merge namespaces or silently promote stale data. */
export async function readMarketMetadata(db: Pick<DatabaseClient, 'query'>, ownerId: string, identity: unknown, now = Date.now()): Promise<MarketMetadataSnapshot> {
  const market = marketIdentitySchema.parse(identity), key = marketKey({ identity: market });
  const rows = (await db.query<{
    namespace: string; source_id: string; revision: number; feed_id: string;
    fields: Record<string, string | number | boolean | null>; field_timestamps: Record<string,{updatedAt:number;eventTime:number|null}>; observed_at: Date; event_time: Date | null; config: unknown;
  }>(`SELECT m.namespace,m.source_id,m.revision,m.feed_id,m.fields,m.field_timestamps,m.observed_at,m.event_time,r.config
    FROM market_source_metadata m
    JOIN data_sources s ON s.id=m.source_id AND s.owner_id=m.owner_id AND s.current_revision=m.revision
    JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision
    WHERE m.owner_id=$1 AND m.market_key=$2 AND s.enabled AND s.validated
    ORDER BY m.namespace LIMIT 201`, [ownerId, key])).rows;
  const namespaces: MarketMetadataSnapshot['namespaces'] = [];
  for (const row of rows.slice(0, 200)) {
    const parsed = savedSourceConfig.safeParse(row.config);
    if (!parsed.success || parsed.data.collection === 'off') continue;
    const feed = parsed.data.feeds.find(item => item.id === row.feed_id), destination = feed?.destination;
    if (!feed || destination?.kind !== 'market-metadata' || destination.namespace !== row.namespace || marketKey({identity:destination.market}) !== key) continue;
    const receivedAt = row.observed_at.getTime(), eventTime = row.event_time?.getTime() ?? null;
    const time = eventTime ?? receivedAt;
    // A clock rollback cannot make future-dated data appear fresh.
    const fresh = Number.isFinite(time) && Number.isFinite(receivedAt) && time <= now && receivedAt <= now && now - time <= destination.maxAgeMs && now - receivedAt <= destination.maxAgeMs;
    const fields = Object.fromEntries(Object.entries(row.fields).filter(([name]) => feed.storage.fields.includes(name)));
    const fieldUpdates=Object.fromEntries(Object.keys(fields).map(name=>{
      const saved=row.field_timestamps?.[name],updatedAt=typeof saved?.updatedAt==='number'&&Number.isFinite(saved.updatedAt)?saved.updatedAt:null;
      const fieldTime=typeof saved?.eventTime==='number'&&Number.isFinite(saved.eventTime)?saved.eventTime:null;
      const effective=fieldTime??updatedAt;
      const quality=updatedAt!==null&&effective!==null&&updatedAt<=now&&effective<=now&&now-updatedAt<=destination.maxAgeMs&&now-effective<=destination.maxAgeMs?'fresh' as const:'stale' as const;
      return [name,{updatedAt,eventTime:fieldTime,quality}];
    }));
    namespaces.push({namespace:row.namespace,sourceId:row.source_id,revision:row.revision,feedId:row.feed_id,fields,
      updatedAt:receivedAt,fieldUpdates,receivedAt,eventTime,quality:fresh ? 'fresh' : 'stale',maxAgeMs:destination.maxAgeMs});
  }
  return { market, namespaces, truncated: rows.length > 200 };
}
