// A take's display name is its strategy's committed metadata title, as the
// Takes list shows it. `takes.title` is the chat thread's title, set from the
// first prompt, so it is only a fallback for takes never committed.

/** SQL: the committed name of the strategy whose id `strategyId` evaluates to; null when uncommitted. */
export const strategyNameSql = (strategyId: string): string =>
  `(SELECT nullif(name_v.metadata->>'title','') FROM strategies name_s JOIN strategy_versions name_v ON name_v.id=name_s.current_version_id WHERE name_s.id=${strategyId})`;

/** SQL: the committed name of the take whose id `takeId` evaluates to; null when uncommitted. */
export const takeNameSql = (takeId: string): string =>
  `(SELECT nullif(name_v.metadata->>'title','') FROM takes name_t JOIN strategies name_s ON name_s.id=name_t.strategy_id JOIN strategy_versions name_v ON name_v.id=name_s.current_version_id WHERE name_t.id=${takeId})`;

/** SQL: an OrderActivity payload with `takeTitle` replaced by its strategy's current name, when it has one. */
export const withCurrentTakeName = (payload: string): string =>
  `CASE WHEN ${payload}->>'strategyId' IS NULL THEN ${payload} ELSE jsonb_set(${payload},'{takeTitle}',coalesce(to_jsonb(${strategyNameSql(`(${payload}->>'strategyId')::uuid`)}),${payload}->'takeTitle','null'::jsonb)) END`;
