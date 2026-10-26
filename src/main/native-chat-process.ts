import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { atomicPrivateWrite } from './private-files';
import { join, dirname, delimiter } from 'node:path';
import type { CliCommand } from './ai-runtime';
import type { RunInput } from './take-runtime';
import { createRunBudget } from './run-budget';

// Versions whose native history (Codex thread/inject_items, OpenCode session import) was
// verified by tests/chat/unit/native-cli-compatibility.test.ts. Other versions still chat:
// they try native history and fall back to quoted context if it fails (see historyModes).
export const nativeChatVersions = { chatgpt: ['0.144.3'], opencode: ['1.14.25'] } as const;
export type NativeProvider = keyof typeof nativeChatVersions;
export class AdapterError extends Error {}
export function protocolError(provider: string): AdapterError {
  return new AdapterError(`${provider} returned an unsupported chat protocol. Update Opentake's adapter before retrying. The response was not automatically retried.`);
}
export function isolatedChatEnv(home: string, command: CliCommand): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH','SystemRoot','WINDIR','TMPDIR','TEMP','TMP','LANG']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, PATH: dirname(command.executable) + delimiter + (env.PATH ?? ''), HOME:home, USERPROFILE:home,
    CODEX_HOME:join(home,'.codex'), XDG_CONFIG_HOME:join(home,'config'), XDG_DATA_HOME:join(home,'data'), XDG_CACHE_HOME:join(home,'cache'),
    ELECTRON_RUN_AS_NODE:'1', DISABLE_AUTOUPDATER:'1', DISABLE_TELEMETRY:'1',
    OPENCODE_DISABLE_AUTOUPDATE:'1', OPENCODE_DISABLE_DEFAULT_PLUGINS:'1', OPENCODE_DISABLE_PROJECT_CONFIG:'1',
    OPENCODE_DISABLE_CLAUDE_CODE:'1', OPENCODE_DISABLE_EXTERNAL_SKILLS:'1', OPENCODE_DISABLE_LSP_DOWNLOAD:'1',
    OPENCODE_DISABLE_MODELS_FETCH:'1', OPENCODE_DISABLE_AUTOCOMPACT:'1', OPENCODE_DISABLE_PRUNE:'1' };
}
export interface CliVersion { version: string | null; verified: boolean }
/**
 * The installed CLI's version, for the audit and for choosing native history. CLIs
 * update themselves; an unknown or unreadable version never blocks a response.
 */
export async function nativeChatVersion(provider: NativeProvider, command: CliCommand, home: string, signal: AbortSignal): Promise<CliVersion> {
  const output = await new Promise<string>(resolve => execFile(command.executable,[...command.args,'--version'],
    {cwd:home,env:isolatedChatEnv(home,command),signal,timeout:10000,maxBuffer:4096},
    (error,stdout)=>resolve(error?'':stdout.trim())));
  const version = output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  return { version, verified: version !== null && (nativeChatVersions[provider] as readonly string[]).includes(version) };
}
type HistoryVerdicts = Record<string, Record<string, 'baseline'>>;
/**
 * Per provider and CLI version, whether native history failed and follow-ups should send
 * earlier turns as quoted context instead. Native history is tried first on every version;
 * a failure (before any inference) is remembered so later turns skip it.
 */
export function historyModes(profile: string) {
  const file = join(profile, 'chat-history-modes.json');
  const load = async (): Promise<HistoryVerdicts> => { try { return JSON.parse(await readFile(file, 'utf8')) as HistoryVerdicts; } catch { return {}; } };
  const key = (cli: CliVersion) => cli.version ?? 'unknown';
  return {
    async native(provider: string, cli: CliVersion): Promise<boolean> { return (await load())[provider]?.[key(cli)] !== 'baseline'; },
    async markBaseline(provider: string, cli: CliVersion): Promise<void> {
      const verdicts = await load(); verdicts[provider] = { ...(verdicts[provider] ?? {}), [key(cli)]: 'baseline' };
      await atomicPrivateWrite(file, Buffer.from(JSON.stringify(verdicts, null, 1)));
    },
  };
}
export interface NativeDependencies { launch?: typeof spawn; command?: () => CliCommand; version?: typeof nativeChatVersion }
export async function withNativeChat(provider:NativeProvider, profile:string, input:RunInput, command:CliCommand,
  work:(home:string, env:NodeJS.ProcessEnv, input:RunInput, cli:CliVersion)=>Promise<void>, versionFor=nativeChatVersion) {
  if(!input.gateway)throw new AdapterError('Chat gateway unavailable.');
  input.signal.throwIfAborted();
  const root=join(profile,'chat-temporary');await mkdir(root,{recursive:true,mode:0o700});
  const home=await mkdtemp(join(root,`${provider}-`));
  const budget=input.managedBudget?undefined:createRunBudget(input.signal);
  const run={...input,signal:budget?.signal??input.signal};
  try {
    const cli=await versionFor(provider,command,home,run.signal);
    await input.audit?.({kind:'provider.lifecycle',payload:{provider,cliVersion:cli.version,cliVerified:cli.verified,adapterVersion:'1'}});
    await work(home,isolatedChatEnv(home,command),run,cli);
  } catch(error) {
    if(run.signal.aborted)throw run.signal.reason instanceof Error && run.signal.reason.name!=='AbortError'?run.signal.reason:new AdapterError('Response stopped.');
    if(error instanceof AdapterError)throw error;
    throw new AdapterError(`${provider === 'chatgpt' ? 'Codex' : 'OpenCode'} could not complete the response. Check the connection and usage limits. No automatic retry was made.`);
  } finally { budget?.finish();await rm(home,{recursive:true,force:true}); }
}
// Always reap the child before removing its private home; kill its process group
// so an MCP bridge cannot outlive the response on Unix.
export function manageChild(child:ChildProcess, signal:AbortSignal) {
  let closed=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const kill=(value:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,value);else child.kill(value);}catch{}};
  const stop=()=>{if(closed||timer)return;kill('SIGTERM');timer=setTimeout(()=>kill('SIGKILL'),1000);};
  const done=new Promise<void>(resolve=>child.once('close',()=>{closed=true;clearTimeout(timer);signal.removeEventListener('abort',stop);resolve();}));
  child.on('error',()=>{});child.stderr?.on('data',()=>{});child.stdin?.on('error',()=>{});
  signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  return {stop,done,close:async()=>{stop();await done;}};
}
export function secretCleaner(values:string[]) {
  const bound=values.filter(Boolean).sort((a,b)=>b.length-a.length);
  return Object.assign((text:string)=>bound.reduce((s,value)=>s.split(value).join('[redacted]'),text),{holdback:Math.max(0,...bound.map(value=>value.length))});
}
export function nativeCapture(input:RunInput, clean:((s:string)=>string)&{holdback?:number}) {
  let replayBytes=0;
  const streams=new Map<string,{raw:string;emitted:string}>();
  return {
    async audit(kind:string,payload:Record<string,unknown>) {
      const original=JSON.stringify(payload), safe=clean(original);
      await input.audit?.({kind,payload:JSON.parse(safe),...(original!==safe?{status:'redacted' as const}: {})});
    },
    replay(value:Parameters<NonNullable<RunInput['replay']>>[0]) {
      const safe=clean(JSON.stringify(value));replayBytes+=Buffer.byteLength(safe);
      if(replayBytes>512000)throw new AdapterError('Tool history exceeded this response’s size limit. Start a new take.');
      input.replay?.(JSON.parse(safe));
    },
    stream(id:string,delta:string) {
      const state=streams.get(id)??{raw:'',emitted:''};state.raw+=delta;
      const safe=clean(state.raw),end=Math.max(0,safe.length-(clean.holdback??0));
      if(!safe.startsWith(state.emitted))throw new AdapterError('Provider text changed during streaming. Response stopped.');
      if(end>state.emitted.length){input.text(safe.slice(state.emitted.length,end));state.emitted=safe.slice(0,end);}
      streams.set(id,state);
    },
    completeText(id:string,value:string) {
      const state=streams.get(id),safe=clean(value);
      if(state&&(!value.startsWith(state.raw)||!safe.startsWith(state.emitted)))throw new AdapterError('Provider text changed during streaming. Response stopped.');
      input.text(safe.slice(state?.emitted.length??0));streams.delete(id);
    },
    text(value:string){input.text(clean(value));},
  };
}

export function nativeFailure(provider:string,error:unknown):AdapterError {
  const e=error&&typeof error==='object'?error as Record<string,unknown>:{};
  const data=e.data&&typeof e.data==='object'?e.data as Record<string,unknown>:{};
  const info=e.codexErrorInfo;
  const status=data.statusCode??e.statusCode;
  if(status===401||status===403||e.name==='ProviderAuthError'||info==='unauthorized')return new AdapterError(`${provider} sign-in or model access was rejected. Reconnect in Settings and check model access.`);
  if(status===402||status===429||info==='usageLimitExceeded')return new AdapterError(`${provider} reached a usage or billing limit. Check your plan or credits before retrying.`);
  if(status===404||e.name==='ModelNotFoundError')return new AdapterError(`${provider} model is unavailable. Refresh models and choose another model.`);
  if(info==='contextWindowExceeded'||e.name==='ContextOverflowError')return new AdapterError(`${provider} context limit reached. Start a new take.`);
  return new AdapterError(`${provider} stopped before completing. Check connection and usage limits. No automatic retry was made.`);
}
