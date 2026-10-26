import contracts from '../../src/main/coinbase/read-contracts.json';
import { expect, test } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { createCoinbaseSessionFactory } from '../../src/main/coinbase/client';
const synthetic = () => ({ name: 'organizations/synthetic/apiKeys/test', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey });

test('pinned Coinbase package initializes and discovers required reads without any account call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coinbase-package-test-'));
  try {
    const controller = new AbortController();
    const session = await createCoinbaseSessionFactory(root)(synthetic(), controller.signal);
    await session.close();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stdio boundary restricts tools, parses reads, sanitizes provider errors and cleans isolated home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coinbase-transport-test-'));
  const fixture = join(root, 'fixture.mjs'); const sessions = join(root, 'sessions');
  await writeFile(fixture, `import {createInterface} from 'node:readline';
const contracts=${JSON.stringify(contracts)};
const tools=['coinbase_api_key_permissions','coinbase_portfolios_list',...Object.keys(contracts)].map(name=>({name,annotations:{readOnlyHint:true},inputSchema:contracts[name]?.inputSchema??{type:'object',properties:{}}}));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
let result={};if(m.method==='initialize')result={protocolVersion:'2024-11-05',serverInfo:{name:'fixture',version:'0.0.10'},capabilities:{tools:{}}};
if(m.method==='tools/list')result={tools};
if(m.method==='tools/call'){
if(m.params.name==='coinbase_portfolios_get')result={isError:true,content:[{type:'text',text:'HTTP 403: '+process.env.COINBASE_KEY_SECRET}]};
else result={content:[{type:'text',text:JSON.stringify({isolated:process.env.HOME===process.env.COINBASE_CONFIG_DIR,credentialPresent:!!process.env.COINBASE_KEY_SECRET,env:process.env.COINBASE_ENV})}]};
}console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
  try {
    const controller = new AbortController();
    const session = await createCoinbaseSessionFactory(sessions, process.execPath, fixture)(synthetic(), controller.signal);
    expect(await session.read('coinbase_api_key_permissions', {}, controller.signal)).toEqual({ isolated: true, credentialPresent: true, env: 'live' });
    await expect(session.read('coinbase_orders_create' as never, {}, controller.signal)).rejects.toMatchObject({ code: 'contract' });
    await expect(session.read('coinbase_portfolios_get', { portfolio_id: 'synthetic' }, controller.signal)).rejects.toMatchObject({ code: 'authentication', message: 'Coinbase rejected this key or its access. Replace the key after checking permissions.' });
    controller.abort(); await session.close(); expect(await readdir(sessions)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
