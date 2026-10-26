import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnections } from '../../src/main/connections';
import { createDatabaseLifecycle } from '../../src/main/database';
import type { SecretStore } from '../../src/main/secret-store';
import { ConnectionFailure } from '../../src/main/connection-errors';

test('connect, select, restart, refresh, missing secrets, and local disconnect', async () => {
  const path = await mkdtemp(join(tmpdir(), 'earlybird-connections-'));
  let db = createDatabaseLifecycle(join(path, 'database'));
  const values = new Map<string, string>();
  let failure: 'transient' | 'reauth_required' | undefined;
  const secrets: SecretStore = { available: () => true, get: async ref => values.get(ref) ?? null,
    set: async (ref, value) => { values.set(ref, value); }, has: async ref => values.has(ref), delete: async ref => { values.delete(ref); } };
  const factory = async (_secrets: SecretStore, ref: string) => ({
    authorize: async () => { await secrets.set(ref, 'synthetic-access-token'); },
    accounts: async () => {
      if (failure) throw new ConnectionFailure(failure);
      return [{ optionLevel:'option_level_2', externalRef: 'one', maskedNumber: '••••1111', nickname: null, accountType: 'cash', agenticAllowed: true },
        { externalRef: 'two', maskedNumber: '••••2222', nickname: null, accountType: 'cash', agenticAllowed: true }];
    },
  });
  let service = createConnections(db, secrets, async () => {}, factory);
  try {
    await db.start();
    expect((await service.status()).status).toBe('disconnected');
    const connected = await service.connect();
    expect(connected.status).toBe('connected');
    expect(connected.accounts.find(a=>a.maskedNumber==='••••1111')?.optionLevel).toBe('option_level_2');
    const originalCredentials = new Map(values);
    failure = 'transient';
    await expect(service.connect()).rejects.toThrow('transient');
    expect((await service.status()).status).toBe('connected');
    expect(values).toEqual(originalCredentials);
    failure = undefined;
    expect(connected.accounts.every(account => !account.selected)).toBe(true);
    const id = connected.accounts[1].id;
    expect((await service.selectAccount(id)).accounts.find(account => account.id === id)?.selected).toBe(true);
    await expect(service.selectAccount('11111111-1111-1111-1111-111111111111')).rejects.toThrow('unavailable');
    const stored = await db.use(async database => (await database.query('SELECT * FROM platform_connections')).rows);
    expect(JSON.stringify(stored)).not.toContain('synthetic-access-token');
    await service.close(); await db.close();
    db = createDatabaseLifecycle(join(path, 'database')); await db.start();
    service = createConnections(db, secrets, async () => {}, factory);
    expect((await service.status()).status).toBe('connected');
    expect((await service.refresh()).accounts.find(account => account.id === id)?.selected).toBe(true);
    failure = 'transient';
    await expect(service.refresh()).rejects.toThrow('transient');
    expect((await service.status()).status).toBe('connected');
    expect(values.size).toBe(1);
    failure = 'reauth_required';
    await expect(service.refresh()).rejects.toThrow('reauth_required');
    expect((await service.status()).status).toBe('reauth_required');
    expect((await db.use(database => database.query('SELECT maintenance_enabled FROM platform_connections'))).rows).toEqual([{ maintenance_enabled: false }]);
    failure = undefined;
    values.clear();
    expect((await service.status()).status).toBe('reauth_required');
    await service.connect();
    expect(values.size).toBe(1);
    expect((await service.disconnect()).status).toBe('disconnected');
    expect(values.size).toBe(0);
    expect((await service.status()).accounts).toEqual([]);
  } finally { await service.close(); await db.close(); await rm(path, { recursive: true, force: true }); }
});

test('in-flight sign-in reopens the same URL and is cancelled before shutdown', async () => {
  const path = await mkdtemp(join(tmpdir(), 'earlybird-connect-cancel-'));
  const db = createDatabaseLifecycle(join(path, 'database'));
  const secrets: SecretStore = { available: () => true, get: async () => null, set: async () => {}, has: async () => false, delete: async () => {} };
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const opened: string[] = [];
  const service = createConnections(db, secrets, async url => { opened.push(url); }, async () => ({
    authorize: async (signal, openBrowser) => {
      await openBrowser('https://robinhood.com/synthetic-authorization');
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); started();
      });
    }, accounts: async () => [],
  }));
  try {
    await db.start();
    await expect(service.reopenSignIn()).rejects.toThrow('No pending sign-in');
    const connecting = service.connect();
    const rejection = expect(connecting).rejects.toThrow('cancelled');
    await ready;
    await service.reopenSignIn();
    expect(opened).toEqual(['https://robinhood.com/synthetic-authorization', 'https://robinhood.com/synthetic-authorization']);
    await expect(service.connect()).rejects.toThrow('busy');
    await service.close(); await rejection;
    await expect(service.reopenSignIn()).rejects.toThrow('No pending sign-in');
    expect((await service.status()).status).toBe('disconnected');
  } finally { await service.close(); await db.close(); await rm(path, { recursive: true, force: true }); }
});

test('crypto schema inspection requires a connection and does not discover accounts', async () => {
  const path = await mkdtemp(join(tmpdir(), 'earlybird-schema-probe-'));
  const db = createDatabaseLifecycle(join(path, 'database'));
  const values = new Map<string, string>();
  const secrets: SecretStore = { available: () => true, get: async ref => values.get(ref) ?? null,
    set: async (ref, value) => { values.set(ref, value); }, has: async ref => values.has(ref), delete: async ref => { values.delete(ref); } };
  let accountCalls = 0;
  let schemaCalls = 0;
  const definitions = [{ name: 'get_currency_pairs', inputSchema: { type: 'object' } }];
  const service = createConnections(db, secrets, async () => {}, async (_store, ref) => ({
    authorize: async () => { await secrets.set(ref, 'synthetic'); },
    accounts: async () => { accountCalls++; return []; },
    cryptoToolSchemas: async () => { schemaCalls++; return definitions; },
  }));
  try {
    await db.start();
    await expect(service.cryptoToolSchemas()).rejects.toThrow('reauth_required');
    expect(schemaCalls).toBe(0);
    await service.connect();
    expect(accountCalls).toBe(1);
    expect(await service.cryptoToolSchemas()).toEqual(definitions);
    expect(accountCalls).toBe(1);
    expect(schemaCalls).toBe(1);
  } finally { await service.close(); await db.close(); await rm(path, { recursive: true, force: true }); }
});

test('crypto session stays bound to selected account and holds the venue queue until its callback settles',async()=>{
 const path=await mkdtemp(join(tmpdir(),'opentake-crypto-queue-')),db=createDatabaseLifecycle(join(path,'database'));
 const secrets:SecretStore={available:()=>true,get:async()=>null,set:async()=>{},has:async()=>true,delete:async()=>{}};
 let calls=0,release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
 const service=createConnections(db,secrets,async()=>{},async()=>({
  authorize:async()=>{},accounts:async()=>[{externalRef:'synthetic-ref',maskedNumber:'fake',nickname:null,accountType:'cash',agenticAllowed:true}],
  cryptoSession:async(externalRef,accountId,signal,work)=>{calls++;expect(externalRef).toBe('synthetic-ref');expect(signal.aborted).toBe(false);return work({} as any);},
 }));
 try{
  await db.start();const account=(await service.connect()).accounts[0];
  const first=service.cryptoSession(account.id,async()=>{started();await gate;return 'first';});await ready;
  const second=service.cryptoSession(account.id,async()=> 'second');expect(calls).toBe(1);release();
  expect(await first).toBe('first');expect(await second).toBe('second');expect(calls).toBe(2);
  await db.use(d=>d.query('UPDATE linked_accounts SET selected=false WHERE id=$1',[account.id]));
  await expect(service.cryptoSession(account.id,async()=> 'never')).rejects.toThrow('original agentic account');expect(calls).toBe(2);
 }finally{release?.();await service.close();await db.close();await rm(path,{recursive:true,force:true});}
});
