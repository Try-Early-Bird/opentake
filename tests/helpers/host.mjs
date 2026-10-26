import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Disposable test profiles only. Never call this with a real application profile.
export async function hostRequest(profile, method, args = []) {
  const host = JSON.parse(await readFile(join(profile, 'host.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${host.port}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ method, args, clientId: '11111111-1111-4111-8111-111111111111' }), signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!body.ok) throw new Error('Synthetic host request failed');
  return body.value;
}
export async function stopHost(profile) {
  let host;
  try { host = JSON.parse(await readFile(join(profile, 'host.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!Number.isSafeInteger(host.pid) || host.pid <= 0) throw new Error('Invalid disposable host PID');
  try { await hostRequest(profile, 'host:shutdown'); }
  catch { /* The RPC can close before its shutdown response arrives. Wait for exit. */ }
  for (let attempt = 0; attempt < 120; attempt++) {
    let unpublished = false;
    try { await readFile(join(profile, 'host.json')); }
    catch (error) { if (error.code === 'ENOENT') unpublished = true; else throw error; }
    // Unpublishing precedes Electron's exit. Chromium can still write session
    // files in that interval, so the manifest alone is not a cleanup barrier.
    if (unpublished) {
      try { process.kill(host.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
    }
    await delay(100);
  }
  throw new Error('Test host did not stop; profile retained for safe cleanup');
}
