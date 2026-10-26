// Opt-in public-feed proof. No profile, credentials, private APIs or database access.
// node --expose-gc scripts/check-coinbase-stream.mjs --live
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
if (!process.argv.includes('--live')) throw Error('Public network check requires --live');
await mkdir('.local', { recursive: true });
const temporary = await mkdtemp(resolve('.local/coinbase-proof-'));
try {
  await build({ stdin: { contents: "export { openCoinbaseStreamSession } from './src/main/data-sources/coinbase-stream/session'; export { createCoinbasePublicTransport } from './src/main/data-sources/coinbase-stream/transport';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: join(temporary, 'proof.mjs') });
  const { openCoinbaseStreamSession, createCoinbasePublicTransport } = await import(pathToFileURL(join(temporary, 'proof.mjs')).href);
  const pricesOnly=process.argv.includes('--prices-only');
  const products = pricesOnly?['BTC-USD','ETH-USD','SOL-USD','DOGE-USD','ADA-USD','XRP-USD','LTC-USD','AVAX-USD']:['BTC-USD', 'ETH-USD', 'ZEC-USD'];
  const reports = [];
  for (let epoch = 0; epoch < 2; epoch++) {
    global.gc?.();
    const baseline = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
    const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
    const report = { epoch: epoch + 1, products, authenticationSent: false, frames: 0, bytes: 0, maxFrameBytes: 0, channels: {}, snapshotLevels: {}, sequenceDiscontinuities: 0, firstSequence: null, lastSequence: null, viewPublications: 0, ready: false, failure: null, peakHeapBytes: baseline.heapUsed, peakRssBytes: baseline.rss };
    let session, end;
    const complete = new Promise(resolve => { end = resolve; });
    const transport = createCoinbasePublicTransport();
    const observed = { connect(request, callbacks) { return transport.connect(request, { ...callbacks, message(text) {
      report.frames++; const bytes = Buffer.byteLength(text); report.bytes += bytes; report.maxFrameBytes = Math.max(report.maxFrameBytes, bytes);
      const message = JSON.parse(text); report.channels[message.channel] = (report.channels[message.channel] ?? 0) + 1;
      if (report.lastSequence !== null && message.sequence_num !== report.lastSequence + 1) report.sequenceDiscontinuities++;
      report.firstSequence ??= message.sequence_num; report.lastSequence = message.sequence_num;
      for (const event of message.events ?? []) if (message.channel === 'l2_data' && event.type === 'snapshot') report.snapshotLevels[event.product_id] = event.updates.length;
      callbacks.message(text);
    } }); } };
    const sample = setInterval(() => { const usage = process.memoryUsage(); report.peakHeapBytes = Math.max(report.peakHeapBytes, usage.heapUsed); report.peakRssBytes = Math.max(report.peakRssBytes, usage.rss); report.ready ||= session?.status() === 'ready'; }, 100);
    const deadline = setTimeout(end, 45_000);
    session = openCoinbaseStreamSession({ products, ...(pricesOnly?{bookProducts:[]}:{}), transport: observed, signal: new AbortController().signal,
      onChange() { report.viewPublications++; report.ready ||= session?.status() === 'ready'; },
      onFailure(issue) { report.failure = issue; end(); },
    });
    await complete;
    clearInterval(sample); clearTimeout(deadline);
    report.finalStatus = session.status(); report.bookProducts = products.filter(id => session.book(id) !== null);
    session.close(); lag.disable();
    report.elapsedMs = Math.round(performance.now() - started);
    const used = process.cpuUsage(cpu); report.cpuMs = Math.round((used.user + used.system) / 1000);
    report.eventLoopP99Ms = Math.round(lag.percentile(99) / 1e6);
    report.heapBaselineBytes = baseline.heapUsed; global.gc?.(); report.heapAfterCloseBytes = process.memoryUsage().heapUsed;
    reports.push(report); console.log(JSON.stringify(report));
    if (report.failure) break;
  }
  if (reports.length !== 2 || reports.some(report => report.failure || !report.ready || report.sequenceDiscontinuities || report.bookProducts.length !== (pricesOnly?0:products.length))) process.exitCode = 1;
} finally { await rm(temporary, { recursive: true }); }
