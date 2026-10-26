import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerDatabase } from '../../src/main/database-client';
import { migrate } from '../../src/main/migrations';
import { measureDatabase } from './measurement';

export const FIXTURE_TIME = Date.parse('2026-10-16T15:00:00Z');
const CREATED = '2026-10-01T15:00:00Z';
export type Venue = 'robinhood' | 'coinbase';
export interface FixtureSize { seed: string; accountsPerVenue: number; allocationsPerAccount: number; historyRows: number }
export const SMOKE_SIZE: FixtureSize = { seed: 'baseline-v1', accountsPerVenue: 1, allocationsPerAccount: 2, historyRows: 96 };

export function fixtureId(seed: string, key: string): string {
  const hex = createHash('sha256').update(`${seed}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** All paths are created here, never accepted from an environment variable/profile. */
export async function createFixture(size: FixtureSize = SMOKE_SIZE) {
  for (const value of [size.accountsPerVenue, size.allocationsPerAccount, size.historyRows]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Fixture sizes must be positive integers');
  }
  const root = await mkdtemp(join(tmpdir(), 'earlybird-performance-'));
  const worker = new WorkerDatabase(join(root, 'database'));
  const measurement = measureDatabase(worker);
  const db = measurement.client;
  const database = { use: <T>(work: (client: typeof db) => Promise<T>) => work(db) };
  const id = (key: string) => fixtureId(size.seed, key);
  const accounts: { id: string; connectionId: string; venue: Venue; balance: string }[] = [];
  const allocations: { id: string; accountId: string; strategyId: string; takeId: string; venue: Venue; headId: string | null }[] = [];
  let now = FIXTURE_TIME;
  let closed = false;
  async function close() {
    if (closed) return;
    await worker.close(); // Never delete a database while its worker is open.
    await rm(root, { recursive: true, force: true });
    closed = true;
  }
  try {
    await worker.waitReady;
    await migrate(db);
    for (const venue of ['robinhood', 'coinbase'] as const) {
      for (let a = 0; a < size.accountsPerVenue; a++) {
        const key = `${venue}:${a}`, accountId = id(`account:${key}`);
        // Robinhood has one connection per owner with multiple linked accounts.
        const connectionId = id(`connection:${venue}:${venue === 'robinhood' ? 0 : a}`);
        const balance = String(size.allocationsPerAccount * 100 + 1000);
        accounts.push({ id: accountId, connectionId, venue, balance });
        if (venue === 'coinbase' || a === 0) await db.query(`INSERT INTO platform_connections(id,owner_id,venue,status,external_account_ref)
          SELECT $1,id,$2,'connected',$3 FROM local_owners`, [connectionId, venue, key]);
        await db.query(`INSERT INTO linked_accounts(id,connection_id,external_ref,masked_number,available,agentic_allowed)
          VALUES($1,$2,$3,'Synthetic',true,true)`, [accountId, connectionId, key]);
        if (venue === 'coinbase') await db.query(`INSERT INTO coinbase_connection_details(connection_id,label,portfolio_name,can_trade)
          VALUES($1,'Synthetic','Synthetic',true)`, [connectionId]);
        for (let n = 0; n < size.allocationsPerAccount; n++) {
          const suffix = `${key}:${n}`, allocationId = id(`allocation:${suffix}`), strategyId = id(`strategy:${suffix}`);
          const takeId = id(`take:${suffix}`), versionId = id(`version:${suffix}`), proposalId = id(`proposal:${suffix}`);
          const spec = { schemaVersion: 1, kind: 'basket', target: { weights: [{ instrument: { venue, symbol: venue === 'coinbase' ? 'BTC' : 'VTI' }, bps: 10000 }], cashBps: 0 }, rebalance: { schedule: 'daily', driftBandPoints: null, driftBandRelative: null } };
          allocations.push({ id: allocationId, accountId, strategyId, takeId, venue, headId: null });
          await db.transaction(async tx => {
            await tx.query('INSERT INTO strategies(id,owner_id,created_at,updated_at) SELECT $1,id,$2,$2 FROM local_owners', [strategyId, CREATED]);
            await tx.query(`INSERT INTO takes(id,owner_id,title,selection,strategy_id,updated_at)
              SELECT $1,id,$2,'{"provider":"claude","model":"default"}',$3,$4 FROM local_owners`, [takeId, `Synthetic ${suffix}`, strategyId, CREATED]);
            await tx.query(`INSERT INTO strategy_proposals(id,strategy_id,owner_id,target_take_id,source_take_id,revision,producer,producer_identity,payload,platform_context,verification,operation_id,request_hash,created_at)
              SELECT $1,$2,id,$3,$3,1,'human','{}',$4,'{}','{}',$5,'synthetic',$6 FROM local_owners`, [proposalId, strategyId, takeId, JSON.stringify({ metadata: { title: `Synthetic ${suffix}`, description: '', rationale: '', holdings: [] }, spec, unsupportedRequests: [] }), id(`proposal-operation:${suffix}`), CREATED]);
            await tx.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification,source_proposal_id,created_at)
              SELECT $1,$2,id,1,1,$3,$4,'{}','{}',$5,$6 FROM local_owners`, [versionId, strategyId, JSON.stringify({ title: `Synthetic ${suffix}` }), JSON.stringify(spec), proposalId, CREATED]);
            await tx.query("UPDATE strategies SET status='committed',current_version_id=$2,draft_revision_id=$3 WHERE id=$1", [strategyId, versionId, proposalId]);
            await tx.query('INSERT INTO strategy_account_plans(strategy_id,revision,updated_at) VALUES($1,$2,$3)', [strategyId, id(`route:${suffix}`), CREATED]);
            await tx.query('INSERT INTO strategy_account_routes(strategy_id,venue,account_id) VALUES($1,$2,$3)', [strategyId, venue, accountId]);
            if (venue === 'coinbase') {
              await tx.query('INSERT INTO coinbase_allocations(id,account_id,strategy_id,version_id,created_at) VALUES($1,$2,$3,$4,$5)', [allocationId, accountId, strategyId, versionId, CREATED]);
              await tx.query(`INSERT INTO coinbase_allocation_entries(id,allocation_id,account_id,asset,quantity,cause,request_hash,kind,occurred_at)
                VALUES($1,$2,$3,'USDC',100,'synthetic-capital','synthetic','capital',$4)`, [id(`capital:${suffix}`), allocationId, accountId, CREATED]);
            } else {
              await tx.query(`INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,accepted_version_id,applied_version_sequence,currency,status,created_at,updated_at,activated_at)
                VALUES($1,$2,$3,$4,$4,1,'USD','active',$5,$5,$5)`, [allocationId, accountId, strategyId, versionId, CREATED]);
              const transactionId = id(`capital-transaction:${suffix}`);
              await tx.query(`INSERT INTO strategy_allocation_transactions(id,allocation_id,sequence,kind,trigger,requested_amount,idempotency_key,request_hash,created_at)
                VALUES($1,$2,1,'investment','manual',100,'synthetic-capital','synthetic',$3)`, [transactionId, allocationId, CREATED]);
              await tx.query(`INSERT INTO strategy_attribution_entries(id,allocation_id,account_id,transaction_id,sequence,entry_type,cash_delta,currency,source_kind,source_ref,idempotency_key,request_hash,occurred_at,recorded_at)
                VALUES($1,$2,$3,$4,1,'capital_allocated',100,'USD','synthetic','synthetic','synthetic-capital','synthetic',$5,$5)`, [id(`capital:${suffix}`), allocationId, accountId, transactionId, CREATED]);
            }
          });
        }
      }
    }
    const coinbaseAccounts = accounts.filter(a => a.venue === 'coinbase');
    const robinhoodAllocations = allocations.filter(a => a.venue === 'robinhood');
    const historyCounts = { messages: 0, portfolioObservations: 0, reconciliationCases: 0 };
    const observation = (balance: string) => ({ portfolio: { totalValue: balance, currency: 'USD', cash: balance, buyingPower: null }, spotPositions: [{ instrumentRef: 'coinbase:USDC', asset: 'USDC', quantity: balance, marketValue: balance, availableValue: balance, currency: 'USD', isCash: true }], warnings: [] });
    // Three equally weighted history families, round-robin within each family.
    for (let i = 0; i < size.historyRows; i++) {
      const bucket = Math.floor(i / 3);
      const at = new Date(Date.parse(CREATED) + (i + 1) * (now - Date.parse(CREATED)) / (size.historyRows + 1)).toISOString();
      if (i % 3 === 0) {
        const allocation = allocations[bucket % allocations.length], messageId = id(`message:${i}`);
        const data = { id: messageId, parentId: allocation.headId, role: 'user', text: `Synthetic history ${i}`, images: [], createdAt: at, selection: { provider: 'claude', model: 'default' }, state: 'completed', tools: [] };
        await db.query('INSERT INTO take_messages(id,take_id,parent_id,data) VALUES($1,$2,$3,$4)', [messageId, allocation.takeId, allocation.headId, JSON.stringify(data)]);
        allocation.headId = messageId;
        historyCounts.messages++;
      } else if (i % 3 === 1) {
        const account = coinbaseAccounts[bucket % coinbaseAccounts.length];
        await db.query('INSERT INTO coinbase_portfolio_observations(id,account_id,observed_at,data) VALUES($1,$2,$3,$4)', [id(`observation:${i}`), account.id, at, JSON.stringify(observation(account.balance))]);
        historyCounts.portfolioObservations++;
      } else {
        const allocation = robinhoodAllocations[bucket % robinhoodAllocations.length];
        await db.query(`INSERT INTO strategy_reconciliation_cases(id,account_id,scope,cause,impacts,evidence,created_at,updated_at,resolved_at)
          VALUES($1,$2,$3,'unmatched_fill',$4,'{}',$5,$5,$5)`, [id(`case:${i}`), allocation.accountId, `synthetic:${i}`, JSON.stringify([{ allocationId: allocation.id }]), at]);
        historyCounts.reconciliationCases++;
      }
    }
    for (const allocation of allocations) await db.query('UPDATE takes SET head_id=$2 WHERE id=$1', [allocation.takeId, allocation.headId]);
    // One open case proves reconciliation derives a notification from source data.
    const affected = robinhoodAllocations[0];
    await db.query(`INSERT INTO strategy_reconciliation_cases(id,account_id,scope,cause,impacts,evidence,created_at,updated_at)
      VALUES($1,$2,'synthetic-open','unmatched_fill',$3,'{}',$4,$4)`, [id('open-case'), affected.accountId, JSON.stringify([{ allocationId: affected.id }]), new Date(now).toISOString()]);
    for (const account of coinbaseAccounts) {
      await db.query('INSERT INTO coinbase_portfolio_observations(id,account_id,observed_at,data) VALUES($1,$2,$3,$4)', [id(`latest:${account.id}`), account.id, new Date(now).toISOString(), JSON.stringify(observation(account.balance))]);
      await db.query(`INSERT INTO coinbase_transaction_history(account_id,checked_at,state,data) VALUES($1,$2,'complete',$3)`, [account.id, new Date(now).toISOString(), JSON.stringify({ state: 'complete', reason: null, walletCount: 1, completedWallets: 1, transactions: [], wallets: [{ wallet: 'synthetic-usdc', asset: 'USDC', balance: account.balance, available: account.balance, held: '0' }] })]);
    }
    const manifest = { fixtureVersion: 1, ...size, businessTime: new Date(now).toISOString(), historyCounts,
      extraRows: { openReconciliationCases: 1, latestPortfolioObservations: coinbaseAccounts.length, walletHistories: coinbaseAccounts.length }, accounts, allocations };
    return { root, worker, db, database, measurement, manifest, accounts, allocations,
      clock: () => now, advance: (ms: number) => { now += ms; }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
