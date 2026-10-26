import { expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabaseLifecycle } from '../../src/main/database';
import { createMaintenance } from '../../src/main/maintenance';
import { ConnectionFailure } from '../../src/main/connection-errors';
import { prepareRestoredDatabase } from '../../src/main/migrations';

test('externally polled maintenance deduplicates requests, retries transient failures, pauses, and stops on revoked grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-maintenance-'));
  const db = createDatabaseLifecycle(join(root, 'database'));
  let clock = Date.now() + 1000;
  let failure: 'transient' | 'reauth_required' | undefined = 'transient';
  let calls = 0;
  const maintenance = createMaintenance(db, {
    busy: () => false, cancel: () => {}, refresh: async () => {
      calls++;
      if (failure) throw new ConnectionFailure(failure);
      await db.use(database => database.exec('UPDATE platform_connections SET checked_at = now()'));
      return { status: 'connected', checkedAt: null, accounts: [] };
    },
  }, () => false, () => clock, () => 0.5, undefined, { externalPolling: true });
  try {
    await db.start(); clock = Date.now() + 1000;
    await db.use(database => database.exec(`INSERT INTO platform_connections(owner_id, venue, status, credential_ref, maintenance_enabled)
      SELECT id, 'robinhood', 'connected', 'synthetic-reference', true FROM local_owners`));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try { await maintenance.start(); expect(timers.mock.calls.some(call => call[1] === 5000)).toBe(false); } finally { timers.mockRestore(); }
    await Promise.all([maintenance.request(), maintenance.request()]);
    expect(await maintenance.list()).toHaveLength(1);
    // SQL initializes next_run_at from its real clock. Slow disk setup can
    // outrun the injected clock, so advance to the persisted due time.
    clock = Math.max(clock, Date.parse((await maintenance.list())[0].nextRunAt) + 1);
    await maintenance.tick();
    expect((await maintenance.list())[0]).toMatchObject({ kind: 'account_sync', state: 'retrying', attempts: 1, errorCode: 'transient' });
    await maintenance.tick(); expect(calls).toBe(1);
    maintenance.suspend(); clock += 10_000;
    await maintenance.tick(); expect(calls).toBe(1);
    failure = undefined; await maintenance.wake();
    expect((await maintenance.list())[0]).toMatchObject({ state: 'completed', attempts: 2 });
    await maintenance.request(); failure = 'reauth_required'; await maintenance.tick();
    expect((await maintenance.list())[0]).toMatchObject({ state: 'needs_attention', errorCode: 'reauth_required' });
    clock += 600_000;
    await maintenance.tick(); expect(calls).toBe(3);
    await db.use(prepareRestoredDatabase);
    expect((await maintenance.list()).some(job => job.state === 'needs_attention')).toBe(false);
    await maintenance.wake(); expect(calls).toBe(3);
  } finally { await maintenance.stop(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('interrupted read jobs resume once, then retry exhaustion requires user action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-maintenance-restart-'));
  const db = createDatabaseLifecycle(join(root, 'database'));
  let clock = Date.now() + 1000;
  let calls = 0;
  const maintenance = createMaintenance(db, { busy: () => false, cancel: () => {}, refresh: async () => { calls++; throw new ConnectionFailure('transient'); } }, () => false, () => clock, () => 0.5);
  try {
    await db.start(); clock = Date.now() + 1000;
    await db.use(database => database.exec(`INSERT INTO platform_connections(owner_id, venue, credential_ref, maintenance_enabled)
      SELECT id, 'robinhood', 'synthetic', true FROM local_owners;
      INSERT INTO background_jobs(connection_id, kind, state, reason) SELECT id, 'account_sync', 'running', 'manual' FROM platform_connections;`));
    await maintenance.start(); expect((await maintenance.list())[0].state).toBe('pending');
    clock = Math.max(clock, Date.parse((await maintenance.list())[0].nextRunAt) + 1);
    for (let attempt = 0; attempt < 5; attempt++) { await maintenance.tick(); clock += 600_000; }
    const job = (await maintenance.list())[0];
    expect(job).toMatchObject({ state: 'failed', attempts: 5 });
    await maintenance.tick(); expect(calls).toBe(5);
    await maintenance.retry(job.id); await maintenance.tick();
    expect(calls).toBe(6); expect((await maintenance.list())[0].attempts).toBe(1);
  } finally { await maintenance.stop(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('account collection policy pauses queued portfolio work without stopping connection maintenance',async()=>{
 const root=await mkdtemp(join(tmpdir(),'earlybird-maintenance-policy-')),db=createDatabaseLifecycle(join(root,'database'));
 let allowed=false,clock=Date.now()+10000;
 const refresh=vi.fn(async()=>({status:'connected',checkedAt:null,accounts:[]})),synchronize=vi.fn(async()=>{});
 const maintenance=createMaintenance(db,{refresh,busy:()=>false,cancel(){}} as never,()=>false,()=>clock,()=>.5,{synchronize,start:async()=>{},cancel(){},engaged:()=>false},{externalPolling:true,portfolioBackgroundAllowed:async()=>allowed});
 try{
  await db.start();
  await db.use(database=>database.exec(`INSERT INTO platform_connections(owner_id,venue,status,credential_ref,maintenance_enabled) SELECT id,'robinhood','connected','synthetic',true FROM local_owners;
   INSERT INTO background_jobs(connection_id,kind,state,reason,next_run_at) SELECT id,'portfolio_sync','pending','scheduled',now()-interval '1 minute' FROM platform_connections;`));
  await maintenance.start();clock=Date.now()+10000;await maintenance.tick();
  expect(synchronize).not.toHaveBeenCalled();expect(refresh).toHaveBeenCalledTimes(1);
  allowed=true;clock+=10000;await maintenance.tick();expect(synchronize).toHaveBeenCalledTimes(1);
 }finally{await maintenance.stop();await db.close();await rm(root,{recursive:true,force:true});}
});
