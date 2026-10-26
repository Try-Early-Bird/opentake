// A rule's trade on Robinhood end to end — firing, shared action core, Robinhood
// adapter, shared approvals, the real instructions, planner and executor — against a
// scripted fake broker. Synthetic profile only: no Robinhood connection or credentials.
import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture,OPEN} from './robinhood-rule-fixture';

test('approve on the shared card, place once through the real executor, survive a restart, and finish filled',async()=>{
 const f=await fixture();const id=await f.fire();
 await f.app().tick();expect(await f.job(id)).toMatchObject({state:'waiting',waiting_for:'approval'});
 const waiting=await f.app().approvals.list(f.take);
 expect(waiting).toEqual([expect.objectContaining({requestId:id,venue:'robinhood',kind:'rebalance_to_target',orders:[expect.objectContaining({symbol:'VTI',side:'buy'})]})]);
 expect(f.placed()).toHaveLength(0);
 await f.app().approvals.decide(f.take,id,true);await f.app().tick();
 expect(f.placed()).toEqual([{stage:'place',symbol:'VTI',side:'buy'}].map(c=>expect.objectContaining({symbol:c.symbol,side:c.side})));
 // A crash and a new core: nothing is placed again.
 await f.restart().tick();await f.app().tick();expect(f.placed()).toHaveLength(1);
 await f.fillAll();await f.app().tick();
 expect(await f.job(id)).toMatchObject({state:'succeeded',reason:'filled'});expect(await f.request(id)).toBe('executed');
});

test('a duplicate firing makes no second trade; a manual rebalance while it runs plans nothing; decline sends nothing',async()=>{
 const f=await fixture({approval:'within_existing_policy'});
 const id=await f.fire('same-event');await f.fire('same-event');
 await f.app().tick();expect(f.placed()).toHaveLength(1);
 expect((await f.db.query("SELECT count(*)::int AS n FROM action_jobs")).rows[0]).toEqual({n:1});
 // The member asks for a rebalance while the rule's order is open: the planner waits on it.
 const manual=await f.app().instructions.plan(f.allocation);expect(manual).toMatchObject({disposition:'deferred',reasonCode:'open_execution'});expect(f.placed()).toHaveLength(1);
 await f.fillAll();await f.app().tick();expect(await f.request(id)).toBe('executed');
 const g=await fixture();const declined=await g.fire();await g.app().tick();
 await g.app().approvals.decide(g.take,declined,false);await g.app().tick();
 expect(g.placed()).toHaveLength(0);expect(await g.job(declined)).toMatchObject({state:'cancelled'});expect(await g.request(declined)).toBe('action_blocked');
});

test('approved after hours it waits for the open; a Take changed since the rule was accepted does not trade',async()=>{
 const f=await fixture({closed:true});const id=await f.fire();
 await f.app().tick();
 const before=await f.job(id);
 if(before.waiting_for==='approval'){await f.app().approvals.decide(f.take,id,true);await f.app().tick();}
 expect(f.placed()).toHaveLength(0);expect((await f.job(id)).waiting_for).toBe('market_open');
 // At the open the Robinhood loop places the held orders (as its scheduler does); the approval carries over.
 f.setNow(OPEN+7*86400000);await f.app().executor.executeAllocation(f.allocation);expect(f.placed().length).toBeGreaterThan(0);
 await f.fillAll();await f.app().tick();expect(await f.job(id)).toMatchObject({state:'succeeded'});
 const g=await fixture();const stale=await g.fire();
 const newer=randomUUID();
 await g.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,local_owners.id,2,1,'{}',spec,'{}','{}' FROM strategy_versions,local_owners WHERE strategy_versions.id=$3`,[newer,g.strategy,g.version]);
 await g.db.query('UPDATE strategies SET current_version_id=$2 WHERE id=$1',[g.strategy,newer]);
 await g.app().tick();expect(await g.job(stale)).toMatchObject({state:'blocked',reason:'take_version_changed'});expect(g.placed()).toHaveLength(0);
});

test('deploy cash buys only, spending at most its amount, after approval on the shared card',async()=>{
 const f=await fixture({deployUsd:'30'});
 // Past its first purchase (which buys the whole basket or nothing): later buys fit the cash given.
 await f.db.query('UPDATE strategy_allocations SET applied_version_sequence=1 WHERE id=$1',[f.allocation]);
 const id=await f.fire();
 await f.app().tick();
 const [waiting]=await f.app().approvals.list(f.take);
 expect(waiting).toMatchObject({requestId:id,venue:'robinhood',kind:'deploy_cash',amount:'30'});
 expect(waiting!.orders.every(o=>o.side==='buy')).toBe(true);
 expect(waiting!.orders.reduce((s,o)=>s+Number(o.amountUsd),0)).toBeLessThanOrEqual(30);
 await f.app().approvals.decide(f.take,id,true);await f.app().tick();
 const legs=(await f.db.query<{side:string;planned_notional:string}>('SELECT side,planned_notional::text FROM strategy_executions')).rows;
 expect(legs.length).toBeGreaterThan(0);expect(legs.every(l=>l.side==='buy')).toBe(true);
 const spent=legs.reduce((s,l)=>s+Number(l.planned_notional),0);expect(spent).toBeGreaterThan(0);expect(spent).toBeLessThanOrEqual(30);
 await f.fillAll();await f.app().tick();expect(await f.job(id)).toMatchObject({state:'succeeded',reason:'filled'});
});

test('deploy cash below a first purchase’s whole basket places nothing',async()=>{
 const f=await fixture({deployUsd:'30',approval:'within_existing_policy'});const id=await f.fire();
 await f.app().tick();
 expect(await f.job(id)).toMatchObject({state:'blocked',reason:'insufficient_bucket_cash'});expect(f.placed()).toHaveLength(0);
});
