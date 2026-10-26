import {journalRuleEvent,journalRuleEventGap,type InboxCounts} from './event-inbox';
import { applyDestination, recordDestinationResult } from './destinations';
import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';
import type { DataObservation } from '../../shared/data-sources';
import type { DatabaseClient } from '../database-client';
import { sampleSchema, hasNul } from './contracts';
import { savedSourceConfig } from './saved-config';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
type Pending = { owner: string; observation: DataObservation; bytes: number; seq: number };
export interface RetainedSample {
  receivedAt: string; eventTime: string | null;
  data: { fields: Record<string, unknown>; unit: string; kind: string; epoch: number; adapterId: string; adapterVersion: string; timeBasis: string };
}
/** Bounded host write queue. Restored samples are evidence, never fresh runtime state. */
export function createObservationStorage(database: Database, options: { now?: () => number; historyCap?: number; automatic?: boolean } = {}) {
  const now = options.now ?? Date.now, cap = options.historyCap ?? 100_000;
  if (!Number.isInteger(cap) || cap < 1 || cap > 100_000) throw Error('Invalid history cap');
  const queue: Pending[] = [];
  let bytes = 0, closed = false, working: Promise<void> | undefined, seq = 0;
  let nextCleanup = 0;
  let failed = false, isolate = false, quarantined = 0;
  // Feeds whose latest stored attempt was quarantined; cleared when a later observation for the feed commits.
  const quarantinedFeeds = new Map<string, number>();
  const feedKey = (o: Pick<DataObservation, 'sourceId' | 'configVersion' | 'feedId'>) => JSON.stringify([o.sourceId, o.configVersion, o.feedId]);
  // Live events refused or quarantined here; affected rules report event_gap.
  const drops = new Map<string, { owner: string; sourceId: string; feedId: string; configVersion: number; receivedAt: number }>();
  function dropped(owner: string, o: DataObservation) {
    if (o?.payload?.kind !== 'event' || o.origin !== 'live' || !z.uuid().safeParse(owner).success || !z.uuid().safeParse(o.sourceId).success || !Number.isSafeInteger(o.configVersion) || typeof o.feedId !== 'string' || o.feedId.length > 128 || hasNul(o.feedId)) return;
    const key = JSON.stringify([owner, o.sourceId, o.configVersion, o.feedId]);
    if (!drops.has(key) && drops.size >= 256) return;
    const receivedAt = Number.isSafeInteger(o.receivedAt) && o.receivedAt >= 0 && o.receivedAt <= now() + 5000 ? o.receivedAt : now();
    drops.set(key, { owner, sourceId: o.sourceId, feedId: o.feedId, configVersion: o.configVersion, receivedAt: Math.max(receivedAt, drops.get(key)?.receivedAt ?? 0) });
  }
  /** Resolves once everything enqueued before the call has committed (or throws); an in-flight batch is awaited, never assumed to cover it. */
  async function flush() {
    const target = seq;
    do { if (working) await working.catch(() => {}); else await commit(); } while (working || queue.length && queue[0].seq <= target);
  }
  async function commit() {
    if (!queue.length && !drops.size && now() < nextCleanup) return;
    const batch = queue.splice(0, 100); for (const item of batch) bytes -= item.bytes;
    const gaps = [...drops.entries()], isolated = isolate, skipped: Pending[] = [];
    const inbox: InboxCounts = new Map(), history = new Map<string, number>();
    working = database.use(db => db.transaction(async tx => {
      if (now() >= nextCleanup) {
        await tx.query(`UPDATE strategy_rule_event_inbox q SET handled_at=$1,outcome='superseded' WHERE handled_at IS NULL AND NOT EXISTS(SELECT 1 FROM strategy_rule_accepted a JOIN strategy_rule_shadow e ON e.take_id=a.take_id AND e.enabled WHERE a.take_id=q.take_id AND a.revision=q.draft_revision AND e.updated_at<=q.received_at)`,[new Date(now())]);
        await tx.query("DELETE FROM strategy_rule_event_inbox WHERE received_at<$1 AND (handled_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM strategy_rule_accepted a JOIN strategy_rule_shadow e ON e.take_id=a.take_id AND e.enabled WHERE a.take_id=strategy_rule_event_inbox.take_id AND a.revision=strategy_rule_event_inbox.draft_revision))",[new Date(now()-30*86400000)]);
        const removed = await tx.query(`DELETE FROM data_source_history WHERE id IN
          (SELECT id FROM data_source_history WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 1000) RETURNING id`, [new Date(now()).toISOString()]);
        await tx.query(`DELETE FROM public_price_cache WHERE provider='coinbase' AND kind='custom-price' AND
          (fetched_at<$1 OR pair IN (SELECT pair FROM public_price_cache WHERE provider='coinbase' AND kind='custom-price' ORDER BY fetched_at DESC,pair OFFSET 1000))`,[new Date(now()-86400000)]);
        nextCleanup = removed.rows.length === 1000 ? 0 : now() + 60_000;
      }
      for (const item of batch) {
        // After a failed batch, retry item by item: one unpersistable item is quarantined, not retried forever.
        if (!isolated) { await persist(tx, item); continue; }
        const counts = [new Map(inbox), new Map(history)] as const;
        await tx.query('SAVEPOINT observation_item');
        try { await persist(tx, item); await tx.query('RELEASE SAVEPOINT observation_item'); }
        catch {
          await tx.query('ROLLBACK TO SAVEPOINT observation_item'); skipped.push(item);
          inbox.clear(); for (const [key, value] of counts[0]) inbox.set(key, value);
          history.clear(); for (const [key, value] of counts[1]) history.set(key, value);
        }
      }
      for (const item of skipped) { const o = item.observation; if (o.payload.kind === 'event' && o.origin === 'live') await journalRuleEventGap(tx, item.owner, o, o.receivedAt); }
      for (const [, gap] of gaps) await journalRuleEventGap(tx, gap.owner, gap, gap.receivedAt);
    })).then(() => { failed = false; isolate = false; quarantined += skipped.length;
      for (const item of batch) { const key = feedKey(item.observation);
        if (!skipped.includes(item)) { quarantinedFeeds.delete(key); continue; }
        if (!quarantinedFeeds.has(key) && quarantinedFeeds.size >= 256) quarantinedFeeds.delete(quarantinedFeeds.keys().next().value!);
        quarantinedFeeds.set(key, (quarantinedFeeds.get(key) ?? 0) + 1); }
      for (const [key, gap] of gaps) if (drops.get(key) === gap) drops.delete(key); }, () => { queue.unshift(...batch);bytes+=batch.reduce((sum,item)=>sum+item.bytes,0);failed = true; isolate = true; nextCleanup = 0; throw Error('Data source storage unavailable'); }).finally(() => { working = undefined; });
    return working;
    async function persist(tx: Pick<DatabaseClient, 'query'>, { owner, observation: o }: Pending) {
        await tx.query('SELECT id FROM local_owners WHERE id=$1 FOR UPDATE', [owner]);
        const row = (await tx.query<{config: unknown}>(`SELECT r.config FROM data_sources s
          JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision
          WHERE s.owner_id=$1 AND s.id=$2 AND s.current_revision=$3 AND s.enabled AND s.validated FOR UPDATE OF s`, [owner, o.sourceId, o.configVersion])).rows[0];
        if (!row) return; // Revision changed, disabled, restored or deleted while queued.
        const config = savedSourceConfig.parse(row.config);
        if (o.adapterId !== ('transport' in config ? 'custom-websocket' : 'custom-http')) return;
        const feed = config.feeds.find(f => f.id === o.feedId);
        if (!feed || config.collection === 'off' || feed.mapping.kind !== o.payload.kind || feed.unit !== o.unit || o.schemaVersion !== 1) return;
        const dataFields = o.payload.kind === 'event' ? o.payload.fields : o.payload.kind === 'text' || o.payload.kind === 'metric' || o.payload.kind === 'boolean' ? { value: o.payload.value } : {};
        const partialMetadata=feed.destination?.kind==='market-metadata';
        if (feed.mapping.kind === 'event' && !partialMetadata && Object.entries(feed.mapping.fields).some(([key, definition]) => !Object.hasOwn(dataFields, key) || (dataFields[key] === null ? 'null' : typeof dataFields[key]) !== definition.type)) return;
        if(partialMetadata&&feed.mapping.kind==='event'){const declared=feed.mapping.fields;if(Object.entries(dataFields).some(([key,value])=>!Object.hasOwn(declared,key)||(value===null?'null':typeof value)!==declared[key].type))return;}
        if(!partialMetadata)await journalRuleEvent(tx,owner,o,inbox);
        if(feed.storage.mode==='live')return;
        const fields = Object.fromEntries(feed.storage.fields.filter(key => Object.hasOwn(dataFields, key)).map(key => [key, dataFields[key]]));
        if (!partialMetadata&&Object.keys(fields).length !== feed.storage.fields.length) return;
        const data = { fields, unit: o.unit, kind: o.payload.kind, epoch: o.epoch, adapterId: o.adapterId,
          adapterVersion: o.adapterVersion, timeBasis: o.timeBasis };
        // Route markets and partial metadata before sampling; later fields must not be dropped.
        if(feed.destination?.kind==='market-prices'||partialMetadata){
          const destination=await applyDestination(tx,owner,feed,o,now());
          if(destination)await recordDestinationResult(tx,o,destination,now());
        }
        const previous = (await tx.query<{received_at: Date; event_time: Date | null}>(
          'SELECT received_at,event_time FROM data_source_latest WHERE source_id=$1 AND revision=$2 AND feed_id=$3', [o.sourceId, o.configVersion, o.feedId])).rows[0];
        if (previous && (o.receivedAt <= previous.received_at.getTime() || o.eventTime !== null && previous.event_time !== null && o.eventTime < previous.event_time.getTime())) return;
        if (!partialMetadata&&feed.destination?.kind!=='market-prices' && (!previous || o.receivedAt - previous.received_at.getTime() >= 5000)) {
          const destination = await applyDestination(tx, owner, feed, o, now());
          if (destination) await recordDestinationResult(tx, o, destination, now());
        }
        const receivedAt = new Date(o.receivedAt).toISOString(), eventTime = o.eventTime === null ? null : new Date(o.eventTime).toISOString();
        if (!previous || o.receivedAt - previous.received_at.getTime() >= 5000) await tx.query(`INSERT INTO data_source_latest(source_id,revision,feed_id,received_at,event_time,data)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id,revision,feed_id) DO UPDATE SET received_at=excluded.received_at,event_time=excluded.event_time,data=excluded.data`,
          [o.sourceId, o.configVersion, o.feedId, receivedAt, eventTime, JSON.stringify(data)]);
        if (feed.storage.mode !== 'history') return;
        const expires = o.receivedAt + feed.storage.retentionDays * 86_400_000;
        if (expires <= now()) return;
        const last = (await tx.query<{received_at: Date}>(`SELECT received_at FROM data_source_history
          WHERE source_id=$1 AND revision=$2 AND feed_id=$3 ORDER BY received_at DESC,id DESC LIMIT 1`, [o.sourceId, o.configVersion, o.feedId])).rows[0];
        if (last && o.receivedAt - last.received_at.getTime() < feed.storage.sampleEveryMs) return;
        // The profile-wide lock protects the hard row cap across feeds/writers.
        // Counted once per owner per batch, then maintained locally under that lock.
        let count = history.get(owner) ?? (await tx.query<{count: number}>(`SELECT count(*)::int AS count FROM data_source_history h JOIN data_sources s ON s.id=h.source_id WHERE s.owner_id=$1`, [owner])).rows[0].count;
        if (count >= cap) {
          const removed = await tx.query(`DELETE FROM data_source_history WHERE id IN (SELECT h.id FROM data_source_history h
            JOIN data_sources s ON s.id=h.source_id WHERE s.owner_id=$1 ORDER BY h.received_at,h.id LIMIT $2) RETURNING id`, [owner, Math.min(1000, count - cap + 1)]);
          count -= removed.rows.length; history.set(owner, count);
          if (count >= cap) return;
        }
        await tx.query(`INSERT INTO data_source_history(source_id,revision,feed_id,received_at,event_time,expires_at,data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [o.sourceId, o.configVersion, o.feedId, receivedAt, eventTime, new Date(expires).toISOString(), JSON.stringify(data)]);
        history.set(owner, count + 1);
    }
  }
  function admit(owner: string, observation: DataObservation): boolean {
      if (closed||failed) return false;
      try {
        if (hasNul(observation)) return false;
        z.uuid().parse(owner); z.uuid().parse(observation.sourceId);
        z.number().int().positive().parse(observation.configVersion);
        z.number().int().nonnegative().parse(observation.epoch);
        const sample = sampleSchema.parse({ payload: observation.payload, eventTime: observation.eventTime, origin: observation.origin });
        if (sample.origin !== 'live' || observation.receivedAt > now() + 5000 || sample.eventTime !== null && sample.eventTime > now() + 5000 || !Number.isSafeInteger(observation.receivedAt) || observation.receivedAt < 0 || observation.receivedAt > 8_640_000_000_000_000) return false;
        const size = Buffer.byteLength(JSON.stringify(observation));
        if (size > 512 * 1024 || queue.length >= 1000 || bytes + size > 512 * 1024 * 1024) return false;
        queue.push({ owner, observation: structuredClone(observation), bytes: size, seq: ++seq }); bytes += size;
        return true;
      } catch { return false; }
  }

  const timer = options.automatic === false ? undefined : setInterval(() => { void flush().catch(() => {}); }, 1000);
  return {
    enqueue(owner: string, observation: DataObservation): boolean {
      const accepted = admit(owner, observation);
      if (!accepted && !closed) try { dropped(owner, observation); } catch { /* malformed: nothing to attribute */ }
      return accepted;
    },
    status: () => ({ pending: queue.length, failed }),
    diagnostics: () => ({ quarantined, droppedEventFeeds: drops.size, quarantinedFeeds: quarantinedFeeds.size }),
    /** Observations of this feed revision were quarantined and none has committed since. */
    quarantinedFeed: (ref: Pick<DataObservation, 'sourceId' | 'configVersion' | 'feedId'>) => quarantinedFeeds.get(feedKey(ref)) ?? 0,
    flush,
    async read(owner: string, source: string, feedId: string, history = false): Promise<{ quality: 'stale'; samples: RetainedSample[] }> {
      z.uuid().parse(owner); z.uuid().parse(source); z.string().max(80).parse(feedId);
      const table = history ? 'data_source_history' : 'data_source_latest';
      const samples = await database.use(async db => (await db.query<{received_at: Date; event_time: Date | null; data: RetainedSample['data']}>(`
        SELECT d.received_at,d.event_time,d.data FROM ${table} d JOIN data_sources s ON s.id=d.source_id AND s.current_revision=d.revision
        WHERE s.owner_id=$1 AND s.id=$2 AND d.feed_id=$3 ${history ? 'AND d.expires_at>$4' : ''}
        ORDER BY d.received_at DESC LIMIT 100`, history ? [owner, source, feedId, new Date(now()).toISOString()] : [owner, source, feedId])).rows);
      return { quality: 'stale', samples: samples.map(row => ({ receivedAt: row.received_at.toISOString(), eventTime: row.event_time?.toISOString() ?? null, data: row.data })) };
    },
    async close() {
      closed = true; if (timer) clearInterval(timer);
      await working;
      while (queue.length) await flush();
    },
  };
}
