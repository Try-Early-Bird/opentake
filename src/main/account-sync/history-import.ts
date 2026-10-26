import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';

const decimal = z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/);
const timestamp = z.string().datetime({offset:true}).transform(s => new Date(s).toISOString());
const observation = z.object({ id:z.uuid(), observedAt:timestamp, totalValue:decimal,
 cash:decimal.nullable(), buyingPower:decimal.nullable(), currency:z.string().regex(/^[A-Z]{3}$/) }).strict();
export const portfolioHistoryExport = z.object({
 format:z.literal('opentake-portfolio-history-v1'), exportedAt:timestamp,
 source:z.object({branch:z.literal('development'),provider:z.literal('robinhood_agentic'),accountId:z.uuid(),connectionId:z.uuid(),accountRefHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 observations:z.array(observation).min(1).max(100000),
}).strict();
type Export = z.infer<typeof portfolioHistoryExport>;
type Database = ReturnType<typeof createDatabaseLifecycle>;
const LIMIT = 25 * 1024 * 1024;

// Match the hosted hash scheme without disclosing the local provider account number.
async function matchingAccount(db: {query<T>(sql:string,args?:unknown[]):Promise<{rows:T[]}>}, value:Export) {
 const accounts = (await db.query<{id:string;external_ref:string}>(`SELECT a.id,a.external_ref FROM linked_accounts a
  JOIN platform_connections c ON c.id=a.connection_id WHERE c.venue='robinhood' AND a.selected AND a.available AND a.agentic_allowed`)).rows;
 const matched = accounts.filter(a => createHash('sha256').update(`${value.source.connectionId}:${a.external_ref}`).digest('hex') === value.source.accountRefHash);
 if (matched.length !== 1) throw new Error('This history does not match the selected Robinhood account. Select the matching account in Connections.');
 return matched[0].id;
}
export async function importPortfolioHistory(database:Database, input:unknown, expectedAccountId?:string, now=Date.now()) {
 const parsed = portfolioHistoryExport.safeParse(input);
 if (!parsed.success) throw new Error('Invalid portfolio history export.');
 const value = parsed.data;
 if (Date.parse(value.exportedAt)>now+300000 || value.observations.some(o=>Date.parse(o.observedAt)>Date.parse(value.exportedAt))) throw new Error('History contains future observations.');
 if (new Set(value.observations.map(o=>o.id)).size !== value.observations.length) throw new Error('History contains duplicate source identifiers.');
 return database.use(db=>db.transaction(async tx=>{
  const accountId=await matchingAccount(tx,value);
  if (expectedAccountId && accountId!==expectedAccountId) throw new Error('The selected account changed. Choose the history file again.');
  const rows=value.observations.map(({id,observedAt,...data})=>({id,observedAt,data}));
  const conflict = await tx.query(`SELECT 1 FROM portfolio_history_imports h
    JOIN jsonb_array_elements($3::jsonb) item ON h.source_snapshot_id=(item->>'id')::uuid
    WHERE h.account_id=$1 AND h.source_branch='development' AND h.source_account_id=$2
      AND (h.observed_at<>(item->>'observedAt')::timestamptz OR h.data<>item->'data') LIMIT 1`,
    [accountId,value.source.accountId,JSON.stringify(rows)]);
  if (conflict.rows.length) throw new Error('Previously imported source observations changed. Nothing was imported.');
  const result=await tx.query(`INSERT INTO portfolio_history_imports(account_id,source_branch,source_account_id,source_snapshot_id,observed_at,data)
    SELECT $1,'development',$2,(item->>'id')::uuid,(item->>'observedAt')::timestamptz,item->'data'
    FROM jsonb_array_elements($3::jsonb) item ON CONFLICT DO NOTHING RETURNING source_snapshot_id`,[accountId,value.source.accountId,JSON.stringify(rows)]);
  return {imported:result.rows.length,skipped:rows.length-result.rows.length};
 }));
}
export function createPortfolioHistoryImport(database:Database) {
 let pending: {token:string;value:Export;accountId:string;expires:number} | undefined;
 return {
  async prepare(path:unknown) {
   pending=undefined;
   if(typeof path!=='string')throw new Error('Choose a history export.');
   const file=await open(path,'r'); let input:unknown;
   try {
    const info=await file.stat();
    if(!info.isFile()||info.size>LIMIT)throw new Error('History export must be a JSON file smaller than 25 MB.');
    const buffer=Buffer.alloc(LIMIT+1); let size=0;
    while(size<buffer.length){const chunk=await file.read(buffer,size,buffer.length-size,null);if(!chunk.bytesRead)break;size+=chunk.bytesRead;}
    if(size>LIMIT)throw new Error('History export is too large.');
    try{input=JSON.parse(buffer.toString('utf8',0,size));}catch{throw new Error('Invalid portfolio history JSON.');}
   } finally {await file.close();}
   const parsed=portfolioHistoryExport.safeParse(input);
   if(!parsed.success)throw new Error('Invalid portfolio history export.');
   const value=parsed.data;
   const accountId=await database.use(db=>matchingAccount(db,value));
   const dates=value.observations.map(o=>o.observedAt).sort();
   pending={token:randomUUID(),value,accountId,expires:Date.now()+300000};
   return {token:pending.token,count:dates.length,earliest:dates[0],latest:dates.at(-1)!};
  },
  async commit(token:unknown){
   const selected=pending;pending=undefined;
   if(!selected||selected.token!==token||selected.expires<Date.now())throw new Error('History import expired. Choose the file again.');
   return importPortfolioHistory(database,selected.value,selected.accountId);
  },
 };
}
