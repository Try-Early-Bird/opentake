/** Storage contracts, not a renderer API. Payloads may contain private user data. */
export type AiAuditState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type AiAuditCaptureStatus = 'partial' | 'complete' | 'legacy';
export type AiAuditPayloadStatus = 'captured' | 'redacted' | 'omitted' | 'unavailable';
export type AiAuditJson = null | boolean | number | string | AiAuditJson[] | { [key: string]: AiAuditJson };

/** Bigint sequence values cross JS boundaries as decimal strings. */
export interface AiAuditTrace {
 id: string;
 owner_id: string;
 feature: string;
 operation: string;
 source_ref: string | null;
 capture_version: number;
 state: AiAuditState;
 capture_status: AiAuditCaptureStatus;
 last_sequence: string;
 started_at: string;
 finished_at: string | null;
}

export interface AiAuditRun {
 id: string;
 trace_id: string;
 parent_run_id: string | null;
 retry_of_run_id: string | null;
 provider: string;
 model: string;
 adapter: string;
 adapter_version: string;
 provider_request_id: string | null;
 state: AiAuditState;
 started_at: string;
 finished_at: string | null;
}

/** Version each kind's payload independently; unknown kinds remain readable. */
export interface AiAuditEvent {
 id: string;
 trace_id: string;
 sequence: string;
 run_id: string | null;
 parent_sequence: string | null;
 span_id: string | null;
 kind: string;
 schema_version: number;
 occurred_at: string;
 recorded_at: string;
 payload_status: AiAuditPayloadStatus;
 payload: { [key: string]: AiAuditJson };
 capture_note: string | null;
}
