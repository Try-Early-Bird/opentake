import {createHash,randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import {z} from 'zod';
import type { Transaction } from '@electric-sql/pglite';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import {basketSchema,rebalanceSchema,proposalPayloadSchema,type Verification} from '../../shared/strategies';
import {amount,format,fingerprint,append,instruction} from './ledger';
import {observation,claimed} from './evidence';
import type {NormalizedRobinhoodPosition,NormalizedRobinhoodPortfolio} from '../account-sync/snapshot-normalization';
import {mergeContext} from '../strategies/service';
// Only these authored validation errors may cross the desktop boundary.
export class StrategyImportError extends Error {}
export async function strategyImportResult<T>(run:()=>Promise<T>):Promise<{ok:true;value:T}|{ok:false;message:string}>{
 try{return {ok:true,value:await run()};}
 catch(error){return {ok:false,message:error instanceof StrategyImportError?error.message:'Take import failed. Check the export file and try again.'};}
}
const decimal=z.string().regex(/^-?(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/);
const timestamp=z.string().datetime({offset:true}).transform(s=>new Date(s).toISOString());
const symbol=z.string().regex(/^[A-Z][A-Z0-9.\-/]{0,15}$/);
// publishedAt and openLotId arrived with the second export (migration 43); older exports omit them.
const version=z.object({id:z.uuid(),sequence:z.number().int().positive(),weights:z.array(z.object({symbol,weightPercent:z.number().positive().max(100)}).strict()).min(1).max(50),cashPercent:z.number().min(0).max(100),publishedAt:timestamp.nullable().optional()}).strict();
export const strategyPortfolioExport=z.object({
 format:z.literal('opentake-strategy-portfolio-v1'),exportedAt:timestamp,
 source:z.object({branch:z.literal('development'),provider:z.literal('robinhood_agentic'),accountId:z.uuid(),connectionId:z.uuid(),accountRefHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 strategies:z.array(z.object({id:z.uuid(),title:z.string().min(1).max(120),description:z.string().max(4000),rebalance:z.union([rebalanceSchema.extend({schedule:z.enum(['daily','monthly','quarterly','annual','never'])}),z.enum(['daily','monthly','quarterly','annual','never'])]).nullable().default(null),versions:z.array(version).min(1).max(200)}).strict()).min(1).max(100),
 allocations:z.array(z.object({id:z.uuid(),strategyId:z.uuid(),status:z.enum(['active','paused','diverged']),appliedSequence:z.number().int().nonnegative(),
  entries:z.array(z.object({id:z.uuid(),sequence:z.number().int().positive(),entryType:z.enum(['capital_allocated','capital_released','fill','fee','income','corporate_action','external_adjustment','detachment','correction']),symbol:symbol.nullable(),quantityDelta:decimal.nullable(),cashDelta:decimal.nullable(),unitCost:decimal.nullable(),currency:z.literal('USD'),sourceKind:z.string().min(1).max(100),sourceRef:z.string().min(1).max(512),occurredAt:timestamp,openLotId:z.string().min(1).max(256).nullable().optional()}).strict()).min(1).max(100000),
  history:z.array(z.object({observedAt:timestamp,totalValue:decimal}).strict()).max(10000),
 }).strict()).min(1).max(100),
}).strict();
type Export=z.infer<typeof strategyPortfolioExport>;
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export interface ImportMapping {strategies:Record<string,{strategyId:string;takeId:string;versions:Record<string,string>}>;allocations:Record<string,string>}
function unique(values:unknown[],label:string){if(new Set(values).size!==values.length)throw new StrategyImportError(`Duplicate ${label} in import`);}
function specOf(v:z.infer<typeof version>){
 const bps=(n:number)=>{const v=Math.round(n*100);if(Math.abs(n*100-v)>1e-6)throw new StrategyImportError('Weights must use exact basis points');return v;};
 return basketSchema.parse({schemaVersion:1,kind:'basket',target:{weights:v.weights.map(w=>({instrument:{venue:'robinhood',symbol:w.symbol},bps:bps(w.weightPercent)})),cashBps:bps(v.cashPercent)},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}});
}
export function validateStrategyPortfolio(input:unknown,now=Date.now()){
 const parsed=strategyPortfolioExport.safeParse(input);if(!parsed.success)throw new StrategyImportError('Invalid take portfolio export');
 const v=parsed.data;
 if(Date.parse(v.exportedAt)>now+300000)throw new StrategyImportError('Export is in the future');
 unique(v.strategies.map(s=>s.id),'strategy');unique(v.allocations.map(a=>a.id),'allocation');
 unique(v.strategies.flatMap(s=>s.versions.map(v=>v.id)),'version');unique(v.allocations.flatMap(a=>a.entries.map(e=>e.id)),'entry');
 for(const s of v.strategies){unique(s.versions.map(v=>v.sequence),'version sequence');for(const v of s.versions)specOf(v);}
 for(const a of v.allocations){
  const s=v.strategies.find(s=>s.id===a.strategyId);if(!s||a.appliedSequence>0&&!s.versions.some(v=>v.sequence===a.appliedSequence))throw new StrategyImportError('Missing referenced take version');
  unique(a.entries.map(e=>e.sequence),'ledger sequence');
  // A missing segment of source history must not become an opening balance.
  const entries=[...a.entries].sort((a,b)=>a.sequence-b.sequence);
  if(entries.some((e,i)=>e.sequence!==i+1))throw new StrategyImportError('Incomplete source ledger');
  for(const e of entries){if(e.unitCost!==null&&amount(e.unitCost)<0n||e.quantityDelta!==null&&e.symbol===null||e.quantityDelta===null&&e.cashDelta===null)throw new StrategyImportError('Invalid ledger evidence');if(Date.parse(e.occurredAt)>Date.parse(v.exportedAt))throw new StrategyImportError('Future ledger evidence');}
  unique(a.history.map(h=>h.observedAt),'history timestamp');
  if(a.history.some(h=>Date.parse(h.observedAt)>Date.parse(v.exportedAt)||amount(h.totalValue)<0n))throw new StrategyImportError('Invalid valuation history');
 }
 return v;
}
type AccountProof={externalRef:string;connectionId:string;accountRefHash:string};
async function matchAccount(db:Pick<PGlite,'query'>,v:Export,proof?:AccountProof){
 const rows=(await db.query<{id:string;external_ref:string}>(`SELECT a.id,a.external_ref FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
 WHERE c.venue='robinhood' AND a.selected AND a.available AND a.agentic_allowed`)).rows;
 const matches=rows.filter(a=>proof!==undefined && proof.connectionId===v.source.connectionId && proof.accountRefHash===v.source.accountRefHash && a.external_ref===proof.externalRef);
 if(matches.length!==1)throw new StrategyImportError('Export does not match the selected Robinhood account');return matches[0].id;
}
function balances(a:Export['allocations'][number]){
 let cash=0n;const positions=new Map<string,bigint>();
 for(const e of a.entries){cash+=amount(e.cashDelta??'0');if(e.symbol&&e.quantityDelta!==null)positions.set(e.symbol,(positions.get(e.symbol)??0n)+amount(e.quantityDelta));}
 if([...positions.values()].some(q=>q<0n)||cash<0n)throw new StrategyImportError('Negative source balance requires reconciliation before import');
 return {cash,positions:new Map([...positions].filter(([,q])=>q!==0n))};
}
async function inspect(tx:Transaction,v:Export,accountId:string,now:number){
 const positions=await observation<NormalizedRobinhoodPosition[]>(tx,accountId,'equity_positions');
 const portfolio=await observation<NormalizedRobinhoodPortfolio>(tx,accountId,'portfolio');
 if(!positions||!portfolio||[positions,portfolio].some(o=>Date.parse(o.observedAt)>now||now-Date.parse(o.observedAt)>15*60000))throw new StrategyImportError('Sync fresh account positions and balances before importing');
 if(portfolio.data.currency!=='USD'||portfolio.data.cash===null)throw new StrategyImportError('USD cash evidence required');
 const checkpoints=(await tx.query<{watermark:Date}>(`SELECT watermark FROM account_sync_checkpoints WHERE account_id=$1
  AND resource IN ('portfolio','equity_positions','equity_orders','option_orders') AND discovery_complete`,[accountId])).rows;
 if(checkpoints.length!==4||checkpoints.some(c=>new Date(c.watermark).getTime()>now||now-new Date(c.watermark).getTime()>15*60000))throw new StrategyImportError('Complete fresh account sync required before import');
 // This imports historical ownership into paused allocations, not authority to
 // trade. Existing orders remain in account_orders for reconciliation.
 if((await tx.query(`SELECT 1 FROM account_executions WHERE account_id=$1 AND occurred_at>LEAST($2::timestamptz,$3::timestamptz) LIMIT 1`,[accountId,positions.observedAt,portfolio.observedAt])).rows.length)throw new StrategyImportError('Refresh snapshots after recent fills before importing');
 const bindings=new Map<string,string>();const totals=new Map<string,bigint>();let cash=0n;
 for(const a of v.allocations){const b=balances(a);cash+=b.cash;for(const [symbol,q] of b.positions)totals.set(symbol,(totals.get(symbol)??0n)+q);}
 for(const [symbol,q] of totals){
  const p=positions.data.filter(p=>p.symbol===symbol);
  if(p.length!==1||p[0].currency!=='USD'||p[0].side==='short')throw new StrategyImportError(`Cannot uniquely match ${symbol} to a long USD account instrument`);
  const reserved=(await claimed(tx,accountId,p[0].instrumentRef)).reduce((n,c)=>n+amount(c.quantity),0n);
  if(q+reserved>amount(p[0].quantity))throw new StrategyImportError(`Take claims exceed account shares for ${symbol}`);
  bindings.set(symbol,p[0].instrumentRef);
 }
 const reservedCash=(await claimed(tx,accountId,null)).reduce((n,c)=>n+amount(c.quantity),0n);
 if(cash+reservedCash>amount(portfolio.data.cash))throw new StrategyImportError('Take claims exceed account cash');
 return {bindings,positions,portfolio};
}
export async function importStrategyPortfolio(database:Database,input:unknown,expectedAccountId?:string,now=Date.now(),proof?:AccountProof){
 const v=validateStrategyPortfolio(input,now),{exportedAt,...contents}=v,hash=fingerprint(contents);
 return database.use(db=>db.transaction(async tx=>{
  const accountId=await matchAccount(tx,v,proof);if(expectedAccountId&&accountId!==expectedAccountId)throw new StrategyImportError('Selected account changed');
  const old=(await tx.query<{request_hash:string;source_data:Export;mapping:ImportMapping}>(`SELECT request_hash,source_data,mapping FROM strategy_portfolio_imports WHERE account_id=$1`,[accountId])).rows[0];
  // A newer export of an imported account only adds what the first one lacked (hosted's lot ids and publish days)
  // to the takes already imported; ownership, balances and history stay as imported.
  if(old&&old.request_hash!==hash&&!v.strategies.some(s=>s.versions.some(x=>x.publishedAt))&&!v.allocations.some(x=>x.entries.some(e=>e.openLotId)))
   throw new StrategyImportError('Source portfolio changed since import; reconcile it rather than overwrite local ownership');
  if(old&&old.request_hash!==hash){const updated=await recordSourceDetails(tx,accountId,v,old.mapping,old.source_data);return {imported:0,skipped:v.allocations.length,updated};}
  if(old){if(old.request_hash!==hash)throw new StrategyImportError('Source portfolio changed since import; reconcile it rather than overwrite local ownership');return {imported:0,skipped:v.allocations.length};}
  const evidence=await inspect(tx,v,accountId,now),at=new Date(now).toISOString();
  const owner=(await tx.query<{id:string}>('SELECT id FROM local_owners LIMIT 1')).rows[0].id;
  const mapping:ImportMapping={strategies:{},allocations:{}};
  for(const s of v.strategies){
   const strategyId=randomUUID(),takeId=randomUUID(),versions:Record<string,string>={};mapping.strategies[s.id]={strategyId,takeId,versions};
   await tx.query('INSERT INTO strategies(id,owner_id) VALUES($1,$2)',[strategyId,owner]);
   await tx.query(`INSERT INTO takes(id,owner_id,title,selection,strategy_id) VALUES($1,$2,$3,$4,$5)`,[takeId,owner,s.title,JSON.stringify({provider:'claude',model:'default'}),strategyId]);
   await mergeContext(tx,takeId,[`robinhood:${accountId}`]);
   let previous:string|null=null,baseVersion:string|null=null;
   for(const [index,vv] of [...s.versions].sort((a,b)=>a.sequence-b.sequence).entries()){
    const spec=specOf(vv),versionId=randomUUID(),proposalId=randomUUID();
    if(s.rebalance&&typeof s.rebalance==='object')spec.rebalance={...s.rebalance,schedule:s.rebalance.schedule};
    else if(typeof s.rebalance==='string')spec.rebalance.schedule=s.rebalance;versions[vv.id]=versionId;
    const payload=proposalPayloadSchema.parse({metadata:{title:s.title,description:s.description,rationale:'Imported from an existing strategy. Automation is not active.',holdings:[]},spec,unsupportedRequests:[]});
    const verification:Verification={policy:'personal_basket',version:1,checkedAt:at,accountRef:accountId,results:spec.target.weights.map(w=>({instrument:w.instrument,state:'unknown',tradable:null,fractional:null,reason:'Imported definition; verify before future execution.'}))};
    await tx.query(`INSERT INTO strategy_proposals(id,strategy_id,owner_id,target_take_id,source_take_id,revision,base_version_id,previous_revision_id,producer,producer_identity,payload,platform_context,verification,operation_id,request_hash,created_at)
     VALUES($1,$2,$3,$4,$4,$5,$6,$7,'human',$8,$9,$10,$11,$12,$13,$14)`,[proposalId,strategyId,owner,takeId,index+1,baseVersion,previous,JSON.stringify({ownerId:owner,source:'development_import',sourceVersionId:vv.id}),JSON.stringify(payload),JSON.stringify([`robinhood:${accountId}`]),JSON.stringify(verification),randomUUID(),fingerprint(vv),at]);
    await tx.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification,source_proposal_id,created_at)
     VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10)`,[versionId,strategyId,owner,index+1,JSON.stringify(payload.metadata),JSON.stringify(spec),JSON.stringify({acceptedBy:owner,source:'development_import',sourceVersionId:vv.id,sourceSequence:vv.sequence}),JSON.stringify(verification),proposalId,at]);
    previous=proposalId;baseVersion=versionId;
   }
   await tx.query(`UPDATE strategies SET status='committed',current_version_id=$2,draft_revision_id=$3 WHERE id=$1`,[strategyId,baseVersion,previous]);
  }
  for(const a of v.allocations){
   const s=v.strategies.find(s=>s.id===a.strategyId)!,map=mapping.strategies[s.id];
   const applied=s.versions.find(v=>v.sequence===a.appliedSequence)??[...s.versions].sort((a,b)=>b.sequence-a.sequence)[0];
   const id=randomUUID();mapping.allocations[a.id]=id;
   // Hosted's allocation_value: the net capital put in, from the source ledger (withdrawals settle against it).
   const capital=a.entries.filter(e=>e.entryType==='capital_allocated'||e.entryType==='capital_released').reduce((n,e)=>n+amount(e.cashDelta??'0'),0n);
   await tx.query(`INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,restore_required,allocation_value,created_at,updated_at)
    VALUES($1,$2,$3,$4,'USD','paused',true,$6,$5,$5)`,[id,accountId,map.strategyId,map.versions[applied.id],at,format(capital<0n?0n:capital)]);
   const transactionId=await instruction(tx,{allocationId:id,kind:'reconciliation',cause:`import:${a.id}`,pendingReason:'import_reconciliation_required'},at);
   // Opening claims reference the complete immutable source ledger below. They
   // are not new contributions/fills and do not fabricate cost basis or lots.
   const b=balances(a);
   await append(tx,{allocationId:id,transactionId,entryType:'external_adjustment',cashDelta:format(b.cash),cause:`import:${a.id}:cash`,sourceKind:'development_import',sourceRef:a.id,occurredAt:at},at);
   for(const [symbol,q] of b.positions)await append(tx,{allocationId:id,transactionId,entryType:'external_adjustment',instrumentRef:evidence.bindings.get(symbol)!,symbol,quantityDelta:format(q),cause:`import:${a.id}:${symbol}`,sourceKind:'development_import',sourceRef:a.id,occurredAt:at},at);
   for(const o of [evidence.positions,evidence.portfolio])await tx.query(`INSERT INTO strategy_evidence_pins(allocation_id,observation_id,reason) VALUES($1,$2,'import')`,[id,o.id]);
  }
  await recordSourceDetails(tx,accountId,v,mapping,v);
  await tx.query(`INSERT INTO strategy_portfolio_imports(account_id,source_account_id,source_branch,request_hash,source_data,mapping) VALUES($1,$2,'development',$3,$4,$5)`,[accountId,v.source.accountId,hash,JSON.stringify(v),JSON.stringify(mapping)]);
  return {imported:v.allocations.length,skipped:0};
 }));
}
/**
 * Hosted's publish day for each imported version and hosted's lot id for each
 * imported buy, for versions and entries the account's import already holds
 * (`known`): the model and planner date versions from the publish day, and
 * the lot binding pass (import-lots.ts) binds those lots exactly.
 */
async function recordSourceDetails(tx:Pick<Transaction,'query'>,accountId:string,v:Export,mapping:ImportMapping,known:Export):Promise<{publishDays:number;lotIds:number}>{
 const knownVersions=new Set(known.strategies.flatMap(s=>s.versions.map(x=>x.id))),knownEntries=new Set(known.allocations.flatMap(a=>a.entries.map(e=>e.id)));
 let publishDays=0,lotIds=0;
 for(const s of v.strategies)for(const x of s.versions){
  const local=mapping.strategies[s.id]?.versions[x.id];if(!local||!x.publishedAt||!knownVersions.has(x.id))continue;
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(x.publishedAt));
  publishDays+=(await tx.query(`INSERT INTO strategy_version_effective_dates(version_id,effective_on,source) VALUES($1,$2,'import') ON CONFLICT DO NOTHING`,[local,day])).affectedRows??0;
 }
 for(const a of v.allocations){if(!mapping.allocations[a.id])continue;for(const e of a.entries){
  if(!e.openLotId||!knownEntries.has(e.id))continue;
  lotIds+=(await tx.query(`INSERT INTO strategy_import_lot_ids(account_id,source_entry_id,open_lot_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[accountId,e.id,e.openLotId])).affectedRows??0;
 }}
 return {publishDays,lotIds};
}
export function createStrategyPortfolioImport(database:Database,verifyAccount:(connectionId:string,accountRefHash:string)=>Promise<string|null>){
 let pending:{token:string;accountId:string;value:Export;expires:number;proof:AccountProof}|undefined;
 return {
  async prepare(path:unknown){
   pending=undefined;if(typeof path!=='string')throw new StrategyImportError('Choose a take export');
   const file=await open(path,'r');let input:unknown;
   try{const stat=await file.stat();if(!stat.isFile()||stat.size>25*1024*1024)throw new StrategyImportError('Choose a JSON export smaller than 25 MB');
    const buffer=Buffer.alloc(25*1024*1024+1);let size=0;while(size<buffer.length){const r=await file.read(buffer,size,buffer.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}if(size===buffer.length)throw new StrategyImportError('Export too large');input=JSON.parse(buffer.toString('utf8',0,size));
   }finally{await file.close();}
   const value=validateStrategyPortfolio(input);
   const externalRef=await verifyAccount(value.source.connectionId,value.source.accountRefHash);
   if(!externalRef)throw new StrategyImportError('Export does not match the selected Robinhood account');
   const proof={externalRef,connectionId:value.source.connectionId,accountRefHash:value.source.accountRefHash};
   const accountId=await database.use(db=>matchAccount(db,value,proof));
   await database.use(db=>db.transaction(async tx=>{if(!(await tx.query('SELECT 1 FROM strategy_portfolio_imports WHERE account_id=$1',[accountId])).rows.length)await inspect(tx,value,accountId,Date.now());}));
   pending={token:randomUUID(),accountId,value,proof,expires:Date.now()+300000};
   const update=await database.use(async db=>(await db.query('SELECT 1 FROM strategy_portfolio_imports WHERE account_id=$1',[accountId])).rows.length>0);
   return {token:pending.token,update,strategies:value.strategies.length,allocations:value.allocations.length,entries:value.allocations.reduce((n,a)=>n+a.entries.length,0),
    publishDays:value.strategies.reduce((n,s)=>n+s.versions.filter(x=>x.publishedAt).length,0),lotIds:value.allocations.reduce((n,a)=>n+a.entries.filter(e=>e.openLotId).length,0)};
  },
  async commit(token:unknown){const chosen=pending;pending=undefined;if(!chosen||token!==chosen.token||chosen.expires<Date.now())throw new StrategyImportError('Import expired');return importStrategyPortfolio(database,chosen.value,chosen.accountId,Date.now(),chosen.proof);},
 };
}
