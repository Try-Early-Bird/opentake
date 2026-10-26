import { closeDesktop } from '../../helpers/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from '../../helpers/onboarding.mjs';
import { stopHost } from '../../helpers/host.mjs';

test('consolidated AI picker handles selection, refresh errors, connections and small windows', { timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-picker-'));
  let app;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, app);
    await app.evaluate(({ ipcMain }) => {
      globalThis.pickerFailure = false;
      for (const name of ['ai:status', 'chat:models']) ipcMain.removeHandler(name);
      ipcMain.handle('ai:status', () => [{ provider: 'claude', status: 'connected' }, { provider: 'chatgpt', status: 'disconnected' }, { provider: 'opencode', status: 'disconnected' }]);
      ipcMain.handle('chat:models', () => globalThis.pickerFailure ? { ok: false, message: 'Synthetic catalog unavailable.' } : { ok: true, source: 'runtime', models: [
        { value: 'default', label: 'Claude Sonnet 5.5 (Default)', imageInput: true, effortLevels: ['low', 'medium', 'high', 'max'] },
        { value: 'opus', label: 'Claude Opus 5.5', imageInput: true, effortLevels: ['low', 'medium', 'high', 'max'] },
        { value: 'haiku', label: 'Claude Haiku 4.5', imageInput: false },
      ] });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Opentake home', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Choose AI model', exact: true });
    await trigger.getByText('Sonnet 5.5', { exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'AI provider' }).count(), 0);
    // A pointer left over the menu by an earlier click would steal its keyboard highlight.
    await page.mouse.move(1, 1);
    await trigger.focus(); await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await menu.waitFor();
    assert.equal(await page.getByRole('menuitemradio', { name: /Sonnet 5.5/ }).getAttribute('aria-checked'), 'true');
    const slider = page.getByRole('slider', { name: 'Thinking effort' });
    await slider.waitFor();
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Default');
    await page.keyboard.press('End');
    // Keyboard navigation must reach the slider; a slow runner may need the key a second time.
    const sliderFocused = ms => slider.evaluate((el, ms) => new Promise(resolve => { const deadline = performance.now() + ms; const check = () => el === document.activeElement ? resolve(true) : performance.now() > deadline ? resolve(false) : requestAnimationFrame(check); check(); }), ms);
    if (!await sliderFocused(1000)) await page.keyboard.press('End');
    assert.equal(await sliderFocused(2000), true);
    await page.keyboard.press('ArrowRight');
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Low');
    const sliderBounds = await slider.boundingBox();
    await slider.click({ position: { x: sliderBounds.width / 2, y: sliderBounds.height / 2 } });
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Medium');
    await page.keyboard.press('End');
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Max');
    assert.equal(await menu.isVisible(), true);
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await trigger.click();
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Max');
    await page.getByRole('menuitemradio', { name: 'Opus 5.5', exact: true }).click();
    await trigger.click();
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Max');
    await page.getByRole('menuitemradio', { name: 'Haiku 4.5', exact: true }).click();
    await trigger.click(); await menu.waitFor();
    assert.equal(await slider.count(), 0);
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    await trigger.getByText('Haiku 4.5', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Attach files', exact: true }).getAttribute('title'), 'Attach PDFs or text files');
    await trigger.click(); await menu.waitFor();
    await page.waitForFunction(() => {
      const popup = document.querySelector('[role=menu]')?.getBoundingClientRect();
      const composer = document.querySelector('form')?.getBoundingClientRect();
      return popup && composer && popup.bottom < composer.top;
    });
    await page.getByRole('menuitemradio', { name: /Sonnet 5.5/ }).click();
    await trigger.click();
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Default');
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    await app.evaluate(() => { globalThis.pickerFailure = true; });
    await trigger.click(); await page.getByRole('menuitem', { name: 'Refresh models', exact: true }).click();
    await menu.getByText('Synthetic catalog unavailable.', { exact: true }).waitFor();
    await app.evaluate(() => { globalThis.pickerFailure = false; });
    await page.getByRole('menuitem', { name: 'Refresh models', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /Sonnet 5.5/ }).waitFor();
    // Refresh replaces the error row with the taller catalog. The positioner
    // updates on a later frame; visible options do not mean layout has settled.
    await page.waitForFunction(() => {
      const composer = document.querySelector('form')?.getBoundingClientRect();
      const popup = document.querySelector('[role="menu"]')?.getBoundingClientRect();
      return composer && popup && popup.height > 0 && popup.bottom < composer.top;
    });
    await page.mouse.move(0, 0);
    if (process.env.OPENTAKE_PICKER_SCREENSHOT) await page.screenshot({ path: process.env.OPENTAKE_PICKER_SCREENSHOT });
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 720 });
    await trigger.click(); await menu.waitFor();
    await page.waitForFunction(() => {
      const bounds = document.querySelector('[role="menu"]')?.getBoundingClientRect();
      return bounds && bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth;
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Connecting from the picker opens the setup modal without leaving the chat.
    await page.getByRole('menuitem', { name: 'Connect ChatGPT', exact: true }).click();
    await page.getByRole('dialog').getByText('Connect ChatGPT', { exact: true }).waitFor();
    assert.doesNotMatch(page.url(), /settings/);
  } finally {
    if (app) await closeDesktop(app);
    await stopHost(profile); await rm(profile, { recursive: true, force: true });
  }
});

test('long OpenRouter catalogs show five featured models and search the rest', { timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-picker-search-'));
  let app;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, app);
    await app.evaluate(({ ipcMain }) => {
      for (const name of ['ai:status', 'chat:models']) ipcMain.removeHandler(name);
      ipcMain.handle('ai:status', () => [{ provider: 'claude', status: 'disconnected' }, { provider: 'chatgpt', status: 'disconnected' }, { provider: 'opencode', status: 'disconnected' }, { provider: 'openrouter', status: 'connected' }, { provider: 'local', status: 'disconnected' }]);
      const entry = (value, label, created) => ({ value, label, created });
      ipcMain.handle('chat:models', (_event, provider) => provider !== 'openrouter' ? { ok: false, message: 'Not connected' } : { ok: true, source: 'catalog', models: [
        entry('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', 9), entry('openai/gpt-6.1-sol', 'OpenAI: GPT-6.1 Sol', 9),
        entry('google/gemini-3.1-pro-preview', 'Google: Gemini 3.1 Pro Preview', 5), entry('google/gemini-3.8-flash', 'Google: Gemini 3.8 Flash', 8),
        entry('x-ai/grok-4.7', 'SpaceXAI: Grok 4.7', 8), entry('x-ai/grok-4.20', 'SpaceXAI: Grok 4.20', 6),
        entry('deepseek/deepseek-v4-pro', 'DeepSeek: DeepSeek V4 Pro', 4), entry('moonshotai/kimi-k3', 'MoonshotAI: Kimi K3', 8),
        entry('z-ai/glm-5.3', 'Z.ai: GLM 5.3', 8), entry('minimax/minimax-m3', 'MiniMax: MiniMax M3', 7), entry('qwen/qwen3.8-max-0902', 'Qwen: Qwen3.8 Max', 7),
      ] });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Opentake home', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Choose AI model', exact: true });
    await trigger.click();
    const group = page.getByRole('menu').getByRole('group');
    await page.getByRole('menuitemradio', { name: 'Google: Gemini 3.1 Pro Preview', exact: true }).waitFor();
    // Start from a featured choice; the current non-featured model is intentionally appended.
    await page.getByRole('menuitemradio', { name: 'Google: Gemini 3.1 Pro Preview', exact: true }).click();
    await trigger.click();
    const featured = await page.getByRole('menuitemradio').allTextContents();
    assert.deepEqual(featured, ['Google: Gemini 3.1 Pro Preview', 'SpaceXAI: Grok 4.7', 'DeepSeek: DeepSeek V4 Pro', 'MoonshotAI: Kimi K3', 'Z.ai: GLM 5.3']);
    assert.equal(await group.getByText(/Claude|GPT/).count(), 0);
    // Provider sections collapse, and stay collapsed when the picker reopens.
    const header = page.getByRole('menuitem', { name: 'OpenRouter models', exact: true });
    assert.equal(await header.getAttribute('aria-expanded'), 'true');
    await header.click();
    assert.equal(await header.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('menuitemradio').count(), 0);
    assert.equal(await page.getByRole('menuitem', { name: /More OpenRouter models/ }).count(), 0);
    await page.keyboard.press('Escape'); await trigger.click();
    assert.equal(await page.getByRole('menuitem', { name: 'OpenRouter models', exact: true }).getAttribute('aria-expanded'), 'false');
    await page.getByRole('menuitem', { name: 'OpenRouter models', exact: true }).click();
    assert.equal(await page.getByRole('menuitemradio').count(), 5);
    await page.getByRole('menuitem', { name: 'More OpenRouter models (11)', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('OpenRouter models', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('option').count(), 11);
    await dialog.getByLabel('Search models').fill('minimax m3');
    assert.deepEqual(await dialog.getByRole('option').allTextContents(), ['MiniMax: MiniMax M3']);
    await dialog.getByLabel('Search models').press('Enter');
    await dialog.waitFor({ state: 'detached' });
    await trigger.getByText('MiniMax: MiniMax M3', { exact: true }).waitFor();
    assert.equal(await page.getByText('Write a message or attach an image.').count(), 0);
    await trigger.click();
    assert.equal(await page.getByRole('menuitemradio', { name: 'MiniMax: MiniMax M3', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('menuitemradio').count(), 6);
  } finally {
    if (app) await closeDesktop(app);
    await stopHost(profile); await rm(profile, { recursive: true, force: true });
  }
});
