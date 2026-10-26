// Captures the README screenshots from the built app with synthetic demo data, never a real
// profile or credentials. Run `npm run build` first, then: node scripts/readme-screenshots.mjs
// Output: docs/images/*.png. The demo data is fed through the same IPC handlers the UI tests stub.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from '../tests/helpers/onboarding.mjs';
import { closeDesktop } from '../tests/helpers/desktop.mjs';
import { stopHost } from '../tests/helpers/host.mjs';

const out = 'docs/images';
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'opentake-readme-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => console.error('page error:', error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('console error:', message.text().slice(0, 1500)); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dismissConnectionPrompt(page, app);
  await page.waitForFunction(async () => { try { return !!(await window.activity.hostStatus()).pid; } catch { return false; } });
  await page.evaluate(() => document.documentElement.classList.add('dark'));

  await app.evaluate(({ ipcMain }) => {
    // Deterministic smooth series: a gentle trend with small waves.
    const walk = (count, start, drift, wave, seed) => Array.from({ length: count }, (_, i) => start * (1 + drift * i / count + wave * Math.sin(i / 3 + seed) * 0.5 + wave * Math.sin(i / 11 + seed * 2)));
    const iso = ms => new Date(ms).toISOString(), day = 86400000, now = Date.now();
    const account = { id: '11111111-1111-4111-8111-111111111111', venue: 'robinhood', label: 'Individual', available: true, selected: true, accountType: 'limited_margin', optionLevel: 'option_level_2' };
    const takeId = '44444444-4444-4444-8444-444444444444', strategyId = '33333333-3333-4333-8333-333333333333', allocationId = '22222222-2222-4222-8222-222222222222';
    const take = [['NVDA', 3000, 'NVIDIA Corporation', 186.4], ['TSLA', 2000, 'Tesla, Inc.', 431.2], ['ISRG', 2000, 'Intuitive Surgical, Inc.', 548.9], ['ROK', 1500, 'Rockwell Automation, Inc.', 352.7], ['SYM', 1500, 'Symbotic Inc.', 58.3]];
    const own = [['AAPL', 24, 'Apple Inc.', 262.8, 211.4], ['MSFT', 15, 'Microsoft Corporation', 523.6, 410.2], ['VOO', 30, 'Vanguard S&P 500 ETF', 628.1, 512.9]];
    const takeValue = 12480.55, prices = Object.fromEntries([...take, ...own].map(r => [r[0], r[3]]));
    const takePositions = take.map(([symbol, bps]) => ({ instrumentRef: symbol.toLowerCase(), symbol, quantity: (takeValue * bps / 10000 / prices[symbol]).toFixed(4) }));
    const ownPositions = own.map(([symbol, quantity, , price, cost]) => ({ instrumentRef: symbol.toLowerCase(), symbol, quantity: String(quantity), markPrice: price.toFixed(2), marketValue: (quantity * price).toFixed(2), currency: 'USD', assetClass: 'equity', averageCost: cost.toFixed(2), providerUnrealizedPnl: (quantity * (price - cost)).toFixed(2) }));
    const cash = 3912.40, total = takeValue + cash + ownPositions.reduce((s, p) => s + Number(p.marketValue), 0);
    const spec = { schemaVersion: 1, kind: 'basket', target: { weights: take.map(([symbol, bps]) => ({ instrument: { venue: 'robinhood', symbol }, bps })), cashBps: 0 }, rebalance: { schedule: 'monthly', driftBandPoints: null, driftBandRelative: null } };
    const metadata = { title: 'Physical AI', description: 'Companies putting AI into machines that move: chips, robots, autonomy and automated factories.', rationale: 'AI is leaving the data centre for cars, warehouses and operating rooms. This basket holds the compute leader and the companies already shipping robots at scale.', holdings: [] };
    const replace = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn); };
    replace('portfolio:logo', () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
    replace('portfolio:market', (_e, symbol) => { const row = [...take, ...own].find(r => r[0] === symbol); return { symbol, displayName: row?.[2] ?? symbol, fundamentals: { symbol, description: '', market_cap: '900000000000' } }; });
    replace('portfolio:fundamentals', () => Object.fromEntries([...take, ...own].map(([symbol]) => [symbol, { symbol, dividend_yield: '0.4', pe_ratio: '38', market_cap: '900000000000' }])));
    replace('portfolio:search', () => []);
    replace('portfolio:refresh', () => {});
    replace('portfolio:series', (_e, _id, range) => ({ venue: 'robinhood_agentic', range, asOf: iso(now), staleSymbols: [], pendingSymbols: [], refreshingSymbols: [],
      series: [...take, ...own].map(([symbol, , , price], k) => { const pts = walk(26, price * 0.985, 0.015, 0.004, k); return { symbol, interval: 'hour', bounds: 'regular', baseline: { price: pts[0].toFixed(2), kind: 'previous_close' }, price: price.toFixed(2), extendedPrice: null, extendedSession: null, extendedChange: null,
        change: { amount: (price - pts[0]).toFixed(2), percent: ((price / pts[0] - 1) * 100).toFixed(2) }, points: pts.map((c, i) => ({ t: iso(now - (25 - i) * 900000), c: c.toFixed(2), s: 'regular' })) }; }) }));
    replace('portfolio:snapshot', () => ({ account, accounts: [account],
      history: walk(96, total * 0.988, 0.012, 0.003, 1).map((v, i) => ({ observedAt: iso(now - (95 - i) * 900000), totalValue: v.toFixed(2), currency: 'USD' })), positionHistory: [],
      strategies: [{ allocationId, strategyId, takeId, title: metadata.title, description: metadata.description, status: 'active', requiresReconciliation: false, cash: '0', value: takeValue.toFixed(2), positions: takePositions, spec, importedAsOf: null }],
      selfDirectedPositions: ownPositions, reservedCash: '0', selfDirectedCash: cash.toFixed(2), allocationWarnings: [], portfolio: { totalValue: total.toFixed(2), cash: cash.toFixed(2), buyingPower: cash.toFixed(2), currency: 'USD' },
      resources: [{ resource: 'equity_positions', observedAt: iso(now), stale: false, state: 'completed', errorCode: null }],
      positions: [...ownPositions, ...takePositions.map(p => ({ ...p, markPrice: prices[p.symbol].toFixed(2), marketValue: (Number(p.quantity) * prices[p.symbol]).toFixed(2), currency: 'USD', assetClass: 'equity', averageCost: null, providerUnrealizedPnl: null }))],
      orders: [], executions: [{ providerExecutionRef: 'demo-1', orderRef: 'demo-order-1', symbol: 'NVDA', side: 'buy', quantity: takePositions[0].quantity, price: '181.20', occurredAt: iso(now - 2 * day), assetClass: 'equity' }], gaps: [] }));
    const summary = { strategyId, targetTakeId: takeId, title: metadata.title, status: 'committed', dirty: false, archivedAt: null };
    replace('strategies:list', (_e, archived) => archived ? [] : [summary]);
    const verification = { policy: 'personal_basket', version: 1, checkedAt: iso(now - 5 * 60000), accountRef: account.id,
      results: take.map(([symbol]) => ({ instrument: { venue: 'robinhood', symbol }, state: 'pass', tradable: true, fractional: true, reason: '' })) };
    const payload = { metadata, spec, unsupportedRequests: [] };
    const draft = { id: 'p1', strategyId, revision: 1, baseVersion: null, sourceTakeId: takeId, sourceMessageId: 'a1', sourceRunId: null, producer: 'agent', producerIdentity: {},
      previousRevision: null, copiedFrom: null, verification, createdAt: iso(now - 5 * 60000), acceptedVersion: 'v1', ...payload };
    replace('strategies:read', () => ({ strategyId, targetTakeId: takeId, title: metadata.title, archivedAt: null, currentVersion: 'v1', clean: true, historyTruncated: false, proposals: [draft],
      draft, versions: [{ id: 'v1', sequence: 1, proposalId: 'p1', payload, verification, createdAt: iso(now - 200 * day), acceptedBy: 'local' }] }));
    replace('strategies:performance', (_e, id, range, basis) => ({ strategyId: id, range, basis: 'model', actualAvailable: false, investors: 1, actualSince: null, intraday: null, rebalance: spec.rebalance, lastRebalancedAt: iso(now - 12 * day), dividends: 'excluded', stats: [],
      points: walk(250, 100, 0.34, 0.02, 3).map((v, i) => ({ day: iso(now - (249 - i) * day).slice(0, 10), unitValue: v.toFixed(2), source: i < 200 ? 'backtested' : 'live' })) }));
    replace('strategies:markers', () => []);
    const review = { allocationId, status: 'active', restoreRequired: false, pauseReason: null, shareEvents: [], reviewedAt: iso(now), positions: takePositions.map(p => ({ ...p, claimed: p.quantity, available: p.quantity })), cash: { claimed: '0', available: cash.toFixed(2) }, cases: [], blockers: [], ready: true };
    replace('allocations:review', () => review);
    replace('allocations:holdings', () => ({ status: 200, selfDirected: [{ accountId: account.id, asOf: iso(now), reservedCash: '0', positions: [] }], holdings: [{ bucket: { id: allocationId, status: 'active', allocationValue: '10000.00' },
      strategy: { id: strategyId, slug: 'physical-ai', displayName: metadata.title, description: metadata.description, iconUrl: null }, allocation: { sequence: 1, weights: take.map(([symbol, bps]) => ({ symbol, weightPercent: bps / 100 })), cashPercent: 0 },
      valuation: { complete: true, currency: 'USD', cash: '0', totalValue: takeValue.toFixed(2) }, positions: takePositions.map(({ symbol, quantity }) => ({ symbol, quantity, markPrice: prices[symbol].toFixed(2), value: (Number(quantity) * prices[symbol]).toFixed(2) })), requiresReconciliation: false }] }));
    replace('strategies:account-plan', (_e, id) => ({ takeId: id, strategyId, draftRevision: 'v1', title: metadata.title, revision: 'r1', editable: true, reason: null,
      accounts: [{ id: account.id, venue: 'robinhood', label: 'Individual', available: true, selected: true, disabledReason: null, otherTakeCount: 0, balances: [{ asset: 'USD', amount: cash.toFixed(2) }] }],
      routes: [{ venue: 'robinhood', accountId: account.id, assets: take.map(([symbol, bps]) => ({ symbol, bps })) }] }));
    // The Take's chat: a finished conversation in which Claude researched the idea and proposed the basket.
    const selection = { provider: 'claude', model: 'opus' }, at = minutes => iso(now - minutes * 60000);
    const question = 'I think AI is leaving the data centre: robots, self-driving cars and automated factories. Help me build a take around that, about $10k, nothing too speculative.';
    const answer = [
      'Here is a take built around **physical AI**: companies whose products put AI into machines that move.',
      '',
      '| Holding | Weight | Why it fits |',
      '| --- | --- | --- |',
      '| **NVDA** NVIDIA | 30% | Training and on-device compute for robots and cars (Jetson, Drive) |',
      '| **TSLA** Tesla | 20% | Largest fleet collecting driving data; Optimus humanoid programme |',
      '| **ISRG** Intuitive Surgical | 20% | Over 9,000 surgical robots installed, recurring instrument revenue |',
      '| **ROK** Rockwell Automation | 15% | Factory automation and controls, a steadier industrial anchor |',
      '| **SYM** Symbotic | 15% | Warehouse robotics for large retailers; the most volatile holding |',
      '',
      'I kept it to five names you can hold through a cycle. NVDA is the biggest weight because almost every robot in the list runs on its chips. SYM is the speculative edge, so it is capped at 15%.',
      '',
      '**Risks:** the basket leans on one theme and two mega-caps, so expect larger swings than an index fund. Robotaxi and humanoid timelines have slipped before.',
      '',
      'I have proposed this as **Physical AI**, rebalanced monthly. Review the weights on the right and commit when you are happy; nothing is invested until you choose to.',
    ].join('\n');
    const takeChat = { id: takeId, title: metadata.title, headId: 'a1', draft: '', draftImages: [], archivedAt: null, selection, running: false, messages: [
      { id: 'u1', parentId: null, role: 'user', text: question, images: [], tools: [], createdAt: at(6), selection, state: 'completed' },
      { id: 'a1', parentId: 'u1', role: 'assistant', text: answer, images: [], createdAt: at(5), selection, state: 'completed',
        tools: [{ id: 't1', name: 'robinhood_get_equity_quotes', state: 'completed', startedAt: at(5) }, { id: 't2', name: 'robinhood_get_fundamentals', state: 'completed', startedAt: at(5) }, { id: 't3', name: 'opentake_propose_strategy', state: 'completed', startedAt: at(5) }] }] };
    replace('takes:snapshot', (_e, id) => ({ revision: 'readme', takes: [takeChat], take: id === takeId ? takeChat : null, running: false }));
    replace('ai:status', () => [{ provider: 'claude', status: 'connected' }]);
    replace('chat:models', () => ({ ok: true, source: 'runtime', models: [{ value: 'opus', label: 'Claude Opus 5.5', imageInput: true }] }));
    replace('strategies:message-proposals', () => []);
    // The Take's rules panel: none yet (other data-source requests are not shown in these screens).
    replace('dataSources:configure', (_e, request) => request?.action === 'rule-review'
      ? { takeId, revision: 0, version: 'v1', inputRevision: 0, config: { schemaVersion: 1, rules: [] }, inputs: { inputs: [], maxSkewMs: 5000 }, proposals: [], stale: false, execution: 'notifications_and_trading' }
      : []);
    replace('portfolio:strategy-history', (_e, id, range) => ({ allocationId: id, range, points: walk(60, takeValue * 0.82, 0.22, 0.015, 5).map((v, i) => ({ day: iso(now - (59 - i) * day).slice(0, 10), totalValue: v.toFixed(2) })) }));
  });

  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await page.getByRole('heading', { name: 'Individual', exact: true }).waitFor();
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(1200);

  await page.getByRole('button').filter({ hasText: 'Physical AI' }).first().click();
  await page.getByRole('heading', { name: 'Physical AI', exact: true }).waitFor();
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, 'take.png') });

  await page.getByRole('button', { name: 'Edit take', exact: true }).click();
  await page.getByText('physical AI', { exact: false }).first().waitFor();
  // Taller, and scrolled to the top, so the question shows above the answer.
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByText('I think AI is leaving the data centre', { exact: false }).first().scrollIntoViewIfNeeded();
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = 0; });
  await page.mouse.move(1430, 1070);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, 'take-chat.png') });
  console.log(`Saved take-chat.png and take.png to ${out}/`);
} finally {
  await closeDesktop(app).catch(() => app.close());
  await stopHost(profile).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
