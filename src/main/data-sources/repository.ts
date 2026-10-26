import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';
import { savedSourceConfig, type SavedSource } from './saved-config';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
export function createSourceRepository(database: Database) {
  return {
    async list(ownerId: string): Promise<SavedSource[]> {
      z.uuid().parse(ownerId);
      return database.use(async db => (await db.query<SavedSource>(`SELECT s.id,s.owner_id AS "ownerId",s.current_revision AS revision,s.enabled,s.validated,r.config
        FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision
        WHERE s.owner_id=$1 ORDER BY s.created_at,s.id`, [ownerId])).rows);
    },
    async save(ownerId: string, input: unknown, existing?: { id: string; revision: number }): Promise<SavedSource> {
      z.uuid().parse(ownerId); const config = savedSourceConfig.parse(input);
      if (existing) { z.uuid().parse(existing.id); z.number().int().positive().parse(existing.revision); }
      return database.use(db => db.transaction(async tx => {
        // Serialize source admission as well as edits; concurrent creates cannot exceed the profile cap.
        const owner = await tx.query('SELECT id FROM local_owners WHERE id=$1 FOR UPDATE', [ownerId]);
        if (!owner.rows.length) throw Error('Source owner unavailable');
        for(const venue of ['robinhood','coinbase']){
        const accountIds=[...new Set(config.feeds.flatMap(feed=>feed.destination?.kind==='market-prices'&&feed.destination.market.venue===venue?feed.destination.holdings?.accountIds??[]:[]))];
        if(accountIds.length){
          const accounts=await tx.query(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
            WHERE c.owner_id=$1 AND c.venue=$3 AND c.status='connected' AND a.available AND a.agentic_allowed AND a.id=ANY($2::uuid[])`,[ownerId,accountIds,venue]);
          if(accounts.rows.length!==accountIds.length)throw Error('Selected holdings accounts are unavailable');
        }
        }
        const id = existing?.id ?? randomUUID(), revision = (existing?.revision ?? 0) + 1;
        if (existing) {
          const changed = await tx.query(`UPDATE data_sources SET current_revision=$4,enabled=false,validated=false
            WHERE owner_id=$1 AND id=$2 AND current_revision=$3 RETURNING id`, [ownerId, id, existing.revision, revision]);
          if (!changed.rows.length) throw Error('Source changed; reload before saving');
          // Obsolete values never become current after a schema or field-policy change.
          await tx.query('DELETE FROM data_source_latest WHERE source_id=$1', [id]);
        } else {
          const count = (await tx.query<{count: number}>('SELECT count(*)::int AS count FROM data_sources WHERE owner_id=$1', [ownerId])).rows[0].count;
          if (count >= 20) throw Error('Source limit reached');
          await tx.query('INSERT INTO data_sources(id,owner_id,current_revision) VALUES($1,$2,$3)', [id, ownerId, revision]);
        }
        await tx.query('INSERT INTO data_source_revisions(source_id,revision,config) VALUES($1,$2,$3)', [id, revision, JSON.stringify(config)]);
        return { id, ownerId, revision, enabled: false, validated: false, config } as SavedSource;
      }));
    },
    /** Host calls only after a bounded local preview succeeds for this exact revision. */
    async validate(ownerId: string, id: string, revision: number) {
      return database.use(async db => {
        const result = await db.query('UPDATE data_sources SET validated=true WHERE owner_id=$1 AND id=$2 AND current_revision=$3 RETURNING id', [z.uuid().parse(ownerId), z.uuid().parse(id), z.number().int().positive().parse(revision)]);
        if (!result.rows.length) throw Error('Source changed; validate again');
      });
    },
    async enable(ownerId: string, id: string, revision: number, enabled: boolean) {
      z.boolean().parse(enabled);
      return database.use(async db => {
        const result = await db.query(`UPDATE data_sources s SET enabled=$4 WHERE owner_id=$1 AND id=$2 AND current_revision=$3
          AND (NOT $4 OR (validated AND EXISTS(SELECT 1 FROM data_source_revisions r WHERE r.source_id=s.id AND r.revision=s.current_revision AND r.config->>'collection'<>'off'))) RETURNING id`,
          [z.uuid().parse(ownerId), z.uuid().parse(id), z.number().int().positive().parse(revision), enabled]);
        if (!result.rows.length) throw Error('Source unavailable or needs validation');
      });
    },
  };
}
