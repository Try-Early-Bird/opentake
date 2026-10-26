import { closeDesktop } from '../../helpers/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import sharp from 'sharp';
import { dismissConnectionPrompt } from '../../helpers/onboarding.mjs';
import { stopHost } from '../../helpers/host.mjs';

test('take icons upload in chat, appear on list and detail, replace and remove', { timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-icons-ui-'));
  let app;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dismissConnectionPrompt(page, app);
    await page.evaluate(async () => {
      const takeId = await window.takes.create();
      await window.strategies.propose({ targetTakeId: takeId, expectedRevision: null, expectedVersion: null, operationId: crypto.randomUUID(),
        metadata: { title: 'Icon test take', description: 'Synthetic icon test.', rationale: '', holdings: [] },
        spec: { schemaVersion: 1, kind: 'basket', target: { weights: [{ instrument: { venue: 'robinhood', symbol: 'VTI' }, bps: 9000 }], cashBps: 1000 }, rebalance: { schedule: 'quarterly', driftBandPoints: null, driftBandRelative: null } }, unsupportedRequests: [] });
    });
    await page.reload(); await dismissConnectionPrompt(page, app);
    await page.getByRole('navigation', { name: 'Takes', exact: true }).getByRole('button', { name: /^Icon test take|^New Take/ }).first().click();
    const panel = page.getByRole('complementary', { name: 'Take confirmation', exact: true });
    await panel.getByRole('button', { name: 'Add take icon', exact: true }).waitFor();
    const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#00aa88' } }).png().toBuffer();
    await panel.getByLabel('Choose take icon').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png });
    await panel.getByRole('button', { name: 'Change take icon', exact: true }).locator('img').waitFor();
    const first = await panel.getByRole('button', { name: 'Change take icon', exact: true }).locator('img').getAttribute('src');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Takes', exact: true }).click();
    const row = page.getByRole('region', { name: 'Your takes' }).getByRole('link').filter({ hasText: 'Icon test take' });
    await row.locator('img[data-slot=take-icon]').waitFor(); assert.equal(await row.locator('img[data-slot=take-icon]').getAttribute('src'), first);
    await row.click(); await page.locator('section[aria-labelledby="strategy-heading"] img').waitFor();
    assert.equal(await page.locator('section[aria-labelledby="strategy-heading"] img').getAttribute('src'), first);
    await page.getByRole('button', { name: 'Edit take', exact: true }).click();
    const replacement = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#8844cc' } }).png().toBuffer();
    await panel.getByLabel('Choose take icon').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: replacement });
    await page.waitForFunction(old => Boolean(document.querySelector('button[aria-label="Change take icon"] img')?.getAttribute('src')) && document.querySelector('button[aria-label="Change take icon"] img').getAttribute('src') !== old, first);
    await panel.getByRole('button', { name: 'Remove take icon', exact: true }).click();
    await panel.getByRole('button', { name: 'Add take icon', exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Takes', exact: true }).click();
    await row.waitFor(); await row.locator('img[data-slot=take-icon]').waitFor({state:'detached'}); assert.equal(await row.locator('img[data-slot=take-icon]').count(), 0);
  } finally { if (app) await closeDesktop(app); await stopHost(profile); await rm(profile, { recursive: true, force: true }); }
});
