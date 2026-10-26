import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import { WorkerDatabase, backgroundDatabaseWork } from '../../src/main/database-client';

test('worker preserves query values, transactions and rollback isolation', async () => {
  const db = new WorkerDatabase();
  try {
    await db.waitReady;
    await db.exec('CREATE TABLE probe(id integer PRIMARY KEY, value text)');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const transaction = db.transaction(async tx => {
      await tx.query('INSERT INTO probe VALUES (1,$1)', ['synthetic']);
      entered(); await gate;
      throw new Error('rollback fixture');
    });
    const failed = expect(transaction).rejects.toThrow('rollback fixture');
    await started;
    const outside = db.query('SELECT * FROM probe');
    release(); await failed;
    expect((await outside).rows).toEqual([]);
    await db.transaction(async tx => { await tx.sql`INSERT INTO probe VALUES (${2}, ${'saved'})`; });
    expect((await db.query('SELECT * FROM probe')).rows).toEqual([{id:2,value:'saved'}]);
    await expect(db.query('INSERT INTO probe VALUES (2,$1)', ['private-fixture'])).rejects.toMatchObject({code:'23505',message:'Database operation failed.'});
    const values = await db.query<{at:Date;bytes:Uint8Array}>('SELECT $1::timestamptz AS at, $2::bytea AS bytes',[new Date('2026-01-01T00:00:00Z'),new Uint8Array([1,2,3])]);
    expect(values.rows[0].at).toBeInstanceOf(Date);
    expect([...values.rows[0].bytes]).toEqual([1,2,3]);
  } finally { await db.close(); }
});

test('foreground reads precede queued background work without interrupting a transaction', async () => {
  const db = new WorkerDatabase();
  try {
    await db.waitReady;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const active = db.transaction(async () => { entered(); await gate; });
    await started;
    const order: string[] = [];
    const background = backgroundDatabaseWork(() => db.query('SELECT 1')).then(() => order.push('background'));
    const foreground = db.query('SELECT 2').then(() => order.push('foreground'));
    release(); await Promise.all([active,background,foreground]);
    expect(order).toEqual(['foreground','background']);
  } finally { await db.close(); }
});

test('long database work leaves host timers responsive', async () => {
  const db = new WorkerDatabase();
  try {
    await db.waitReady;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try { await db.query('SELECT pg_sleep(0.3)'); } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(5);
  } finally { await db.close(); }
});

test('close drains accepted background writes and rejects later submissions', async () => {
  const db = new WorkerDatabase();
  await db.waitReady;
  await db.exec('CREATE TABLE probe(value integer)');
  const writes = Array.from({length:8},(_,i) => backgroundDatabaseWork(() => db.query('INSERT INTO probe VALUES ($1)',[i])));
  const snapshot = backgroundDatabaseWork(() => db.dumpDataDir('gzip'));
  const closing = db.close();
  await expect(db.query('SELECT 1')).rejects.toThrow('closing');
  await Promise.all(writes); const blob = await snapshot; await closing;
  const restored = new WorkerDatabase(undefined,{loadDataDir:blob});
  try { expect((await restored.query<{count:number}>('SELECT count(*)::int AS count FROM probe')).rows[0].count).toBe(8); }
  finally { await restored.close(); }
});

test('worker failure rejects active and queued requests without replay', async () => {
  const db = new WorkerDatabase();
  await db.waitReady;
  const active = expect(db.query('SELECT pg_sleep(10)')).rejects.toThrow('worker unavailable');
  const queued = expect(db.query('SELECT 1')).rejects.toThrow('worker unavailable');
  await delay(20);
  await (db as unknown as {worker:Worker}).worker.terminate();
  await Promise.all([active,queued]);
  await expect(db.query('SELECT 1')).rejects.toThrow('worker unavailable');
  await db.close().catch(() => {});
});


test('worker crash preserves committed data and rolls back the unfinished transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-worker-crash-'));
  const db = new WorkerDatabase(join(root, 'database'));
  let reopened: WorkerDatabase | undefined;
  try {
    await db.exec("CREATE TABLE probe(value text); INSERT INTO probe VALUES ('committed')");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const transaction = db.transaction(async tx => {
      await tx.query("INSERT INTO probe VALUES ('uncommitted')");
      entered(); await gate;
    });
    const failed = expect(transaction).rejects.toThrow('worker unavailable');
    await started;
    await (db as unknown as {worker:Worker}).worker.terminate();
    release(); await failed;
    reopened = new WorkerDatabase(join(root, 'database'));
    expect((await reopened.query('SELECT * FROM probe')).rows).toEqual([{value:'committed'}]);
  } finally { await db.close().catch(() => {}); await reopened?.close(); await rm(root,{recursive:true,force:true}); }
});

test('a full queue applies backpressure but still drains safely on close', async () => {
  const db = new WorkerDatabase();
  await db.waitReady;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const active = db.transaction(async () => { entered(); await gate; });
  await started;
  const reads = Array.from({length:1024}, () => backgroundDatabaseWork(() => db.query('SELECT 1')));
  await expect(db.query('SELECT 2')).rejects.toThrow('Database busy');
  const closing = db.close();
  release();
  await Promise.all([active,...reads]);
  await closing;
  expect(db.closed).toBe(true);
});
