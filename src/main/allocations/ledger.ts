import { createHash, randomUUID } from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import { decimalToScaledInteger, scaledIntegerToDecimal } from './decimal';

export type InstructionKind = 'investment' | 'contribution' | 'cash_release' | 'version_change' | 'rebalance' | 'redemption' | 'exit' | 'detachment' | 'reconciliation' | 'reinvestment' | 'corporate_action' | 'attribution_release';
export type EntryKind = 'capital_allocated' | 'capital_released' | 'fill' | 'fee' | 'reinvestment' | 'corporate_action' | 'detachment' | 'external_adjustment' | 'reversal';
export interface Allocation {
 id: string; account_id: string; strategy_id: string; applied_version_id: string;
 status: 'active' | 'paused' | 'diverged' | 'detached' | 'closed'; currency: 'USD'; restore_required: boolean;
}
export const unreleased = "('active','paused','diverged')";
export function amount(value: string): bigint {
 if (!/^-?(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/.test(value)) throw new Error('Invalid financial decimal');
 return value.startsWith('-') ? -decimalToScaledInteger(value.slice(1)) : decimalToScaledInteger(value);
}
export function format(value: bigint): string {
 const result = value < 0n ? `-${scaledIntegerToDecimal(-value)}` : scaledIntegerToDecimal(value);
 amount(result); return result;
}
export function positive(value: string): bigint {
 const result = amount(value); if (result <= 0n) throw new Error('Amount must be positive'); return result;
}
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
 return value;
}
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function key(value: string): string {
 if (!value || value.length > 512) throw new Error('Invalid idempotency key'); return value;
}
export async function allocation(tx: Transaction, id: string): Promise<Allocation> {
 const result = (await tx.query<Allocation>('SELECT * FROM strategy_allocations WHERE id=$1',[id])).rows[0];
 if (!result) throw new Error('Allocation not found'); return result;
}
export async function holdings(tx: Transaction, id: string, at?: string) {
 const rows = (await tx.query<{instrumentRef:string|null;symbol:string|null;quantity:string;cash:string}>(`
 SELECT instrument_ref AS "instrumentRef", max(symbol) AS symbol,
 coalesce(sum(quantity_delta),0)::text AS quantity, sum(cash_delta)::text AS cash
 FROM strategy_attribution_entries WHERE allocation_id=$1 AND ($2::timestamptz IS NULL OR occurred_at<=$2)
 GROUP BY instrument_ref`,[id,at??null])).rows;
 return { cash:format(rows.reduce((sum,row)=>sum+amount(row.cash),0n)),
  positions:rows.filter(row=>row.instrumentRef!==null).map(row=>({instrumentRef:row.instrumentRef!,symbol:row.symbol,quantity:format(amount(row.quantity))})) };
}
export async function instruction(tx: Transaction, input: {allocationId:string;kind:InstructionKind;cause:string;requestedAmount?:string;pendingReason?:string}, now:string):Promise<string> {
 key(input.cause); if(input.requestedAmount!==undefined)positive(input.requestedAmount);
 const hash=fingerprint(input);
 const old=(await tx.query<{id:string;request_hash:string}>(`SELECT id,request_hash FROM strategy_allocation_transactions WHERE allocation_id=$1 AND idempotency_key=$2`,[input.allocationId,input.cause])).rows[0];
 if(old){if(old.request_hash!==hash)throw new Error('Changed instruction for idempotency key');return old.id;}
 const id=randomUUID();
 await tx.query(`INSERT INTO strategy_allocation_transactions(id,allocation_id,sequence,kind,trigger,requested_amount,idempotency_key,request_hash,pending_reason,created_at)
 SELECT $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5,$4,$6,$7,$8 FROM strategy_allocation_transactions WHERE allocation_id=$2`,
 [id,input.allocationId,input.kind,input.cause,input.requestedAmount??null,hash,input.pendingReason??null,now]);
 return id;
}
export interface LedgerWrite {
 allocationId:string;transactionId:string;entryType:EntryKind;cause:string;
 instrumentRef?:string;assetClass?:'equity'|'crypto';symbol?:string|null;quantityDelta?:string;cashDelta?:string;unitCost?:string;
 provider?:string;executionRef?:string;sourceKind:string;sourceRef:string;occurredAt:string;
 reversalOf?:string;metadata?:Record<string,unknown>;
}
// Callers must hold one db.transaction for the complete workflow, including all reads.
export async function append(tx:Transaction,input:LedgerWrite,now:string):Promise<string> {
 key(input.cause); amount(input.cashDelta??'0');if(input.quantityDelta!==undefined)amount(input.quantityDelta);
 if(input.unitCost!==undefined&&amount(input.unitCost)<0n)throw new Error('Negative unit cost');
 if(!Number.isFinite(Date.parse(input.occurredAt)))throw new Error('Invalid financial event time');
 const hash=fingerprint(input);
 const old=(await tx.query<{id:string;request_hash:string}>(`SELECT id,request_hash FROM strategy_attribution_entries WHERE allocation_id=$1 AND idempotency_key=$2`,[input.allocationId,input.cause])).rows[0];
 if(old){if(old.request_hash!==hash)throw new Error('Changed ledger entry for idempotency key');return old.id;}
 const a=await allocation(tx,input.allocationId);
 if(a.status==='closed'||a.status==='detached')throw new Error('Allocation has released its claims');
 const id=randomUUID();
 await tx.query(`INSERT INTO strategy_attribution_entries(id,allocation_id,account_id,transaction_id,sequence,
 entry_type,instrument_ref,symbol,asset_class,quantity_delta,cash_delta,currency,unit_cost,provider,execution_ref,
 source_kind,source_ref,idempotency_key,request_hash,reversal_of,metadata,occurred_at,recorded_at)
 SELECT $1,$2,$3,$4,coalesce(max(sequence),0)+1,$5,$6,$7,$8,$9,$10,'USD',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
 FROM strategy_attribution_entries WHERE allocation_id=$2`,
 [id,a.id,a.account_id,input.transactionId,input.entryType,input.instrumentRef??null,input.symbol??null,input.instrumentRef?(input.assetClass??'equity'):null,
 input.quantityDelta??null,input.cashDelta??'0',input.unitCost??null,input.provider??null,input.executionRef??null,input.sourceKind,input.sourceRef,input.cause,hash,input.reversalOf??null,JSON.stringify(input.metadata??{}),input.occurredAt,now]);
 return id;
}
