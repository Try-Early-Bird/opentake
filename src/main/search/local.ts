import type { createDatabaseLifecycle } from '../database';
import type { TakeHit } from '../../shared/search';

export function createLocalSearch(db: Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>) {
  return async (query: string, archived: boolean) => {
    // Each UNION branch can use its own GIN index. Exact substring rechecks
    // retain literal punctuation and eliminate unordered-gram false positives.
    // Joining revision pointers excludes historical descriptions immediately.
    const rows = (await db.use(d => d.query<TakeHit>(`WITH matches AS (
      SELECT t.id FROM takes t
      WHERE (char_length($1)<3 OR local_search_grams(t.title) @> local_search_grams($1))
        AND strpos(lower(t.title),lower($1))>0
      UNION
      SELECT t.id FROM strategy_proposals p JOIN strategies s ON s.draft_revision_id=p.id
        JOIN takes t ON t.strategy_id=s.id
      WHERE (char_length($1)<3 OR local_search_grams(local_strategy_search_text(p.payload->'metadata',p.payload->'spec')) @> local_search_grams($1))
        AND strpos(lower(local_strategy_search_text(p.payload->'metadata',p.payload->'spec')),lower($1))>0
      UNION
      SELECT t.id FROM strategy_versions v JOIN strategies s ON s.current_version_id=v.id
        JOIN takes t ON t.strategy_id=s.id
      WHERE s.draft_revision_id IS NULL
        AND (char_length($1)<3 OR local_search_grams(local_strategy_search_text(v.metadata,v.spec)) @> local_search_grams($1))
        AND strpos(lower(local_strategy_search_text(v.metadata,v.spec)),lower($1))>0
    ) SELECT t.id,t.title,t.strategy_id AS "strategyId",
      coalesce(p.payload->'metadata'->>'title',v.metadata->>'title') AS "strategyTitle",
      (t.archived_at IS NOT NULL) AS archived
      FROM matches m JOIN takes t ON t.id=m.id LEFT JOIN strategies s ON s.id=t.strategy_id
      LEFT JOIN strategy_proposals p ON p.id=s.draft_revision_id
      LEFT JOIN strategy_versions v ON v.id=s.current_version_id
      WHERE (t.archived_at IS NOT NULL)=$2
      ORDER BY CASE WHEN lower(t.title)=lower($1) THEN 0 ELSE 1 END,t.updated_at DESC,t.id LIMIT 21`, [query, archived]))).rows;
    return { takes: rows.slice(0, 20), truncated: rows.length > 20 };
  };
}
