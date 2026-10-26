// Pagination/seen contract cases and notification assertions against local storage.
import { beforeAll, beforeEach, afterAll, expect, test, vi } from 'vitest';
import * as actionNotifications from '../../src/main/action-notifications';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, prepareRestoredDatabase } from '../../src/main/migrations';
import { createNotifications, type NativeAlert } from '../../src/main/notifications';
import type { NotificationInput } from '../../src/shared/notifications';

const db = new PGlite();
let time = Date.now();
let alerts: NativeAlert[] = [];
let opened = 0;
let badge = 0;
const database = { use: <T>(f: (d: PGlite) => Promise<T>) => f(db) };
const makeService = () => createNotifications(database, { now: () => time, deliver: a => alerts.push(a), openDesktop: () => { opened++; }, badge: n => { badge = n; } });
let service = makeService();
const fixture = (extra: Partial<NotificationInput> = {}): NotificationInput => ({
  kind: 'connection_attention', tier: 'act_now', requiresAction: true,
  eventKey: randomUUID(), occurredAt: new Date(time).toISOString(),
  context: { venue: 'fixture', connectionId: randomUUID() },
  source: { type: 'connection', id: randomUUID() }, title: 'Sign-in needed', body: 'Open Connections.', ...extra,
});
beforeAll(async () => { await migrate(db); });
beforeEach(async () => {
  await service.stop();
  await db.exec("DELETE FROM takes; DELETE FROM platform_connections; TRUNCATE notifications RESTART IDENTITY; UPDATE notification_delivery SET throttle_until='-infinity',recovery_until='-infinity',urgent_used=false,recovery_sent=false,navigation=NULL");
  time = Date.now(); alerts = []; opened = 0; badge = 0; service = makeService();
});
afterAll(async () => { await service.stop(); await db.close(); });

test('slow reconciliation waits a full cooldown after completion', async () => {
  const reconciliation = vi.spyOn(actionNotifications, 'syncActionNotifications').mockImplementation(async () => { time += 6000; });
  try {
    await service.tick();
    expect(reconciliation).toHaveBeenCalledTimes(1);
    await service.tick();
    time += 23999;
    await service.tick();
    expect(reconciliation).toHaveBeenCalledTimes(1);
    time += 1;
    await service.tick();
    expect(reconciliation).toHaveBeenCalledTimes(2);
  } finally { reconciliation.mockRestore(); }
});

test('recovery and polling share an in-flight reconciliation', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reconciliation = vi.spyOn(actionNotifications, 'syncActionNotifications').mockImplementation(async () => { entered(); await gate; });
  try {
    const tick = service.tick();
    await started;
    const recovery = service.recover();
    release();
    await Promise.all([tick, recovery]);
    expect(reconciliation).toHaveBeenCalledTimes(1);
  } finally { release(); reconciliation.mockRestore(); }
});

test('failed reconciliation backs off and eventually retries', async () => {
  const reconciliation = vi.spyOn(actionNotifications, 'syncActionNotifications').mockImplementation(async () => { time += 6000; throw new Error('Synthetic failure'); });
  try {
    await service.tick();
    time += 23999;
    await service.tick();
    expect(reconciliation).toHaveBeenCalledTimes(1);
    time += 1;
    await service.tick();
    expect(reconciliation).toHaveBeenCalledTimes(2);
  } finally { reconciliation.mockRestore(); }
});

async function approval(type: 'tool' | 'platform' = 'tool', runId?: string) {
  const take = randomUUID(), run = runId ?? randomUUID(), id = randomUUID();
  if (!runId) {
    await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Synthetic take','{}' FROM local_owners", [take]);
    await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')", [run,take,randomUUID()]);
  }
  if (type === 'tool') await db.query("INSERT INTO tool_approvals(id,run_id,server_id,tool_name,input,fingerprint,expires_at) VALUES($1,$2,'fixture','fixture','{\"secret\":\"must-not-copy\"}','fixture',$3)", [id, run, new Date(time + 120000).toISOString()]);
  else await db.query("INSERT INTO platform_access_requests(id,run_id,take_id,provider,scope,revision,state,expires_at) SELECT $1,id,take_id,'fixture','fixture',1,'pending',$3 FROM take_runs WHERE id=$2", [id, run, new Date(time + 120000).toISOString()]);
  return { id, run, take, table: type === 'tool' ? 'tool_approvals' : 'platform_access_requests' };
}

test('record is idempotent, resolution uses full venue/account identity, seen is independent of action', async () => {
  const input = fixture();
  const first = await service.record(input);
  expect(await service.record(input)).toEqual(first);
  const other = { ...input, context: { venue: 'other', connectionId: randomUUID() } };
  await service.record(other);
  const page = await service.list();
  await service.markSeen(page.throughSequence);
  expect(await service.list()).toMatchObject({ unreadCount: 0, actionRequiredCount: 2 });
  await service.resolve(input);
  expect(await service.list()).toMatchObject({ actionRequiredCount: 1 });
  expect((await service.list()).items.find(n => n.id === first.id)?.resolvedAt).not.toBeNull();
});

test('pagination and seen watermark preserve later and backdated arrivals; rejects malformed cursors', async () => {
  for (let i = 0; i < 56; i++) await service.record(fixture());
  const page = await service.list();
  expect(page.items).toHaveLength(50);
  const late = await service.record(fixture({ occurredAt: '2000-01-01T00:00:00Z' }));
  await service.markSeen(page.throughSequence);
  const last = await service.list(page.nextCursor);
  expect(last.items).toHaveLength(6);
  expect(last.nextCursor).toBeNull();
  expect(new Set([...page.items, ...last.items].map(n => n.id)).size).toBe(56);
  expect((await service.list()).items.find(n => n.id === late.id)?.seen).toBe(false);
  for (const cursor of ['garbage', '-1', '9223372036854775808', {}, '1.2']) await expect(service.list(cursor)).rejects.toThrow();
});

test('100 recovery events create one summary, with no replay on restart or network flapping', async () => {
  await service.recover();
  for (let i = 0; i < 100; i++) await service.record(fixture(), 'recovery');
  await service.tick(); expect(alerts).toHaveLength(0);
  time += 10001;
  await service.tick(); expect(alerts).toHaveLength(1); expect(alerts[0].title).toContain('100');
  expect(badge).toBe(100);
  alerts[0].click();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(await service.navigation()).toMatchObject({ target: { type: 'attention' } });
  expect(opened).toBe(1);
  const handoff = await service.navigation(); await service.acknowledge(randomUUID()); expect(await service.navigation()).toEqual(handoff);
  await service.acknowledge(handoff!.id); expect(await service.navigation()).toBeNull();
  await service.stop(); service = makeService();
  for (let i = 0; i < 3; i++) { await service.recover(); time += 10001; await service.tick(); }
  expect(alerts).toHaveLength(1);
});

test('resolved, expired and informational recovery backlog produces no alerts', async () => {
  const done = fixture(); await service.record(done, 'recovery'); await service.resolve(done);
  await service.record(fixture({ expiresAt: new Date(time - 1000).toISOString() }), 'recovery');
  await service.record(fixture({ requiresAction: false, tier: 'know_today' }), 'recovery');
  await service.tick(); expect(alerts).toHaveLength(0);
  expect(await service.list()).toMatchObject({ unreadCount: 3, actionRequiredCount: 0 });
  expect(badge).toBe(3); // Suppressing native alerts does not mark bell items read.
});

test('live bursts are bounded and the urgent exception is used only once, including after restart', async () => {
  await service.record(fixture()); await service.tick(); expect(alerts).toHaveLength(1);
  for (let i = 0; i < 10; i++) await service.record(fixture());
  await service.tick(); expect(alerts).toHaveLength(1);
  const urgent = await approval();
  await db.query("UPDATE notifications SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb($1::text)),expires_at=$1::timestamptz WHERE payload->'source'->>'id'=$2", [new Date(time+30000).toISOString(),urgent.id]);
  await service.tick(); expect(alerts).toHaveLength(2);
  await service.stop(); service = makeService();
  const nextUrgent = await approval();
  await db.query("UPDATE notifications SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb($1::text)),expires_at=$1::timestamptz WHERE payload->'source'->>'id'=$2", [new Date(time+30000).toISOString(),nextUrgent.id]);
  await service.tick(); expect(alerts).toHaveLength(2);
  time += 61000; await service.tick(); expect(alerts).toHaveLength(2);
});

test('foreground suppression survives focus changes; stale presence permits new delivery; failures do not loop', async () => {
  service.presence('desktop', true);
  await service.record(fixture()); await service.tick(); expect(alerts).toHaveLength(0);
  time += 7000; await service.tick(); expect(alerts).toHaveLength(0);
  const failed = await service.record(fixture()); await service.tick(); expect(alerts).toHaveLength(1);
  alerts[0].failed(); await new Promise(resolve => setTimeout(resolve, 20));
  expect((await db.query('SELECT delivery FROM notifications WHERE id=$1', [failed.id])).rows).toEqual([{ delivery: 'failed' }]);
  time += 61000; await service.tick(); expect(alerts).toHaveLength(1);
});

test('connection transitions create one episode, recover it, and support a new episode without credentials', async () => {
  const id = randomUUID();
  await db.query("INSERT INTO platform_connections(id,owner_id,venue,status,maintenance_enabled) SELECT $1,id,'fixture','connected',true FROM local_owners", [id]);
  await db.query("UPDATE platform_connections SET status='reauth_required',maintenance_enabled=false WHERE id=$1", [id]);
  await db.query("UPDATE platform_connections SET status='reauth_required',maintenance_enabled=false WHERE id=$1", [id]);
  const page = await service.list(); expect(page.items).toHaveLength(1);
  expect(await service.target(page.items[0].id)).toEqual({ type: 'connection', connectionId: id, venue: 'fixture' });
  await db.query("UPDATE platform_connections SET status='connected' WHERE id=$1", [id]);
  expect((await service.list()).actionRequiredCount).toBe(0);
  await db.query("UPDATE platform_connections SET status='reauth_required',maintenance_enabled=false WHERE id=$1", [id]);
  expect((await service.list()).items).toHaveLength(2);
  await db.query('DELETE FROM platform_connections WHERE id=$1', [id]);
  expect((await service.list()).actionRequiredCount).toBe(0);
  expect(await service.target(page.items[0].id)).toEqual({ type: 'attention' });
});

for (const type of ['tool', 'platform'] as const) {
  test(`${type} approvals resolve on decision, expiry, stop and deletion, with distinct requests per run`, async () => {
    const first = await approval(type);
    const second = await approval(type, first.run);
    let page = await service.list(); expect(page.actionRequiredCount).toBe(2);
    expect(JSON.stringify(page)).not.toContain('must-not-copy');
    expect(await service.target(page.items[1].id)).toEqual({ type: 'take', takeId: first.take });
    await db.query(`UPDATE ${first.table} SET state='approved' WHERE id=$1`, [first.id]);
    expect((await service.list()).actionRequiredCount).toBe(1);
    await db.query(`UPDATE ${second.table} SET state='declined' WHERE id=$1`, [second.id]);
    expect((await service.list()).actionRequiredCount).toBe(0);
    await approval(type, first.run);
    await db.query("UPDATE take_runs SET state='stopping' WHERE id=$1", [first.run]);
    await service.tick(); expect((await service.list()).actionRequiredCount).toBe(0);
    const expiring = await approval(type); time += 121000; await service.tick();
    expect((await service.list()).actionRequiredCount).toBe(0);
    await db.query('DELETE FROM takes WHERE id=$1', [expiring.take]);
    page = await service.list(); expect(await service.target(page.items[0].id)).toEqual({ type: 'attention' });
  });
}

test('rollback creates no phantom alert, retention keeps dedup tombstones, and restore suppresses old delivery', async () => {
  const id = randomUUID();
  await expect(db.transaction(async tx => {
    await tx.query("INSERT INTO platform_connections(id,owner_id,venue,status,maintenance_enabled) SELECT $1,id,'fixture','reauth_required',true FROM local_owners", [id]);
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect((await service.list()).items).toHaveLength(0);
  const old = fixture({ requiresAction: false }); await service.record(old);
  await db.exec("UPDATE notifications SET created_at=now()-interval '31 days'");
  await service.tick(); expect((await service.list()).items).toHaveLength(0); expect(alerts).toHaveLength(0);
  await service.record(old); expect((await service.list()).items).toHaveLength(0);
  await service.record(fixture()); await prepareRestoredDatabase(db); await service.tick();
  expect((await service.list()).actionRequiredCount).toBe(0);
  expect((await db.query("SELECT id FROM notifications WHERE delivery='pending'")).rows).toHaveLength(0);
});


test('late catch-up results do not create trailing banners, while fresh events remain eligible', async () => {
  await service.recover();
  time += 10001; await service.tick();
  await service.record(fixture(), 'recovery'); time += 61000; await service.tick();
  expect(alerts).toHaveLength(0);
  await service.record(fixture()); await service.tick(); expect(alerts).toHaveLength(1);
});


test('clicking an approval opens its original take without deciding it; deleted targets fall back to the list', async () => {
  const request = await approval();
  await service.tick(); expect(alerts).toHaveLength(1);
  alerts[0].click(); await new Promise(resolve => setTimeout(resolve,20));
  expect(await service.navigation()).toMatchObject({target:{type:'take',takeId:request.take}});
  expect((await db.query('SELECT state FROM tool_approvals WHERE id=$1',[request.id])).rows).toEqual([{state:'pending'}]);
  await db.query('DELETE FROM takes WHERE id=$1',[request.take]);
  alerts[0].click(); await new Promise(resolve => setTimeout(resolve,20));
  expect(await service.navigation()).toMatchObject({target:{type:'attention'}});
});

test('backfilled action cards sort by action time and paginate without burying a recent mixed withdrawal',async()=>{
 const strategyId=randomUUID();
 const action=(id:string,at:string):NotificationInput=>({kind:'action_update',tier:'know_today',requiresAction:false,eventKey:'action',context:{strategyId},source:{type:'action',id},occurredAt:at,title:'Taking money out',body:'Mixed test',action:{id,kind:'withdrawal',state:'waiting',title:'Taking money out',takeTitle:'Mixed test',filled:0,total:0,orders:[],accounts:[]}});
 const latest=await service.record(action('mixed-withdrawal',new Date(time).toISOString()));
 for(let i=0;i<55;i++)await service.record(action(`old-${i}`,new Date(time-(i+1)*86400000).toISOString()));
 const first=await service.list();expect(first.items[0].id).toBe(latest.id);expect(first.items).toHaveLength(50);
 const second=await service.list(first.nextCursor);expect(second.items).toHaveLength(6);
 expect(new Set([...first.items,...second.items].map(i=>i.id)).size).toBe(56);
 const oldest=second.items.at(-1)!;
 await db.query("UPDATE notifications SET payload=jsonb_set(payload,'{action,updatedAt}',$2::jsonb) WHERE id=$1",[oldest.id,JSON.stringify(new Date(time+1000).toISOString())]);
 expect((await service.list()).items[0].id).toBe(oldest.id);
});

test('Dock badge follows unread count and clears immediately without resolving attention items',async()=>{
 await service.record(fixture());
 await service.record(fixture({kind:'capital_update',requiresAction:false,tier:'know_today'}));
 await service.tick();expect(badge).toBe(2);
 const page=await service.list();await service.markSeen(page.throughSequence);
 expect(badge).toBe(0);expect(await service.list()).toMatchObject({unreadCount:0,actionRequiredCount:1});
 await service.tick();expect(badge).toBe(0);
 await service.record(fixture({requiresAction:false,tier:'know_today'}));
 await service.markSeen(page.throughSequence);expect(badge).toBe(1);
 await service.tick();expect(badge).toBe(1);
});

test('approval alerts name the Take and distinguish platform sharing from tool permission', async () => {
  const item = await approval('platform');
  await db.query("UPDATE takes SET title='Crypto research' WHERE id=$1", [item.take]);
  await db.query("UPDATE platform_access_requests SET provider='claude' WHERE id=$1", [item.id]);
  const notice = (await service.list()).items[0];
  expect(notice.title).toBe('Crypto research needs your approval');
  expect(notice.body).toContain('Allow Claude to use account data');
  expect(notice.body).toContain('separate from Auto');
  await service.tick();
  expect(alerts[0].title).toBe(notice.title);
  expect(alerts[0].body).toContain(notice.body);
});

test('tool approval alerts describe the requested read without copying arguments', async () => {
  const item = await approval();
  await db.query("UPDATE tool_approvals SET tool_name='robinhood_get_crypto_positions',server_name='Opentake platforms' WHERE id=$1", [item.id]);
  const notice = (await service.list()).items[0];
  expect(notice.title).toBe('Synthetic take needs your approval');
  expect(notice.body).toContain('Read Robinhood crypto positions');
  expect(notice.body).toContain('tool or server permission');
  expect(JSON.stringify(notice)).not.toContain('must-not-copy');
  await service.tick();expect(alerts[0].body).toContain(notice.body);
});

 test('rule notifications use the existing inbox, deduplication and Take destination',async()=>{
 const takeId=randomUUID();await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Rule fixture','{}' FROM local_owners",[takeId]);
 const notice=fixture({kind:'rule_notification',tier:'know_today',requiresAction:false,context:{takeId},source:{type:'rule',id:randomUUID()},title:'Price drop',body:'Price crossed below the threshold.'});
 await service.record(notice);await service.record(notice);await service.tick();
 const page=await service.list();expect(page.items).toHaveLength(1);expect(alerts).toHaveLength(1);expect(await service.target(page.items[0].id)).toEqual({type:'take',takeId});
});
