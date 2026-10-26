import { test, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchSettings } from '../../src/main/search/settings';
import { defaultSearchSettings } from '../../src/shared/search-settings';

test('search settings persist independently and require an explicit AI selection', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'search-settings-'));
  try {
    const service = createSearchSettings(profile);
    expect(await service.read()).toEqual(defaultSearchSettings());
    const value = { ...defaultSearchSettings(), selection: { provider: 'claude', model: 'fixture' }, permissions: { marketData: 'blocked', managedScreeners: 'ask' } };
    await service.save(value);
    expect(await createSearchSettings(profile).read()).toEqual(value);
    await service.save(defaultSearchSettings());
    expect((await service.read()).selection).toBeNull();
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('invalid or Take-derived settings cannot overwrite saved search preferences', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'search-settings-'));
  try {
    const service = createSearchSettings(profile); await service.save(defaultSearchSettings());
    const before = await readFile(join(profile, 'search-settings.json'), 'utf8');
    for (const input of [
      { ...defaultSearchSettings(), selection: { provider: 'unknown', model: 'fixture' } },
      { ...defaultSearchSettings(), selection: { provider: 'claude', model: ' ' } },
      { ...defaultSearchSettings(), permissions: { marketData: 'all', managedScreeners: 'allowed' } },
      { ...defaultSearchSettings(), instructions: 'inherit active take' },
      { ...defaultSearchSettings(), version: 2 },
    ]) expect(() => service.save(input)).toThrow();
    expect(await readFile(join(profile, 'search-settings.json'), 'utf8')).toBe(before);
    await writeFile(join(profile, 'search-settings.json'), '{invalid');
    await expect(service.read()).rejects.toThrow('could not be loaded');
    expect(await readFile(join(profile, 'search-settings.json'), 'utf8')).toBe('{invalid');
  } finally { await rm(profile, { recursive: true, force: true }); }
});


test('effort persists in search settings and Default removes the override', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'search-effort-'));
  try {
    const service = createSearchSettings(profile);
    const selection = { provider: 'chatgpt', model: 'fixture', effort: 'high' };
    await service.save({ ...defaultSearchSettings(), selection });
    expect((await createSearchSettings(profile).read()).selection).toEqual(selection);
    expect(() => service.save({ ...defaultSearchSettings(), selection: { ...selection, effort: 'invalid' } })).toThrow();
    await service.save({ ...defaultSearchSettings(), selection: { provider: 'chatgpt', model: 'fixture' } });
    expect((await service.read()).selection).not.toHaveProperty('effort');
  } finally { await rm(profile, { recursive: true, force: true }); }
});
