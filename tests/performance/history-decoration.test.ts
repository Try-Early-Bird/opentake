import { expect, test } from 'vitest';
import { createFixture, fixtureId } from './fixture';
import { createTakeHistory } from '../../src/main/take-history';
import type { TakeMessage } from '../../src/shared/takes';
import { legacyDecoration } from './history-decoration';

test('windowed message versions match sibling counts across branches, roles, pages and Takes', async () => {
  const f = await createFixture();
  try {
    const history = createTakeHistory(f.database), take = f.allocations[0], other = f.allocations[1];
    const messages: TakeMessage[] = [];
    for (let i = 0; i < 75; i++) {
      const message = { id: fixtureId('version-parity', String(i)), parentId: i < 40 ? null : take.headId, role: i % 2 ? 'assistant' : 'user', text: `Version ${i}`, images: [], tools: [], createdAt: new Date(f.clock()).toISOString(), selection: {provider:'claude', model:'default'}, state:'completed', replay: [{role:'assistant',content:[{type:'text',text:'synthetic replay'}]}] } as TakeMessage;
      await f.db.query('INSERT INTO take_messages(id,take_id,parent_id,data) VALUES($1,$2,$3,$4)', [message.id, take.takeId, message.parentId, JSON.stringify(message)]);
      messages.push(message);
    }
    // A sibling on another Take must not contribute to counts.
    const foreign = {...messages[0], id: fixtureId('version-parity', 'foreign')};
    await f.db.query('INSERT INTO take_messages(id,take_id,parent_id,data) VALUES($1,$2,NULL,$3)', [foreign.id, other.takeId, JSON.stringify(foreign)]);
    // Preserve the old zero-count behavior of a legacy row with no role.
    const {role: _role, ...missingRole} = {...messages[0], id: fixtureId('version-parity', 'missing-role')};
    await f.db.query('INSERT INTO take_messages(id,take_id,parent_id,data) VALUES($1,$2,NULL,$3)', [missingRole.id, take.takeId, JSON.stringify(missingRole)]);
    messages.push(missingRole as TakeMessage);
    for (const page of [messages.slice(0, 30), messages.slice(30, 60), messages.slice(60), [foreign]]) {
      expect(await history.decorate(take.takeId, page)).toEqual(await legacyDecoration(f.db, take.takeId, page));
      expect(JSON.stringify(await history.decorate(take.takeId, page))).not.toContain('synthetic replay');
    }
    expect(await history.decorate(take.takeId, [])).toEqual([]);
    expect((await history.decorate(take.takeId, [missingRole as TakeMessage]))[0]).toMatchObject({versionNumber:0,versionCount:0});
    expect(f.measurement.failures).toEqual([]);
  } finally { await f.close(); }
});
