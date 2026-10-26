// v46 briefly shipped with the SQL alias `position`. Existing ledgers retain
// that exact SQL/hash; repair the function forward, never rewrite v46.
export const searchGramsCompatibilityMigration = { version: 50, name: 'Normalize historical search gram function', sql: `
CREATE OR REPLACE FUNCTION local_search_grams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT substr(lower(value),gram_start,3)),ARRAY[]::text[])
  FROM generate_series(1,char_length(lower(value))-2) AS gram_start;
$$;
` };
