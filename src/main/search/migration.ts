// Native GIN array indexes support literal substring search without introducing
// a database extension. Three-character candidates are checked against the exact
// substring afterwards; one/two-character queries use the bounded result scan.
export const localSearchIndexMigration = { version: 46, name: 'Indexed Take titles and strategy descriptions', sql: `
CREATE FUNCTION local_search_grams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT substr(lower(value),gram_start,3)),ARRAY[]::text[])
  FROM generate_series(1,char_length(lower(value))-2) AS gram_start;
$$;

CREATE FUNCTION local_strategy_search_text(metadata jsonb,spec jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(metadata->>'title','') || E'\\n' || coalesce(metadata->>'description','') || E'\\n' ||
    coalesce((SELECT string_agg(weight->'instrument'->>'symbol',E'\\n')
      FROM jsonb_array_elements(coalesce(spec->'target'->'weights','[]'::jsonb)) AS weight),'');
$$;

CREATE INDEX takes_search_grams ON takes USING gin(local_search_grams(title));
CREATE INDEX strategy_proposals_search_grams ON strategy_proposals
  USING gin(local_search_grams(local_strategy_search_text(payload->'metadata',payload->'spec')));
CREATE INDEX strategy_versions_search_grams ON strategy_versions
  USING gin(local_search_grams(local_strategy_search_text(metadata,spec)));
CREATE INDEX strategies_search_draft ON strategies(draft_revision_id) WHERE draft_revision_id IS NOT NULL;
CREATE INDEX strategies_search_current ON strategies(current_version_id) WHERE current_version_id IS NOT NULL;
` };
