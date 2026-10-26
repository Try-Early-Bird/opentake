import {brokerResponseDetails} from '../shared/broker-response';
import {brokerOperations,brokerResultFields,brokerStates,brokerErrors} from '../shared/broker-diagnostics';
import {priceOperations,priceErrors} from '../shared/price-diagnostics';
import {rebalanceReasons, type DiagnosticPage, type DiagnosticRow} from '../shared/diagnostics';
import {createInterface} from 'node:readline';
import {cleanDiagnosticLogs,diagnosticFiles,logRetention} from './diagnostic-retention';
import { appendFileSync, mkdirSync, createReadStream } from 'node:fs';
import { join,dirname,basename } from 'node:path';

export type DiagnosticEvent =
  | 'app.start' | 'app.ready' | 'app.quit' | 'app.fatal'
  | 'database.ready' | 'database.failed' | 'database.closed' | 'database.close_failed'
  | 'background.failed' | 'background.completed' | 'venue.queue'
  | 'broker.called' | 'broker.returned' | 'broker.failed'
  | 'rebalance.decision'
  | 'execution.loop' | 'execution.account' | 'execution.event_loop'
  | 'renderer.failed' | 'renderer.gone' | 'process.gone';

// No free-form messages, stacks, URLs or paths; responses use a bounded field allowlist.
// Rebalance events allow a local Take UUID for navigation.
// Execution events name a fixed worker or operation and carry only timings.
export const executionWorkers=['rule-trades','mixed','coinbase-scheduler','robinhood-scheduler'] as const;
const executionKinds=['failed','timed_out','slow','stuck','waited','held_past_deadline'];
const executionLabels=['coinbase orders','coinbase rebalance','rule trade','robinhood placement','robinhood order'];
// Unknown fields are discarded at runtime, not just by TypeScript.
export function createDiagnostics(directory: string, version: string) {
  let lastCleanup=0;
  const logs=dirname(directory);
  let warned = false;
  return {
    record(event: DiagnosticEvent, fields: Record<string, unknown> = {}): void {
      const safe: Record<string, unknown> = {};
      for (const key of [...brokerResultFields, 'exitCode', 'queued', 'completed', 'cancelled', 'failed', 'timedOut', 'totalWaitMs', 'maxWaitMs', 'coalesced', 'durationMs', 'deadlineMs', 'waitMs', 'heldMs', 'delayP99Ms', 'delayMaxMs']) {
        const value = fields[key];
        if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      }
      for(const key of ['callId','accountId'])if(typeof fields[key]==='string'&&/^[a-f0-9-]{36}$/i.test(fields[key] as string))safe[key]=fields[key];
      for(const key of ['accepted','hasMore'])if(typeof fields[key]==='boolean')safe[key]=fields[key];
      if(brokerStates.includes(fields.responseState as never))safe.responseState=fields.responseState;
      if (typeof fields.packaged === 'boolean') safe.packaged = fields.packaged;
      if(typeof fields.stage==='string'&&['prices','execution','share_events','instructions','redemptions','closures','lots','import_lots','investment','rule_trades'].includes(fields.stage))safe.stage=fields.stage;
      if(event==='execution.loop'||event==='execution.account'){
        if(executionWorkers.includes(fields.worker as never))safe.worker=fields.worker;
        if(executionKinds.includes(fields.kind as never))safe.kind=fields.kind;
        if(executionLabels.includes(fields.label as never))safe.label=fields.label;
      }
      if(event==='rebalance.decision'){
        if(typeof fields.reason==='string'&&Object.hasOwn(rebalanceReasons,fields.reason))safe.reason=fields.reason;
        if(typeof fields.takeId==='string'&&/^[a-f0-9-]{36}$/i.test(fields.takeId))safe.takeId=fields.takeId;
      }
      if(fields.venue==='robinhood'||fields.venue==='coinbase')safe.venue=fields.venue;
      if([...priceOperations,...brokerOperations].includes(fields.operation as never))safe.operation=fields.operation;
      if(typeof fields.errorCode==='string'&&(Object.hasOwn(priceErrors,fields.errorCode)||brokerErrors.includes(fields.errorCode as never)))safe.errorCode=fields.errorCode;
      if(Array.isArray(fields.symbols))safe.symbols=fields.symbols.filter((s):s is string=>typeof s==='string'&&/^[A-Z][A-Z0-9.-]{0,11}$/.test(s)).slice(0,50);
      if(event==='broker.called'&&fields.request!==undefined)safe.request=brokerResponseDetails(fields.request);
      if(event==='broker.returned'&&fields.response!==undefined)safe.response=brokerResponseDetails(fields.response);
      const reason = fields.reason;
      if (typeof reason === 'string' && ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'].includes(reason)) {
        safe.reason = reason;
      }
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const line = JSON.stringify({ time: new Date().toISOString(), event, version,
          platform: process.platform, arch: process.arch, ...safe }) + '\n';
        if(Date.now()-lastCleanup>=3600000){cleanDiagnosticLogs(logs,Date.now(),[basename(directory)]);lastCleanup=Date.now();}
        const file=join(directory,`app.${new Date().toISOString().slice(0,10)}.jsonl`);
        appendFileSync(file, line, { mode: 0o600 });
      } catch {
        // Logging must never take down the app or leak raw filesystem errors.
        if (!warned) console.warn('Local diagnostics unavailable.');
        warned = true;
      }
    },
  };
}

/** Only fixed diagnostic files; never expose arbitrary profile files or raw payloads. */
export async function readDiagnostics(profile:string):Promise<DiagnosticPage>{
 const rows:DiagnosticRow[]=[];let truncated=false;
 const logs=join(profile,'logs'),cutoff=new Date(Date.now()-logRetention(logs)*86400000).toISOString().slice(0,10);
 for(const source of ['host','desktop'])for(const name of diagnosticFiles(join(logs,source)).sort().reverse()){
  if(rows.filter(row=>row.source===source).length>=2000){truncated=true;continue;}
  try{
   const file=join(logs,source,name);
   const stream=createInterface({input:createReadStream(file),crlfDelay:Infinity});
   for await(const line of stream){
    try{
     const data=JSON.parse(line);
     if(typeof data.time!=='string'||!Number.isFinite(Date.parse(data.time))||typeof data.event!=='string'||!/^[a-z_.]+$/.test(data.event))continue;
     if(new Date(data.time).toISOString().slice(0,10)<cutoff)continue;
     const details:DiagnosticRow['details']={};
     for(const key of [...brokerResultFields,'exitCode','queued','completed','cancelled','failed','timedOut','totalWaitMs','maxWaitMs','coalesced'])if(typeof data[key]==='number'&&Number.isFinite(data[key]))details[key]=data[key];
     for(const key of ['callId','accountId'])if(typeof data[key]==='string'&&/^[a-f0-9-]{36}$/i.test(data[key]))details[key]=data[key];
     for(const key of ['accepted','hasMore'])if(typeof data[key]==='boolean')details[key]=data[key];
     if(brokerStates.includes(data.responseState))details.responseState=data.responseState;
     const reason=typeof data.reason==='string'&&(Object.hasOwn(rebalanceReasons,data.reason)||['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure'].includes(data.reason))?data.reason:undefined;
     const takeId=typeof data.takeId==='string'&&/^[a-f0-9-]{36}$/i.test(data.takeId)?data.takeId:undefined;
     const stage=typeof data.stage==='string'&&['prices','execution','share_events','instructions','redemptions','closures','lots','import_lots'].includes(data.stage)?data.stage:undefined;
     const venue=data.venue==='robinhood'||data.venue==='coinbase'?data.venue:undefined;
     const operation=[...priceOperations,...brokerOperations].includes(data.operation)?data.operation:undefined;
     const errorCode=typeof data.errorCode==='string'&&(Object.hasOwn(priceErrors,data.errorCode)||brokerErrors.includes(data.errorCode))?data.errorCode:undefined;
     const symbols=Array.isArray(data.symbols)?data.symbols.filter((s:unknown)=>typeof s==='string'&&/^[A-Z][A-Z0-9.-]{0,11}$/.test(s)).slice(0,50):undefined;
     rows.push({request:data.event==='broker.called'&&data.request!==undefined?brokerResponseDetails(data.request):undefined,response:data.event==='broker.returned'&&data.response!==undefined?brokerResponseDetails(data.response):undefined,venue,operation,errorCode,symbols,time:data.time,event:data.event,source,reason,takeId,stage,details});
     if(rows.length>2500){truncated=true;rows.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));rows.length=2000;}
    }catch{/* Ignore incomplete final lines and malformed records. */}
   }
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Could not read local diagnostics.');}
 }
 rows.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
 return {rows:rows.slice(0,2000),truncated:truncated||rows.length>2000};
}
