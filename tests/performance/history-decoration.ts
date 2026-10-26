import type { DatabaseClient } from '../../src/main/database-client';
import type { TakeMessage } from '../../src/shared/takes';
// Exact pre-optimization SQL from 595e96d; reference only, never used by the app.
export const legacyDecorationSql = `SELECT m.id,(SELECT count(*)::text FROM take_messages v WHERE v.take_id=m.take_id AND v.parent_id IS NOT DISTINCT FROM m.parent_id AND v.data->>'role'=m.data->>'role' AND v.sequence<=m.sequence) AS number,(SELECT count(*)::text FROM take_messages v WHERE v.take_id=m.take_id AND v.parent_id IS NOT DISTINCT FROM m.parent_id AND v.data->>'role'=m.data->>'role') AS count FROM take_messages m WHERE m.take_id=$1 AND m.id=ANY($2::uuid[])`;
export async function legacyDecoration(db: Pick<DatabaseClient, 'query'>, takeId: string, messages: TakeMessage[]) {
  if (!messages.length) return messages;
  const rows = (await db.query<{id:string;number:string;count:string}>(legacyDecorationSql, [takeId, messages.map(m => m.id)])).rows;
  return messages.map(({replay,...m}) => {
    const v = rows.find(r => r.id === m.id);
    return {...m, versionNumber: Number(v?.number ?? 1), versionCount: Number(v?.count ?? 1)};
  });
}
