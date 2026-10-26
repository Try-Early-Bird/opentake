import type {DiagnosticResponse} from './broker-response';
export const rebalanceReasons = {
 insufficient_funds: 'The Take does not have enough available cash to cover the rebalance and fees. Review its funding.',
 drift_detected: 'Drift exceeded the saved threshold. Checking eligible orders.',
 below_minimum: 'Adjustment is below Coinbase’s minimum order size. No order was placed; wait for a larger adjustment before retrying.',
 on_target: 'No orders are needed at the current target weights.',
 stale_data: 'Account data is stale or incomplete. Check the Coinbase connection and refresh the account.',
 daily_limit: 'A rebalance that traded has already completed today. The next eligible rebalance is tomorrow (UTC).',
 orders_pending: 'Existing orders must settle before another rebalance can start.',
 approval_required: 'Rebalance is awaiting approval. Open the Take to review it.',
 retry_scheduled: 'Preview could not complete. A retry is scheduled with backoff.',
 attention_required: 'Rebalance needs attention. Open the Take to check its orders before retrying.',
 completed: 'Rebalance orders completed.',
} as const;
export type RebalanceReason = keyof typeof rebalanceReasons;
export interface DiagnosticRow {request?:DiagnosticResponse;response?:DiagnosticResponse;venue?:string;operation?:string;errorCode?:string;symbols?:string[];time:string;event:string;source:string;reason?:string;takeId?:string;stage?:string;details:Record<string,string|number|boolean>}
export interface DiagnosticPage {rows:DiagnosticRow[];truncated:boolean}

export function diagnosticLevel(row:DiagnosticRow):'info'|'warning'|'error'{
 if(/failed|fatal|gone/.test(row.event)||row.reason==='attention_required')return 'error';
 if(row.reason&&['insufficient_funds','below_minimum','stale_data','approval_required','retry_scheduled','orders_pending'].includes(row.reason))return 'warning';
 return 'info';
}
