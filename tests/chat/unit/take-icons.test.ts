import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { expect, test } from 'vitest';
import { migrate } from '../../../src/main/migrations';
import { createTakes } from '../../../src/main/takes';

test('take icons persist, belong to their take, and survive cleanup until removed', async () => {
  const db = new PGlite();
  await migrate(db);
  const lifecycle = { use: async <T>(fn: (d: PGlite) => Promise<T>) => fn(db) };
  const models = async () => ({ ok: true as const, source: 'runtime' as const, models: [] });
  let service = createTakes(lifecycle, async () => {}, models);
  try {
    await service.start();
    const takeId = await service.create(), other = await service.create();
    const upload = (id: string) => service.storeImage(id, { id: randomUUID(), name: 'icon.png', mime: 'image/png', width: 1, height: 1, bytes: 1 }, 'AA==');
    const first = await upload(takeId), foreign = await upload(other);
    await expect(service.update(takeId, { iconId: foreign.id })).rejects.toThrow('Attachment unavailable');
    await service.update(takeId, { iconId: first.id });
    await service.close();
    service = createTakes(lifecycle, async () => {}, models);
    await service.start();
    expect((await service.load(takeId)).iconId).toBe(first.id);
    expect(await service.image(first.id)).toBe('data:image/png;base64,AA==');
    const replacement = await upload(takeId);
    await service.update(takeId, { iconId: replacement.id });
    await expect(service.image(first.id)).rejects.toThrow('Image unavailable');
    await service.update(takeId, { draftImages: [replacement.id] });
    await service.update(takeId, { iconId: null });
    expect((await service.load(takeId)).iconId).toBeNull();
    expect(await service.image(replacement.id)).toContain('AA==');
    await service.update(takeId, { draftImages: [] });
    await expect(service.image(replacement.id)).rejects.toThrow('Image unavailable');
    const archivedIcon = await upload(takeId);
    await service.update(takeId, { iconId: archivedIcon.id, archived: true });
    await expect(service.update(takeId, { iconId: null })).rejects.toThrow('Unarchive');
    await service.start();
    expect(await service.image(archivedIcon.id)).toContain('AA==');
  } finally { await service.close(); await db.close(); }
});
