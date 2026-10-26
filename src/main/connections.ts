import type {CryptoTransport} from './orders/crypto-transport';
import { parseScanOperation, type ScanOperation } from './search/screener-tools';
import type { ManagedScanScope } from './search/managed-scans';
import {createVenueQueue,createReadCoalescer,type VenuePriority} from './venue-queue';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient as PGlite } from './database-client';
import type { createDatabaseLifecycle } from './database';
import type { SecretStore } from './secret-store';
import type { RobinhoodToolDefinition, ConnectionSummary } from '../shared/connections';
import { loadProvider } from './robinhood-client';
import type { DiscoveredAccount } from './robinhood-client';
import { dynamicReadArguments } from './market-research-policy';
import { hasKnownRead, parseRead } from './opentake-mcp/catalog';
import { ConnectionFailure, connectionFailure } from './connection-errors';
import type { WatchlistWriteTool } from './opentake-mcp/robinhood-contracts';

interface ConnectionRow { id: string; owner_id: string; credential_ref: string | null; status: ConnectionSummary['status']; checked_at: Date | null }
const select = `SELECT c.* FROM platform_connections c JOIN local_owners o ON o.id = c.owner_id WHERE c.venue = 'robinhood'`;
type ProviderFactory = (secrets: SecretStore, ref: string, ownerId: string, connectionId: string, fresh: boolean) => Promise<{
  cryptoSession?<T>(externalRef:string,accountId:string,signal:AbortSignal,work:(session:CryptoTransport)=>Promise<T>):Promise<T>;
  toolSchemas?(signal: AbortSignal): Promise<RobinhoodToolDefinition[]>;
  cryptoToolSchemas?(signal: AbortSignal): Promise<RobinhoodToolDefinition[]>;
  close?():Promise<void>;
  authorize(signal: AbortSignal, openBrowser: (url: string) => Promise<void>): Promise<void>;
  accounts(signal: AbortSignal): Promise<DiscoveredAccount[]>;
  matchesImportedAccount?(externalRef:string,connectionId:string,accountRefHash:string,signal:AbortSignal):Promise<boolean>;
  readTool?(name: string, args: Record<string, unknown>, externalRef: string | undefined, signal: AbortSignal): Promise<unknown>;
  watchlistWrite?(name: WatchlistWriteTool, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  scanTool?(name: ScanOperation, args: Record<string, unknown>, externalRef: string, signal: AbortSignal, authorize: () => Promise<void>): Promise<unknown>;
  equityOrder?(stage: 'review' | 'place', input: unknown, externalRef: string, signal: AbortSignal, refId?: string): Promise<unknown>;
}>;
export function createConnections(database: ReturnType<typeof createDatabaseLifecycle>, secrets: SecretStore,
  openBrowser: (url: string) => Promise<void>, providerFactory: ProviderFactory = loadProvider) {
  let active: { controller: AbortController; promise: Promise<ConnectionSummary> } | undefined;
  let stopped = false;
  const queue=createVenueQueue();
  const reads=createReadCoalescer();
  let signInUrl: string | undefined;
  let cached:{key:string;provider:Awaited<ReturnType<ProviderFactory>>}|undefined;
  async function clearProvider(){const prior=cached;cached=undefined;await prior?.provider.close?.();}
  async function providerFor(ref:string,owner:string,connection:string,fresh=false){
    const key=JSON.stringify([ref,owner,connection]);
    if(fresh||cached?.key!==key){await clearProvider();cached={key,provider:await providerFactory(secrets,ref,owner,connection,fresh)};}
    return cached.provider;
  }
  async function summary(db: PGlite): Promise<ConnectionSummary> {
    const row = (await db.query<ConnectionRow>(select)).rows[0];
    if (!row) return { status: 'disconnected', checkedAt: null, accounts: [] };
    const status = row.status === 'connected' && (!row.credential_ref || !secrets.available() || !await secrets.has(row.credential_ref))
      ? 'reauth_required' : row.status;
    const accounts = (await db.query<ConnectionSummary['accounts'][number]>(`SELECT id, masked_number AS "maskedNumber", nickname,
      account_type AS "accountType", option_level AS "optionLevel", agentic_allowed AS "agenticAllowed", selected FROM linked_accounts WHERE connection_id = $1 AND available ORDER BY masked_number, id`, [row.id])).rows;
    return { status, checkedAt: row.checked_at?.toISOString() ?? null, accounts };
  }
  // Sign-in waits for the member in the browser; every other venue task gets the queue's minute.
  const SIGN_IN_MS=300_000;
  function run(work: (db: PGlite, signal: AbortSignal) => Promise<void>, externalSignal?: AbortSignal, priority:VenuePriority='sync', runMs?:number, waitForSettlement=false): Promise<ConnectionSummary> {
    if(stopped)return Promise.reject(new ConnectionFailure('cancelled'));
    return queue.submit(async signal=>{
      const controller=new AbortController();const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      const promise=database.use(async db=>{controller.signal.throwIfAborted();await work(db,controller.signal);return summary(db);});
      active={controller,promise};
      try{return await promise;}finally{signal.removeEventListener('abort',abort);active=undefined;}
    },priority,externalSignal,runMs,waitForSettlement);
  }
  async function synchronize(db: PGlite, signal: AbortSignal, fresh: boolean) {
    if (!secrets.available()) throw new ConnectionFailure('storage_locked');
    await db.exec(`INSERT INTO platform_connections(owner_id, venue) SELECT id, 'robinhood' FROM local_owners ON CONFLICT DO NOTHING`);
    const row = (await db.query<ConnectionRow>(select)).rows[0];
    if (!row) throw new Error('Local owner missing');
    // Stage a replacement separately; an abandoned login must not destroy a
    // working connection or leave its partial OAuth registration referenced.
    const ref = fresh ? `robinhood:${randomUUID()}` : row.credential_ref;
    if (!ref) throw new ConnectionFailure('reauth_required');
    try {
      let provider;
      try { provider = await providerFor(ref,row.owner_id,row.id,fresh); }
      catch { throw new ConnectionFailure('storage_locked'); }
      if (fresh) {
        try {
          await provider.authorize(signal, async url => { signInUrl = url; await openBrowser(url); });
        } finally { signInUrl = undefined; }
      }
      const accounts = await provider.accounts(signal);
      signal.throwIfAborted();
      await db.transaction(async tx => {
        // Keep local IDs and the user's selection stable across refreshes.
        const old = (await tx.query<{ external_ref: string; selected: boolean }>('SELECT external_ref, selected FROM linked_accounts WHERE connection_id = $1', [row.id])).rows;
        const selected = old.find(account => account.selected)?.external_ref;
        const eligible = accounts.filter(account => account.agenticAllowed);
        const nextSelection = accounts.some(account => account.externalRef === selected && account.agenticAllowed)
          ? selected : eligible.length === 1 ? eligible[0].externalRef : undefined;
        await tx.query('UPDATE linked_accounts SET selected = false WHERE connection_id = $1', [row.id]);
        for (const account of accounts) {
          await tx.query(`INSERT INTO linked_accounts(connection_id, external_ref, masked_number, nickname, account_type, agentic_allowed, selected, option_level)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connection_id, external_ref) DO UPDATE SET
            masked_number = EXCLUDED.masked_number, nickname = EXCLUDED.nickname, account_type = EXCLUDED.account_type, option_level = EXCLUDED.option_level,
            agentic_allowed = EXCLUDED.agentic_allowed, selected = EXCLUDED.selected, available = true`,
          [row.id, account.externalRef, account.maskedNumber, account.nickname, account.accountType, account.agenticAllowed, account.externalRef === nextSelection, account.optionLevel ?? null]);
        }
        await tx.query('UPDATE linked_accounts SET available=false, selected=false, agentic_allowed=false WHERE connection_id = $1 AND NOT (external_ref = ANY($2::text[]))', [row.id, accounts.map(account => account.externalRef)]);
        await tx.query(`UPDATE platform_connections SET credential_ref = $2, status = 'connected', maintenance_enabled = true, checked_at = now() WHERE id = $1`, [row.id, ref]);
      });
    } catch (error) {
      const failure = connectionFailure(error, signal);
      if (fresh) await secrets.delete(ref).catch(() => {});
      else if (failure.code === 'reauth_required') await db.query(`UPDATE platform_connections SET status = 'reauth_required', maintenance_enabled = false WHERE id = $1`, [row.id]);
      throw failure;
    }
    // The new reference is committed; cleanup failure must not undo a successful
    // connection. OS storage may be temporarily locked, so deletion is best effort.
    if (fresh && row.credential_ref) await secrets.delete(row.credential_ref).catch(() => {});
  }
  return {
    async toolSchemas(externalSignal?: AbortSignal): Promise<RobinhoodToolDefinition[]> {
      let tools: RobinhoodToolDefinition[] = [];
      await run(async (db, signal) => {
        const row = (await db.query<ConnectionRow>(select)).rows[0];
        if (!row?.credential_ref || (await summary(db)).status !== 'connected') throw new ConnectionFailure('reauth_required');
        const provider = await providerFor(row.credential_ref, row.owner_id, row.id);
        if (!provider.toolSchemas) throw new Error('Tool discovery unavailable');
        tools = await provider.toolSchemas(signal);
      }, externalSignal, 'facts');
      return tools;
    },
    async cryptoToolSchemas(externalSignal?: AbortSignal): Promise<RobinhoodToolDefinition[]> {
      let tools: RobinhoodToolDefinition[] = [];
      await run(async (db, signal) => {
        const row = (await db.query<ConnectionRow>(select)).rows[0];
        if (!row?.credential_ref || (await summary(db)).status !== 'connected') throw new ConnectionFailure('reauth_required');
        const provider = await providerFor(row.credential_ref, row.owner_id, row.id);
        if (!provider.cryptoToolSchemas) throw new Error('Tool discovery unavailable');
        tools = await provider.cryptoToolSchemas(signal);
        signal.throwIfAborted();
      }, externalSignal, 'facts');
      return tools;
    },
    async matchStrategyImport(connectionId:string,accountRefHash:string):Promise<string|null>{
      let matched:string|null=null;
      await run(async(db,signal)=>{
        const row=(await db.query<ConnectionRow>(select)).rows[0];
        if(!row?.credential_ref || (await summary(db)).status!=='connected')throw new ConnectionFailure('reauth_required');
        const accounts=(await db.query<{external_ref:string}>(`SELECT external_ref FROM linked_accounts WHERE connection_id=$1 AND selected AND available AND agentic_allowed`,[row.id])).rows;
        if(accounts.length!==1)return;
        const provider=await providerFor(row.credential_ref,row.owner_id,row.id);
        if(await provider.matchesImportedAccount?.(accounts[0].external_ref,connectionId,accountRefHash,signal))matched=accounts[0].external_ref;
      });
      return matched;
    },
    async scanScope(): Promise<ManagedScanScope> {
      return database.use(async db => {
        const row = (await db.query<ConnectionRow>(select)).rows[0];
        const state = await summary(db);
        const selected = state.accounts.filter(a => a.selected && a.agenticAllowed);
        if (!row || state.status !== 'connected' || selected.length !== 1) throw new Error('Select a connected Robinhood account for screening.');
        return { venue: 'robinhood', instance: 'production', connectionId: row.id, accountId: selected[0].id };
      });
    },
    async scanTool(scope: ManagedScanScope, name: ScanOperation, input: unknown, externalSignal: AbortSignal, authorize: () => Promise<void>): Promise<unknown> {
      const parsed = parseScanOperation(name, input);
      let result: unknown;
      await run(async (db, signal) => {
        const row = (await db.query<ConnectionRow>(select)).rows[0];
        if (scope.venue !== 'robinhood' || scope.instance !== 'production' || row?.id !== scope.connectionId
          || !row.credential_ref || (await summary(db)).status !== 'connected') throw new Error('Screener connection changed.');
        const accounts = (await db.query<{ external_ref: string }>(
          'SELECT external_ref FROM linked_accounts WHERE connection_id=$1 AND id=$2 AND available AND selected AND agentic_allowed',
          [row.id, scope.accountId])).rows;
        if (accounts.length !== 1) throw new Error('Screener account changed.');
        const provider = await providerFor(row.credential_ref, row.owner_id, row.id);
        if (!provider.scanTool) throw new Error('Managed screeners unavailable.');
        await authorize(); signal.throwIfAborted();
        result = await provider.scanTool(parsed.operation, parsed.args, accounts[0].external_ref, signal, authorize);
        // Preserve known create outcomes even if cancellation raced the response.
      }, externalSignal, 'facts', undefined, true);
      return result;
    },
    async readTool(name: string, input: Record<string, unknown>, accountRef?: string, externalSignal?: AbortSignal): Promise<unknown> {
      const parsed = hasKnownRead(name) ? parseRead(name, { ...input, ...(accountRef ? { accountRef } : {}) }, true)
        : { tool: { account: false }, args: dynamicReadArguments(name, { ...input, ...(accountRef ? { accountRef } : {}) }), accountRef: undefined };
      const key=JSON.stringify([name,parsed.accountRef??null,Object.entries(parsed.args).sort(([a],[b])=>a.localeCompare(b))]);
      return reads.run(key,async signal=>{
      let result: unknown;
      await run(async (db, signal) => {
        const row = (await db.query<ConnectionRow>(select)).rows[0];
        if (!row?.credential_ref || (await summary(db)).status !== 'connected') throw new ConnectionFailure('reauth_required');
        let externalRef: string | undefined;
        if (parsed.tool.account) {
          const account = (await db.query<{ external_ref: string }>(
            `SELECT external_ref FROM linked_accounts WHERE connection_id = $1 AND available AND selected AND agentic_allowed AND ($2::uuid IS NULL OR id = $2::uuid)`,
            [row.id, parsed.accountRef ?? null])).rows[0];
          if (!account) throw new Error('Select an account in Opentake');
          externalRef = account.external_ref;
        }
        const provider = await providerFor(row.credential_ref,row.owner_id,row.id);
        if (!provider.readTool) throw new Error('Platform reads unavailable');
        result = await provider.readTool(name, parsed.args, externalRef, signal);
        signal.throwIfAborted();
      }, signal, name==='get_equity_quotes'?'quotes':name.includes('orders')||name.includes('tax_lots')||name.includes('tradability')?'reconcile':name.includes('positions')||name==='get_portfolio'?'sync':'facts');
      return result;
      },externalSignal);
    },
    /** Adds to or removes from one of the member's custom Robinhood watchlists. Never retried or coalesced. */
    async watchlistWrite(name: WatchlistWriteTool, input: Record<string, unknown>, externalSignal?: AbortSignal): Promise<unknown> {
      let result: unknown;
      await run(async (db, signal) => {
        const row = (await db.query<ConnectionRow>(select)).rows[0];
        if (!row?.credential_ref || (await summary(db)).status !== 'connected') throw new ConnectionFailure('reauth_required');
        const provider = await providerFor(row.credential_ref, row.owner_id, row.id);
        if (!provider.watchlistWrite) throw new Error('Watchlist edits unavailable');
        result = await provider.watchlistWrite(name, input, signal);
      }, externalSignal, 'facts');
      return result;
    },
    /** Review or place one equity order on a selected agentic account; only the order writer calls this. */
    async equityOrder(stage: 'review' | 'place', input: unknown, accountId: string, refId?: string, externalSignal?: AbortSignal): Promise<unknown> {
      let result: unknown;
      await run(async (db, signal) => {
        const row = (await db.query<ConnectionRow>(select)).rows[0];
        if (!row?.credential_ref || (await summary(db)).status !== 'connected') throw new ConnectionFailure('reauth_required');
        const account = (await db.query<{ external_ref: string }>(
          `SELECT external_ref FROM linked_accounts WHERE connection_id=$1 AND id=$2 AND available AND selected AND agentic_allowed`, [row.id, accountId])).rows[0];
        if (!account) throw new Error('Select an agentic account in Opentake');
        const provider = await providerFor(row.credential_ref,row.owner_id,row.id);
        if (!provider.equityOrder) throw new Error('Platform orders unavailable');
        result = await provider.equityOrder(stage, input, account.external_ref, signal, refId);
      }, externalSignal, 'order');
      return result;
    },
    async cryptoSession<T>(accountId:string,work:(session:CryptoTransport)=>Promise<T>):Promise<T>{
      let result:T;
      await run(async(db,signal)=>{
        const row=(await db.query<ConnectionRow>(select)).rows[0];
        if(!row?.credential_ref||(await summary(db)).status!=='connected')throw new ConnectionFailure('reauth_required');
        const accounts=(await db.query<{external_ref:string}>(`SELECT external_ref FROM linked_accounts WHERE connection_id=$1 AND id=$2 AND available AND selected AND agentic_allowed`,[row.id,accountId])).rows;
        if(accounts.length!==1)throw Error('Select the order’s original agentic account');
        const provider=await providerFor(row.credential_ref,row.owner_id,row.id);
        if(!provider.cryptoSession)throw Error('Crypto transport unavailable');
        result=await provider.cryptoSession(accounts[0].external_ref,accountId,signal,work);
      },undefined,'order',undefined,true);
      return result!;
    },
    busy: () => Boolean(active),
    async settled() { await queue.settled(); },
    queueStats: () => ({...queue.stats(),...reads.stats()}),
    async reopenSignIn() {
      if (!active || active.controller.signal.aborted || !signInUrl) throw new Error('No pending sign-in');
      await openBrowser(signInUrl);
    },
    status: () => database.use(summary),
    connect: () => active||queue.stats().queued?Promise.reject(new ConnectionFailure('busy')):run((db, signal) => synchronize(db, signal, true), undefined, 'sync', SIGN_IN_MS),
    refresh: () => run((db, signal) => synchronize(db, signal, false)),
    cancel: () => { reads.clear();queue.cancel(); },
    async close() { stopped = true; reads.clear();await queue.close(); await clearProvider(); },
    disconnect: () => { reads.clear();queue.cancel();return run(async db => {
      await clearProvider();
      const row = (await db.query<ConnectionRow>(select)).rows[0];
      if (!row) return;
      // Delete first, so a failed secret deletion can be retried via the retained ref.
      if (row.credential_ref) await secrets.delete(row.credential_ref);
      await db.transaction(async tx => {
        await tx.query(`UPDATE platform_connections SET status = 'disconnected', maintenance_enabled = false, credential_ref = NULL, checked_at = NULL WHERE id = $1`, [row.id]);
        await tx.query(`UPDATE background_jobs SET state = 'cancelled', error_code = 'disconnected', updated_at = now() WHERE connection_id = $1 AND state IN ('pending','retrying','needs_attention','failed')`, [row.id]);
        await tx.query('UPDATE linked_accounts SET available=false, selected=false, agentic_allowed=false WHERE connection_id = $1', [row.id]);
      });
    });},
    selectAccount: (id: unknown) => run(async db => {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid account');
      const row = (await db.query<ConnectionRow>(select)).rows[0];
      if (!row || (await summary(db)).status !== 'connected') throw new Error('Sign in required');
      await db.transaction(async tx => {
        const account = await tx.query('SELECT id FROM linked_accounts WHERE id = $1 AND connection_id = $2 AND available AND agentic_allowed', [id, row.id]);
        if (!account.rows.length) throw new Error('Account unavailable');
        await tx.query('UPDATE linked_accounts SET selected = false WHERE connection_id = $1', [row.id]);
        await tx.query('UPDATE linked_accounts SET selected = true WHERE id = $1', [id]);
      });
    }),
  };
}
