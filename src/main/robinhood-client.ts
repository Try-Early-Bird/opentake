import {cryptoErrorDetails} from './orders/crypto-rejection';
import {RobinhoodReadFailure,readFailureCategory} from './robinhood-read-error';
import {robinhoodReadCall} from './robinhood-read-result';
import {createCryptoTransport,type CryptoTransport} from './orders/crypto-transport';
import { robinhoodCryptoPreview } from './trading/robinhood-crypto-preview';
import { bindRobinhoodCryptoAccount } from './robinhood-account-binding';
import { dynamicReadArguments, validateDiscoveredRead } from './market-research-policy';
import { listRobinhoodToolSchemas, listCryptoToolSchemas } from './robinhood-tool-schemas';
import { parseScanOperation, type ScanOperation } from './search/screener-tools';
import { equityOrderSchema, type PlacementResponse } from './orders/contract';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { SecretStore } from './secret-store';
import { captureCallback, redirectUrl } from './robinhood-loopback';
import { hasKnownRead, parseRead } from './opentake-mcp/catalog';
import { robinhoodToolSpec, watchlistWriteTools, type WatchlistWriteTool } from './opentake-mcp/robinhood-contracts';
import { ConnectionFailure } from './connection-errors';

export const mcpUrl = new URL('https://agent.robinhood.com/mcp/trading');
const allowedHosts = new Set(['agent.robinhood.com', 'api.robinhood.com', 'robinhood.com']);
export function validateRobinhoodUrl(input: string | URL): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.port || url.username || url.password) {
    throw new Error('Unexpected Robinhood endpoint');
  }
  return url;
}

export function robinhoodFetch(signal: AbortSignal, fetcher: typeof fetch = fetch, rateLimited?:(until:number)=>void): FetchLike {
  return async (input, init) => {
    validateRobinhoodUrl(input instanceof Request ? input.url : input.toString());
    const response = await fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any([
      signal, AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : []),
    ]) });
    if(response.status===429){
      const retry=response.headers.get('retry-after');
      const delay=retry&&/^\d+$/.test(retry)?Number(retry)*1000:retry?Date.parse(retry)-Date.now():30_000;
      rateLimited?.(Date.now()+Math.max(1000,Number.isFinite(delay)?delay:30_000));
    }
    if (!response.body) return response;
    let size = 0;
    const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > 2 * 1024 * 1024) controller.error(new Error('Response too large'));
        else controller.enqueue(chunk);
      },
    }));
    return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

interface StoredOAuth {
  version: 1;
  ownerId: string;
  connectionId: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
}

export class LocalRobinhoodProvider implements OAuthClientProvider {
  readonly redirectUrl = redirectUrl;
  readonly clientMetadata = {
    redirect_uris: [redirectUrl], client_name: 'Earlybird-Opentake',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'none', scope: 'internal',
  };
  readonly expectedState = randomBytes(32).toString('base64url');
  private session?: {client:Client;transport:StreamableHTTPClientTransport;controller:AbortController};
  private rateLimitedUntil=0;
  private idleTimer?:ReturnType<typeof setTimeout>;
  async close(){clearTimeout(this.idleTimer);const session=this.session;this.session=undefined;if(session){session.controller.abort();await session.transport.close().catch(()=>{});}}
  private verifier?: string;
  private authorizationUrl?: URL;
  constructor(private snapshot: StoredOAuth, private persist: (value: StoredOAuth) => Promise<void>) {}
  state() { return this.expectedState; }
  clientInformation() { return this.snapshot.client; }
  async saveClientInformation(client: OAuthClientInformationMixed) { this.snapshot.client = client; await this.save(); }
  tokens() { return this.snapshot.tokens; }
  async saveTokens(tokens: OAuthTokens) {
    this.snapshot.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? this.snapshot.tokens?.refresh_token };
    this.snapshot.expiresAt = Date.now() + (tokens.expires_in ?? 0) * 1000;
    await this.save();
  }
  redirectToAuthorization(url: URL) {
    validateRobinhoodUrl(url);
    if (url.hostname !== 'robinhood.com' || url.searchParams.get('state') !== this.expectedState ||
        url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Invalid authorization URL');
    this.authorizationUrl = url;
  }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new Error('Missing PKCE verifier'); return this.verifier; }
  discoveryState() { return this.snapshot.discovery; }
  async saveDiscoveryState(value: OAuthDiscoveryState) {
    if (value.authorizationServerUrl !== mcpUrl.href || value.authorizationServerMetadata?.issuer !== mcpUrl.href) throw new Error('Unexpected OAuth issuer');
    this.snapshot.discovery = value; await this.save();
  }
  async invalidateCredentials(scope: 'all' | 'tokens' | 'client' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') { delete this.snapshot.tokens; delete this.snapshot.expiresAt; }
    if (scope === 'all' || scope === 'client') delete this.snapshot.client;
    if (scope === 'all' || scope === 'discovery') delete this.snapshot.discovery;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    await this.save();
  }
  private save() { return this.persist(structuredClone(this.snapshot)); }
  async authorize(signal: AbortSignal, openBrowser: (url: string) => Promise<void>) {
    const capture = await captureCallback(this.expectedState, signal);
    try {
      const result = await auth(this, { serverUrl: mcpUrl, fetchFn: robinhoodFetch(signal) });
      if (result !== 'REDIRECT' || !this.authorizationUrl) throw new Error('Authorization was not started');
      signal.throwIfAborted();
      await openBrowser(this.authorizationUrl.href);
      const code = await capture.callback;
      signal.throwIfAborted();
      if (await auth(this, { serverUrl: mcpUrl, authorizationCode: code, fetchFn: robinhoodFetch(signal) }) !== 'AUTHORIZED') {
        throw new Error('Authorization was not completed');
      }
    } finally { this.verifier = undefined; this.authorizationUrl = undefined; capture.close(); }
  }
  private async withClient<T>(signal: AbortSignal, work: (client: Client) => Promise<T>): Promise<T> {
    if (!this.snapshot.tokens) throw new ConnectionFailure('reauth_required');
    if(Date.now()<this.rateLimitedUntil){
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException('Cancelled','AbortError'));};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},Math.min(2_147_483_647,this.rateLimitedUntil-Date.now()));
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      });
    }
    const fetchFn = robinhoodFetch(signal);
    if ((this.snapshot.expiresAt ?? 0) < Date.now() + 60_000) {
      if (await auth(this, { serverUrl: mcpUrl, fetchFn }) !== 'AUTHORIZED') {
        throw new ConnectionFailure(this.snapshot.tokens?.refresh_token ? 'transient' : 'reauth_required');
      }
    }
    clearTimeout(this.idleTimer);
    if(!this.session){
      const controller=new AbortController();
      const transport=new StreamableHTTPClientTransport(mcpUrl,{authProvider:this,fetch:robinhoodFetch(controller.signal,fetch,until=>{this.rateLimitedUntil=until;})});
      const client=new Client({name:'Earlybird-Opentake',version:'0.1.0'});
      try{await client.connect(transport,{signal,timeout:20_000});}
      catch(error){controller.abort();await transport.close().catch(()=>{});throw error;}
      this.session={client,transport,controller};
    }
    const session=this.session;
    const abort=()=>session.controller.abort();signal.addEventListener('abort',abort,{once:true});
    try{signal.throwIfAborted();return await work(session.client);}
    catch(error){await this.close();throw error;}
    finally{signal.removeEventListener('abort',abort);if(this.session===session){this.idleTimer=setTimeout(()=>{void this.close();},30_000);this.idleTimer.unref?.();}}
  }

  async cryptoSession<T>(externalRef:string,accountId:string,signal:AbortSignal,work:(session:CryptoTransport)=>Promise<T>):Promise<T>{
    let started=false;
    try{return await this.withClient(signal,client=>{started=true;return work(createCryptoTransport(
      (name,args,s)=>readResult(client,name,args,s),
      async(name,args,s)=>{
        const result=await client.callTool({name,arguments:args},undefined,{signal:s,timeout:30_000});
        const meta=result._meta as {rh_error_category?:unknown}|undefined;
        return {isError:result.isError===true,errorCategory:typeof meta?.rh_error_category==='string'?meta.rh_error_category:null,data:toolData(result),...(result.isError?{errorDetails:cryptoErrorDetails(result)}:{})};
      },externalRef,accountId,signal));});}
    catch(error){if(!started&&!(error instanceof ConnectionFailure))throw new RobinhoodReadFailure('session',readFailureCategory(error));throw error;}
  }

  async toolSchemas(signal: AbortSignal) {
    return this.withClient(signal, client => listRobinhoodToolSchemas(client, signal));
  }
  async cryptoToolSchemas(signal: AbortSignal) {
    return this.withClient(signal, client => listCryptoToolSchemas(client, signal));
  }

  async accounts(signal: AbortSignal): Promise<DiscoveredAccount[]> {
    return this.withClient(signal, async client => {
      const accounts = parseAccounts(await readResult(client, 'get_accounts', {}, signal));
      if (!accounts.length) throw new Error('No readable accounts');
      return accounts;
    });
  }
  async matchesImportedAccount(externalRef:string,connectionId:string,accountRefHash:string,signal:AbortSignal):Promise<boolean>{
    return this.withClient(signal,async client=>{
      const numbers=accountNumbers(await readResult(client,'get_accounts',{},signal));
      return numbers.some(number=>matchesImportedAccountNumber(number,externalRef,connectionId,accountRefHash));
    });
  }
  async scanTool(name: ScanOperation, input: Record<string, unknown>, externalRef: string, signal: AbortSignal, authorize: () => Promise<void>): Promise<unknown> {
    const { operation, args } = parseScanOperation(name, input);
    return this.withClient(signal, async client => {
      const accounts = await readResult(client, 'get_accounts', {}, signal);
      if (!parseAccounts(accounts).some(a => a.externalRef === externalRef && a.agenticAllowed)) throw new Error('Screener account unavailable.');
      await authorize(); signal.throwIfAborted();
      const result = await readResult(client, operation, args, signal);
      return redactAccountData(result, [...accountNumbers(accounts), ...accountNumbers(result)]);
    });
  }
  /** Watchlist write-through: list membership only, validated against the tool contract. */
  async watchlistWrite(name: WatchlistWriteTool, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!watchlistWriteTools.includes(name)) throw new Error('Tool unavailable');
    const args = robinhoodToolSpec(name).arguments.parse(input) as Record<string, unknown>;
    return this.withClient(signal, client => robinhoodReadCall(name, () => client.callTool({ name, arguments: args }, undefined, { signal, timeout: 20_000 })));
  }
  async readTool(name: string, input: Record<string, unknown>, externalRef: string | undefined, signal: AbortSignal): Promise<unknown> {
    // The low-level transport independently enforces the read-only allowlist.
    if (!hasKnownRead(name)) {
      const args = dynamicReadArguments(name, input);
      if (externalRef !== undefined) throw new Error('Tool requires an account mapping');
      return this.withClient(signal, async client => {
        const tools = await listRobinhoodToolSchemas(client, signal);
        validateDiscoveredRead(tools.find(tool => tool.name === name), args);
        return redactAccountData(await readResult(client, name, args, signal), []);
      });
    }
    const { tool, args } = parseRead(name, input, true);
    return this.withClient(signal, async client => {
      const accounts = await readResult(client, 'get_accounts', {}, signal);
      const numbers = accountNumbers(accounts);
      if (name === 'get_crypto_eligibility' || name === 'preview_crypto_order') {
        const result = await robinhoodCryptoPreview((operation, input, requestSignal) => readResult(client, operation, input, requestSignal), accounts, externalRef, args, signal, name === 'preview_crypto_order');
        return redactAccountData(result, numbers);
      }
      const field = tool.accountField ?? 'account_number';
      const number = field === 'rhs_account_number'
        ? bindRobinhoodCryptoAccount(accounts, externalRef).rhsAccountNumber
        : externalRef ? numbers.find(value => createHash('sha256').update(value).digest('hex') === externalRef) : undefined;
      if (tool.account && !number) throw new Error('Account unavailable');
      const result = await readResult(client, name, { ...args, ...(tool.account ? { [field]: number } : {}) }, signal);
      // Includes numbers embedded in provider strings/URLs, not just named fields.
      return redactAccountData(result, [...numbers, ...accountNumbers(result)]);
    });
  }
  /**
   * The one write path, separate from the read allowlist
   * (which still refuses every order tool, so AI and MCP access stay
   * read-only). Review returns the tradability check and Robinhood's review;
   * a refused review throws. Place never throws for a tool error: it hands
   * back what Robinhood answered so the writer can tell a refused request
   * (no order exists) from an unknown outcome. Transport failures propagate.
   */
  async equityOrder(stage: 'review' | 'place', input: unknown, externalRef: string, signal: AbortSignal, refId?: string): Promise<unknown> {
    const order = equityOrderSchema.parse(input);
    if (stage === 'place' && !refId) throw new Error('Placement requires a ref_id');
    return this.withClient(signal, async client => {
      const accounts = await readResult(client, 'get_accounts', {}, signal);
      const numbers = accountNumbers(accounts);
      const number = numbers.find(value => createHash('sha256').update(value).digest('hex') === externalRef);
      const account = parseAccounts(accounts).find(a => a.externalRef === externalRef);
      if (!number || !account?.agenticAllowed) throw new Error('Account unavailable for agentic trading');
      const redact = (value: unknown) => redactAccountData(value, [...numbers, ...accountNumbers(value)]);
      if (stage === 'review') {
        const tradability = await readResult(client, 'get_equity_tradability', { account_number: number, symbols: [order.symbol] }, signal);
        const review = await client.callTool({ name: 'review_equity_order', arguments: { account_number: number, ...order } }, undefined, { signal, timeout: 20_000 });
        if (review.isError) throw new Error(`Robinhood refused the review: ${toolText(redact(review.content))}`);
        return { tradability: redact(tradability), review: redact(toolData(review)) };
      }
      const placed = await client.callTool({ name: 'place_equity_order', arguments: { account_number: number, ...order, ref_id: refId } }, undefined, { signal, timeout: 30_000 });
      const meta = placed._meta as { rh_error_category?: unknown } | undefined;
      return { isError: placed.isError === true, errorCategory: typeof meta?.rh_error_category === 'string' ? meta.rh_error_category : null,
        data: redact(placed.isError ? placed.content : toolData(placed)) } satisfies PlacementResponse;
    });
  }

}

function toolData(raw: unknown): unknown {
  const result = raw as { structuredContent?: unknown; content?: unknown };
  if (result.structuredContent) return result.structuredContent;
  const blocks = Array.isArray(result.content) ? result.content.filter((block: { type?: unknown }) => block.type === 'text') : [];
  const values = blocks.map((block: { text?: unknown }) => { try { return JSON.parse(String(block.text)); } catch { return String(block.text); } });
  return values.length === 1 ? values[0] : values;
}
function toolText(content: unknown): string {
  const text = Array.isArray(content) ? content.map((block: { text?: unknown }) => typeof block?.text === 'string' ? block.text : '').join(' ') : '';
  return text.slice(0, 300) || 'no detail';
}

export async function loadProvider(secrets: SecretStore, ref: string, ownerId: string, connectionId: string, fresh = false) {
  const saved = fresh ? null : await secrets.get(ref);
  const snapshot: StoredOAuth = saved ? JSON.parse(saved) : { version: 1, ownerId, connectionId };
  if (snapshot.version !== 1 || snapshot.ownerId !== ownerId || snapshot.connectionId !== connectionId) throw new Error('Credential binding mismatch');
  return new LocalRobinhoodProvider(snapshot, value => secrets.set(ref, JSON.stringify(value)));
}

export interface DiscoveredAccount {
  externalRef: string; maskedNumber: string; nickname: string | null; accountType: string | null; optionLevel?: string | null; agenticAllowed: boolean;
}
export function parseAccounts(value: unknown): DiscoveredAccount[] {
  const found = new Map<string, DiscoveredAccount>();
  function visit(item: unknown, depth: number) {
    if (depth > 12 || !item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(child => visit(child, depth + 1)); return; }
    const record = item as Record<string, unknown>;
    const number = record.account_number;
    if (typeof number === 'string' && number.length > 0 && number.length <= 128) {
      const externalRef = createHash('sha256').update(number).digest('hex');
      const string = (v: unknown) => typeof v === 'string' ? v.slice(0, 200) : null;
      found.set(externalRef, { externalRef, maskedNumber: `••••${number.slice(-4)}`,
        optionLevel: string(record.option_level), nickname: string(record.nickname), accountType: string(record.type ?? record.brokerage_account_type), agenticAllowed: record.agentic_allowed === true });
    }
    Object.values(record).forEach(child => visit(child, depth + 1));
  }
  visit(value, 0);
  if (found.size > 100) throw new Error('Too many accounts');
  return [...found.values()];
}

async function readResult(client: Client, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  return robinhoodReadCall(name,()=>client.callTool({ name, arguments: args }, undefined, { signal, timeout: 20_000 }));
}
function accountNumbers(value: unknown): string[] {
  const found = new Set<string>();
  function visit(item: unknown, depth: number) {
    if (depth > 30) throw new Error('Response nesting too deep');
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (['account_number', 'rhs_account_number', 'rhc_account_number', 'crypto_account_number'].includes(key) && typeof child === 'string' && child) found.add(child);
      visit(child, depth + 1);
    }
  }
  visit(value, 0); return [...found];
}
export function redactAccountData(value: unknown, numbers: string[]): unknown {
  if (typeof value === 'string') return numbers.reduce((text, number) => text.replaceAll(number, `••••${number.slice(-4)}`), value);
  if (Array.isArray(value)) return value.map(item => redactAccountData(item, numbers));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAccountData(item, numbers)]));
  return value;
}

export function matchesImportedAccountNumber(number:string,externalRef:string,connectionId:string,accountRefHash:string):boolean{
 return createHash('sha256').update(number).digest('hex')===externalRef && createHash('sha256').update(`${connectionId}:${number}`).digest('hex')===accountRefHash;
}
