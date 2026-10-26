import {createVenueQueue,type VenuePriority} from '../venue-queue';
import {orderConfiguration,submitSchema,providerRef,parseSubmission,type CoinbaseSubmission} from './dispatch-contract';
import { coinbasePreviewPost, coinbaseOrderPost, coinbaseCancelPost, coinbaseProductGet, coinbasePortfolioGet } from './rest';
import { productSchema, previewResultSchema, decimalSchema, type Candidate } from './order-planner';
import { createCoinbaseActivityReader, type ActivityRead, type ActivityRequest } from './activity';
import { createCoinbaseHistoryReader, type CoinbaseHistoryRead, type CoinbaseHistory } from './history';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';
import type { SecretStore } from '../secret-store';
import type { CoinbaseChatScope, CoinbaseImportStage, PlatformAccountConnection } from '../../shared/platform-connections';
import type { CoinbaseSessionFactory } from './client';
import { parseCoinbaseKey, readCoinbaseKeyFile, type CoinbaseKey } from './key';
import { checkCoinbaseReadResult, checkedCoinbaseArgs, type CoinbaseChatRead } from './read-tools';
import { CoinbaseError, coinbaseError } from './errors';

const importSchema = z.object({ connectionId: z.uuid().optional(), label: z.string().trim().max(80).optional(), readOnly: z.boolean() }).strict();
const permissionSchema = z.object({ can_view: z.literal(true), can_trade: z.boolean(), can_transfer: z.literal(false), portfolio_uuid: z.uuid(), portfolio_type: z.enum(['DEFAULT', 'CONSUMER']) });
const portfolioSchema = z.object({ uuid: z.uuid(), name: z.string().min(1).max(200), type: z.string().min(1).max(40), deleted: z.boolean().optional() });
type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
interface Row { id: string; account_id: string; credential_ref: string | null; external_account_ref: string; status: 'connected' | 'disconnected' | 'reauth_required'; checked_at: Date | null; label: string; portfolio_name: string; can_trade: boolean; issue: string | null }
const rowsSql = `SELECT c.id,a.id AS account_id,c.credential_ref,c.external_account_ref,c.status,c.checked_at,d.label,d.portfolio_name,d.can_trade,d.issue
 FROM platform_connections c JOIN local_owners o ON o.id=c.owner_id
 JOIN coinbase_connection_details d ON d.connection_id=c.id
 JOIN linked_accounts a ON a.connection_id=c.id AND a.external_ref=c.external_account_ref
 WHERE c.venue='coinbase' AND c.environment='live'`;

export function createCoinbaseConnections(database: Database, secrets: SecretStore, factory: CoinbaseSessionFactory,
  readKey: (path: unknown) => Promise<CoinbaseKey> = readCoinbaseKeyFile, readHistory: CoinbaseHistoryRead = createCoinbaseHistoryReader(), readActivity: ActivityRead = createCoinbaseActivityReader(), previewOrder: typeof coinbasePreviewPost = coinbasePreviewPost, submitOrder:typeof coinbaseOrderPost=coinbaseOrderPost, cancelOrder:typeof coinbaseCancelPost=coinbaseCancelPost, readProduct:typeof coinbaseProductGet=coinbaseProductGet, readPortfolio:typeof coinbasePortfolioGet=coinbasePortfolioGet) {
  const queue = createVenueQueue();
  let stopped = false;
  let importStage: CoinbaseImportStage | null = null;
  function run<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, priority:VenuePriority='sync'): Promise<T> {
    if (stopped) return Promise.reject(new CoinbaseError('cancelled'));
    return queue.submit(async signal => {
      try { return await work(signal); }
      catch(error) { throw signal.aborted ? signal.reason ?? new DOMException('Cancelled','AbortError') : coinbaseError(error); }
    },priority,parent).catch(error => {
      if(error instanceof Error && error.name==='TimeoutError')throw new CoinbaseError('timeout');
      if(error instanceof Error && error.name==='AbortError')throw new CoinbaseError('cancelled');
      throw error;
    });
  }
  async function row(id: unknown) {
    const parsed = z.uuid().safeParse(id); if (!parsed.success) throw new CoinbaseError('unavailable');
    const result = await database.use(db => db.query<Row>(rowsSql + ' AND c.id=$1', [parsed.data]));
    if (!result.rows[0]) throw new CoinbaseError('unavailable');
    return result.rows[0];
  }
  function storage() { if (!secrets.available()) throw new CoinbaseError('storage_locked'); }
  async function verify(key: CoinbaseKey, readOnly: boolean, signal: AbortSignal, progress?: (stage: CoinbaseImportStage) => void) {
    const session = await factory(key, signal);
    try {
      progress?.('permissions');
      const permission = permissionSchema.safeParse(await session.read('coinbase_api_key_permissions', {}, signal));
      if (!permission.success || permission.data.can_trade === readOnly) throw new CoinbaseError('permissions');
      progress?.('portfolio');
      const list = z.object({ portfolios: z.array(portfolioSchema).max(1000) }).safeParse(await session.read('coinbase_portfolios_list', {}, signal));
      if (!list.success) throw new CoinbaseError('scope');
      const matches = list.data.portfolios.filter(p => p.uuid === permission.data.portfolio_uuid && !p.deleted);
      if (matches.length !== 1 || !['DEFAULT', 'CONSUMER'].includes(matches[0].type)) throw new CoinbaseError('scope');
      const detail = z.object({ portfolio: portfolioSchema }).safeParse(await session.read('coinbase_portfolios_get', { portfolio_id: permission.data.portfolio_uuid }, signal));
      if (!detail.success || detail.data.portfolio.uuid !== permission.data.portfolio_uuid || detail.data.portfolio.deleted || !['DEFAULT', 'CONSUMER'].includes(detail.data.portfolio.type)) throw new CoinbaseError('scope');
      signal.throwIfAborted();
      return { portfolio: detail.data.portfolio, trade: permission.data.can_trade };
    } finally { await session.close(); }
  }
  async function list(): Promise<PlatformAccountConnection[]> {
    const rows = (await database.use(db => db.query<Row>(rowsSql + ' ORDER BY d.label,c.id'))).rows;
    const result: PlatformAccountConnection[] = [];
    for (const item of rows) {
      let status: PlatformAccountConnection['status'] = item.status;
      if (status === 'connected') {
        if (!secrets.available()) status = 'storage_locked';
        else if (!item.credential_ref) status = 'reauth_required';
        else { try { if (!await secrets.has(item.credential_ref)) status = 'reauth_required'; } catch { status = 'storage_locked'; } }
      }
      result.push({ connectionId: item.id, accountId: item.account_id, venue: 'coinbase', environment: 'live',
        label: item.label, portfolioName: item.portfolio_name, maskedReference: '••••' + item.external_account_ref.slice(-4), status,
        checkedAt: item.checked_at?.toISOString() ?? null, permissions: { view: true, trade: item.can_trade, transfer: false },
        capabilities: { accountRead: status === 'connected', chat: status === 'connected', trading: false }, issue: item.issue });
    }
    return result;
  }
  async function chatRow(accountRef: string) {
    storage(); z.uuid().parse(accountRef);
    const item = (await database.use(db => db.query<Row>(rowsSql + ' AND a.id=$1', [accountRef]))).rows[0];
    if (!item || item.status !== 'connected' || !item.credential_ref || !await secrets.has(item.credential_ref)) throw new CoinbaseError('unavailable');
    return item;
  }
  const authority = (item: Row) => createHash('sha256').update(JSON.stringify([item.id,item.account_id,item.credential_ref,item.external_account_ref,item.can_trade])).digest('hex');
  async function chatScope(accountRef: string): Promise<CoinbaseChatScope> {
    const item = await chatRow(accountRef);
    return { accountRef: item.account_id, label: item.label, authority: authority(item) };
  }
  async function orderWrite<T>(scope:CoinbaseChatScope,body:unknown,post:typeof coinbaseOrderPost,beforeSend:()=>Promise<void>,normalize:(raw:unknown)=>T){
    return run(async signal=>{
      const item=await chatRow(scope.accountRef);
      if(authority(item)!==scope.authority||!item.can_trade)throw new CoinbaseError('permissions');
      const raw=await secrets.get(item.credential_ref!);if(!raw)throw new CoinbaseError('authentication');
      const key=parseCoinbaseKey(raw),session=await factory(key,signal);
      try{const permission=permissionSchema.safeParse(await session.read('coinbase_api_key_permissions',{},signal));
        if(!permission.success||!permission.data.can_trade||permission.data.portfolio_uuid!==item.external_account_ref)throw new CoinbaseError('permissions');
      }finally{await session.close();}
      if((await chatScope(scope.accountRef)).authority!==scope.authority)throw new CoinbaseError('unavailable');
      signal.throwIfAborted();await beforeSend();signal.throwIfAborted();
      const request=typeof body==='function'?body(item.external_account_ref):body;
      const result=await post(key,signal,request);signal.throwIfAborted();
      if((await chatScope(scope.accountRef)).authority!==scope.authority)throw new CoinbaseError('unavailable');
      return normalize(result);
    },undefined,'order');
  }
  return {
    submitOrder(scope:CoinbaseChatScope,input:CoinbaseSubmission,beforeSend:()=>Promise<void>){
      const order=submitSchema.parse(input);
      return orderWrite(scope,(portfolio:string)=>({retail_portfolio_id:portfolio,client_order_id:order.clientRef,preview_id:order.previewId,product_id:order.product,side:order.side.toUpperCase(),order_configuration:orderConfiguration(order)}),submitOrder,beforeSend,raw=>parseSubmission(raw,order));
    },
    cancelOrder(scope:CoinbaseChatScope,id:string,beforeSend:()=>Promise<void>){
      providerRef.parse(id);
      return orderWrite(scope,{order_ids:[id]},cancelOrder,beforeSend,raw=>{
        const result=z.object({results:z.array(z.object({order_id:z.literal(id),success:z.boolean()})).length(1)}).parse(raw);
        return result.results[0].success;
      });
    },
    readPositionDetails(scope:CoinbaseChatScope){
      return run(async signal=>{
        const item=await chatRow(scope.accountRef);
        if(authority(item)!==scope.authority)throw new CoinbaseError('unavailable');
        const raw=await secrets.get(item.credential_ref!);if(!raw)throw new CoinbaseError('authentication');
        const result=await readPortfolio(parseCoinbaseKey(raw),signal,item.external_account_ref!);
        signal.throwIfAborted();if((await chatScope(scope.accountRef)).authority!==scope.authority)throw new CoinbaseError('unavailable');
        const value=z.object({breakdown:z.object({portfolio:z.object({uuid:z.literal(item.external_account_ref)}),spot_positions:z.array(z.object({asset:z.string(),total_balance_crypto:z.unknown(),total_balance_fiat:z.unknown(),cost_basis:z.unknown().optional(),average_entry_price:z.unknown().optional()})).max(10000)})}).parse(result);
        return value.breakdown.spot_positions;
      });
    },
    readTradingRules(scope:CoinbaseChatScope,product:string){
      z.string().regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/).max(81).parse(product);
      return run(async signal=>{
        const item=await chatRow(scope.accountRef);
        if(authority(item)!==scope.authority)throw new CoinbaseError('unavailable');
        const raw=await secrets.get(item.credential_ref!);if(!raw)throw new CoinbaseError('authentication');
        const result=productSchema.parse(await readProduct(parseCoinbaseKey(raw),signal,product));
        if(result.product_id!==product)throw new CoinbaseError('provider');
        signal.throwIfAborted();
        if((await chatScope(scope.accountRef)).authority!==scope.authority)throw new CoinbaseError('unavailable');
        return result;
      });
    },
    readProductMetadata(accountId:string,product:string){
      z.string().regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/).max(81).parse(product);
      return run(async signal=>{
        const scope=await chatScope(accountId),item=await chatRow(accountId);
        if(authority(item)!==scope.authority)throw new CoinbaseError('unavailable');
        const raw=await secrets.get(item.credential_ref!);if(!raw)throw new CoinbaseError('authentication');
        const result=await readProduct(parseCoinbaseKey(raw),signal,product);
        signal.throwIfAborted();
        if((await chatScope(accountId)).authority!==scope.authority)throw new CoinbaseError('unavailable');
        const metadata=z.object({product_id:z.literal(product),base_name:z.string().optional(),approximate_quote_24h_volume:z.string().optional(),high_24h:z.string().optional(),low_24h:z.string().optional(),market_cap:z.string().optional(),about_description:z.string().optional()}).parse(result);
        return metadata;
      });
    },
    list,
    chatScope,
    async assertChatScope(scope: CoinbaseChatScope) {
      if ((await chatScope(scope.accountRef)).authority !== scope.authority) throw new CoinbaseError('unavailable');
    },
    readChat(scope: CoinbaseChatScope, name: string, input: unknown, parent?: AbortSignal) {
      return run(async signal => {
        const item = await chatRow(scope.accountRef);
        if (authority(item) !== scope.authority) throw new CoinbaseError('unavailable');
        const args = checkedCoinbaseArgs(name, input, item.external_account_ref);
        const raw = await secrets.get(item.credential_ref!);
        if (!raw) throw new CoinbaseError('authentication');
        const key = parseCoinbaseKey(raw);
        const session = await factory(key, signal);
        try {
          const permission = permissionSchema.safeParse(await session.read('coinbase_api_key_permissions', {}, signal));
          if (!permission.success || permission.data.portfolio_uuid !== item.external_account_ref || permission.data.can_trade !== item.can_trade) throw new CoinbaseError('permissions');
          if ((await chatScope(scope.accountRef)).authority !== scope.authority) throw new CoinbaseError('unavailable');
          const data = await session.read(name as CoinbaseChatRead, args, signal);
          signal.throwIfAborted();
          checkCoinbaseReadResult(name, data, args);
          if ((await chatScope(scope.accountRef)).authority !== scope.authority) throw new CoinbaseError('unavailable');
          if (name === 'coinbase_portfolios_get' && (data as {portfolio?:{uuid?:string}})?.portfolio?.uuid !== item.external_account_ref) throw new CoinbaseError('scope');
          const serialized = JSON.stringify(data, (field, value) => {
            if (['portfolio_id','portfolio_uuid','retail_portfolio_id'].includes(field) && typeof value === 'string' && value !== item.external_account_ref) throw new CoinbaseError('scope');
            if (/secret|private.?key|authorization|access.?token|api.?key/i.test(field)) return '[redacted]';
            return typeof value === 'string' ? value.split(key.privateKey).join('[redacted]').split(key.name).join('[redacted]').split(item.external_account_ref).join(scope.accountRef) : value;
          });
          if (!serialized || serialized.length > 450_000) throw new CoinbaseError('provider');
          return { source: { platform: 'coinbase', accountRef: scope.accountRef, accountLabel: scope.label, observedAt: new Date().toISOString(), tool: name, runtime: '0.0.10' },
            coverage: ['coinbase_orders_list','coinbase_orders_fills','coinbase_products_list'].includes(name) ? 'One bounded page; inspect cursor/has_next before claiming complete coverage.' : 'Provider snapshot; missing fields, pairs or intervals are unknown, not zero. No cached fallback.', data: JSON.parse(serialized) };
        } finally { await session.close(); }
      }, parent);
    },
    readHistory(scope: CoinbaseChatScope, previous?: CoinbaseHistory) {
      return run(async signal => {
        const item = await chatRow(scope.accountRef);
        if (authority(item) !== scope.authority) throw new CoinbaseError('unavailable');
        const raw = await secrets.get(item.credential_ref!);
        if (!raw) throw new CoinbaseError('authentication');
        const key = parseCoinbaseKey(raw);
        const session = await factory(key, signal);
        let portfolioWallets:{id:string;asset:string}[]=[];
        try {
          const permission = permissionSchema.safeParse(await session.read('coinbase_api_key_permissions', {}, signal));
          if (!permission.success || permission.data.portfolio_uuid !== item.external_account_ref || permission.data.can_trade !== item.can_trade) throw new CoinbaseError('permissions');
          const detail=z.object({portfolio:z.object({uuid:z.uuid()}),spot_positions:z.array(z.object({account_uuid:z.uuid(),asset:z.string()}))}).parse(await session.read('coinbase_portfolios_get',{portfolio_id:item.external_account_ref},signal));
          if(detail.portfolio.uuid!==item.external_account_ref)throw new CoinbaseError('scope');
          portfolioWallets=detail.spot_positions.map(p=>({id:p.account_uuid,asset:p.asset}));
        } finally { await session.close(); }
        const data = await readHistory(key, item.external_account_ref, signal, previous, portfolioWallets);
        if ((await chatScope(scope.accountRef)).authority !== scope.authority) throw new CoinbaseError('unavailable');
        return data;
      });
    },
    readActivity(scope: CoinbaseChatScope, request: ActivityRequest) {
      return run(async signal => {
        const item = await chatRow(scope.accountRef);
        if (authority(item) !== scope.authority) throw new CoinbaseError('unavailable');
        const raw = await secrets.get(item.credential_ref!);
        if (!raw) throw new CoinbaseError('authentication');
        const key = parseCoinbaseKey(raw);
        const session = await factory(key, signal);
        try {
          const permission = permissionSchema.safeParse(await session.read('coinbase_api_key_permissions', {}, signal));
          if (!permission.success || permission.data.portfolio_uuid !== item.external_account_ref || permission.data.can_trade !== item.can_trade) throw new CoinbaseError('permissions');
        } finally { await session.close(); }
        const data = await readActivity(key, item.external_account_ref, signal, request);
        if ((await chatScope(scope.accountRef)).authority !== scope.authority) throw new CoinbaseError('unavailable');
        return data;
      });
    },
    previewOrders(scope:CoinbaseChatScope, orders:Candidate[]) {
      const requests=z.array(z.object({orderType:z.enum(['market','limit']).optional(),product:z.string().regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/),side:z.enum(['buy','sell']),baseSize:decimalSchema,limitPrice:decimalSchema,notional:decimalSchema}).strict()).max(20).parse(orders);
      return run(async signal=>{
        const item=await chatRow(scope.accountRef);
        if(authority(item)!==scope.authority||!item.can_trade)throw new CoinbaseError('permissions');
        const raw=await secrets.get(item.credential_ref!);if(!raw)throw new CoinbaseError('authentication');
        const key=parseCoinbaseKey(raw),session=await factory(key,signal);
        try {
          const permission=permissionSchema.safeParse(await session.read('coinbase_api_key_permissions',{},signal));
          if(!permission.success||!permission.data.can_trade||permission.data.portfolio_uuid!==item.external_account_ref)throw new CoinbaseError('permissions');
        }finally{await session.close();}
        const results=[];
        for(const order of requests){
          if((await chatScope(scope.accountRef)).authority!==scope.authority)throw new CoinbaseError('unavailable');
          const response=await previewOrder(key,signal,{retail_portfolio_id:item.external_account_ref,product_id:order.product,side:order.side.toUpperCase(),
            order_configuration:orderConfiguration(order)});
          const parsed=previewResultSchema.safeParse(response);if(!parsed.success)throw new CoinbaseError('provider');
          results.push(parsed.data);
        }
        signal.throwIfAborted();
        if((await chatScope(scope.accountRef)).authority!==scope.authority)throw new CoinbaseError('unavailable');
        return results;
      });
    },
    importProgress: () => importStage,
    busy: () => Boolean(queue.stats().running || queue.stats().queued),
    queueStats: () => queue.stats(),
    async cancel() { queue.cancel(); await queue.settled(); },
    async close() { stopped = true; await queue.close(); },
    importKey(path: unknown, input: unknown) {
      return run(async signal => {
        storage();
        const options = importSchema.safeParse(input); if (!options.success) throw new CoinbaseError('invalid_key');
        const prior = options.data.connectionId ? await row(options.data.connectionId) : undefined;
        importStage = 'key';
        const key = await readKey(path); signal.throwIfAborted();
        const verified = await verify(key, options.data.readOnly, signal, stage => { importStage = stage; });
        if (prior && prior.external_account_ref !== verified.portfolio.uuid) throw new CoinbaseError('wrong_account');
        const duplicate = (await database.use(db => db.query<Row>(rowsSql + ' AND c.external_account_ref=$1', [verified.portfolio.uuid]))).rows[0];
        if (!prior && duplicate?.credential_ref && duplicate.status !== 'disconnected') throw new CoinbaseError('duplicate');
        const existing = prior ?? duplicate;
        const connectionId = existing?.id ?? randomUUID();
        const ref = `coinbase:${randomUUID()}`;
        importStage = 'saving';
        let committed = false;
        try {
          await secrets.set(ref, JSON.stringify(key)); signal.throwIfAborted();
          await database.use(db => db.transaction(async tx => {
            signal.throwIfAborted();
            await tx.query(`INSERT INTO platform_connections(id,owner_id,venue,environment,external_account_ref,credential_ref,status,checked_at,maintenance_enabled)
              SELECT $1,id,'coinbase','live',$2,$3,'connected',now(),false FROM local_owners
              ON CONFLICT(id) DO UPDATE SET credential_ref=excluded.credential_ref,status='connected',checked_at=excluded.checked_at`, [connectionId, verified.portfolio.uuid, ref]);
            await tx.query(`INSERT INTO coinbase_connection_details(connection_id,label,portfolio_name,can_trade) VALUES($1,$2,$3,$4)
              ON CONFLICT(connection_id) DO UPDATE SET label=excluded.label,portfolio_name=excluded.portfolio_name,can_trade=excluded.can_trade,issue=NULL`,
              [connectionId, options.data.label?.trim() || existing?.label || verified.portfolio.name.slice(0, 80), verified.portfolio.name, verified.trade]);
            await tx.query(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,nickname,account_type,agentic_allowed,selected,available)
              VALUES($1,$2,$3,$4,'coinbase_portfolio',false,false,true) ON CONFLICT(connection_id,external_ref)
              DO UPDATE SET nickname=excluded.nickname,available=true`, [connectionId, verified.portfolio.uuid, '••••' + verified.portfolio.uuid.slice(-4), verified.portfolio.name]);
            signal.throwIfAborted();
          }));
          committed = true;
        } finally { if (!committed) await secrets.delete(ref).catch(() => {}); }
        // Replacement becomes authoritative atomically. An old unreferenced encrypted
        // secret cannot be used by this service, even if OS storage locks during cleanup.
        if (existing?.credential_ref) await secrets.delete(existing.credential_ref).catch(() => {});
        return list();
      }).finally(() => { importStage = null; });
    },
    refresh(id: unknown) {
      return run(async signal => {
        storage(); const existing = await row(id);
        if (!existing.credential_ref || existing.status === 'disconnected') throw new CoinbaseError('unavailable');
        try {
          const raw = await secrets.get(existing.credential_ref);
          if (!raw) throw new CoinbaseError('authentication');
          const verified = await verify(parseCoinbaseKey(raw), !existing.can_trade, signal);
          if (verified.portfolio.uuid !== existing.external_account_ref) throw new CoinbaseError('wrong_account');
          signal.throwIfAborted();
          await database.use(db => db.transaction(async tx => {
            await tx.query("UPDATE platform_connections SET status='connected',checked_at=now() WHERE id=$1", [existing.id]);
            await tx.query('UPDATE coinbase_connection_details SET portfolio_name=$2,issue=NULL WHERE connection_id=$1', [existing.id, verified.portfolio.name]);
            await tx.query('UPDATE linked_accounts SET nickname=$2,available=true WHERE connection_id=$1', [existing.id, verified.portfolio.name]);
          }));
        } catch (error) {
          if (signal.aborted) throw new CoinbaseError('cancelled');
          const failure = coinbaseError(error);
          const needsKey = ['authentication', 'permissions', 'scope', 'wrong_account', 'invalid_key'].includes(failure.code);
          await database.use(db => db.transaction(async tx => {
            await tx.query('UPDATE coinbase_connection_details SET issue=$2 WHERE connection_id=$1', [existing.id, failure.message]);
            if (needsKey) await tx.query("UPDATE platform_connections SET status='reauth_required' WHERE id=$1", [existing.id]);
          }));
          throw failure;
        }
        return list();
      });
    },
    rename(id: unknown, value: unknown) {
      return run(async () => {
        const existing = await row(id); const label = z.string().trim().min(1).max(80).safeParse(value);
        if (!label.success) throw new CoinbaseError('unavailable');
        await database.use(db => db.query('UPDATE coinbase_connection_details SET label=$2 WHERE connection_id=$1', [existing.id, label.data]));
        return list();
      });
    },
    disconnect(id: unknown) {
      return run(async () => {
        storage(); const existing = await row(id);
        await database.use(db => db.transaction(async tx => {
          await tx.query('SELECT id FROM linked_accounts WHERE id=$1 FOR UPDATE',[existing.account_id]);
          const pending=(await tx.query("SELECT 1 FROM coinbase_allocation_orders WHERE account_id=$1 AND state<>'closed' LIMIT 1",[existing.account_id])).rows.length;
          if(pending)throw new CoinbaseError('orders_pending');
          await tx.query("UPDATE platform_connections SET credential_ref=NULL,status='disconnected',maintenance_enabled=false WHERE id=$1", [existing.id]);
          await tx.query('UPDATE linked_accounts SET selected=false,available=false WHERE connection_id=$1', [existing.id]);
          await tx.query('UPDATE coinbase_connection_details SET issue=NULL WHERE connection_id=$1', [existing.id]);
        }));
        if (existing.credential_ref) await secrets.delete(existing.credential_ref);
        return list();
      });
    },
  };
}
