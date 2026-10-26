// Feature-independent audit storage. Producers are integrated separately.
export const aiAuditMigration = { version: 15, name: 'Feature-independent AI audit traces', sql: `
CREATE TABLE ai_audit_traces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES local_owners(id),
 feature text NOT NULL CHECK (length(feature) BETWEEN 1 AND 100),
 operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 200),
 source_ref text,
 capture_version integer NOT NULL DEFAULT 1 CHECK (capture_version > 0),
 state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed','failed','cancelled','interrupted')),
 capture_status text NOT NULL DEFAULT 'partial' CHECK (capture_status IN ('partial','complete','legacy')),
 last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 CHECK ((state = 'running') = (finished_at IS NULL)),
 CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX ai_audit_traces_source ON ai_audit_traces(owner_id,feature,source_ref,started_at DESC,id);

CREATE TABLE ai_audit_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 trace_id uuid NOT NULL REFERENCES ai_audit_traces(id) ON DELETE CASCADE,
 parent_run_id uuid,
 retry_of_run_id uuid,
 provider text NOT NULL CHECK (length(provider) > 0),
 model text NOT NULL CHECK (length(model) > 0),
 adapter text NOT NULL CHECK (length(adapter) > 0),
 adapter_version text NOT NULL CHECK (length(adapter_version) > 0),
 provider_request_id text,
 state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed','failed','cancelled','interrupted')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 UNIQUE(trace_id,id),
 FOREIGN KEY(trace_id,parent_run_id) REFERENCES ai_audit_runs(trace_id,id),
 FOREIGN KEY(trace_id,retry_of_run_id) REFERENCES ai_audit_runs(trace_id,id),
 CHECK (parent_run_id IS NULL OR parent_run_id <> id),
 CHECK (retry_of_run_id IS NULL OR retry_of_run_id <> id),
 CHECK ((state = 'running') = (finished_at IS NULL)),
 CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE ai_audit_events (
 trace_id uuid NOT NULL REFERENCES ai_audit_traces(id) ON DELETE CASCADE,
 sequence bigint NOT NULL CHECK (sequence > 0),
 id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 run_id uuid,
 parent_sequence bigint,
 span_id uuid,
 kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
 schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payload_status text NOT NULL CHECK (payload_status IN ('captured','redacted','omitted','unavailable')),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
 capture_note text,
 PRIMARY KEY(trace_id,sequence),
 FOREIGN KEY(trace_id,run_id) REFERENCES ai_audit_runs(trace_id,id),
 FOREIGN KEY(trace_id,parent_sequence) REFERENCES ai_audit_events(trace_id,sequence),
 CHECK (parent_sequence IS NULL OR parent_sequence < sequence),
 CHECK (payload_status = 'captured' OR length(trim(capture_note)) > 0 AND capture_note IS NOT NULL)
);
CREATE INDEX ai_audit_events_run ON ai_audit_events(trace_id,run_id,sequence);
CREATE INDEX ai_audit_events_span ON ai_audit_events(trace_id,span_id,sequence) WHERE span_id IS NOT NULL;

-- Allocate order under a trace row lock: parallel producers cannot reuse a
-- sequence, and a rolled-back event also rolls back the counter increment.
CREATE FUNCTION sequence_ai_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE ai_audit_traces SET last_sequence=last_sequence+1
 WHERE id=NEW.trace_id RETURNING last_sequence INTO NEW.sequence;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI audit trace unavailable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER ai_audit_event_sequence BEFORE INSERT ON ai_audit_events
 FOR EACH ROW EXECUTE FUNCTION sequence_ai_audit_event();
CREATE FUNCTION prevent_ai_audit_event_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'AI audit events are append-only';
END;
$$;
CREATE TRIGGER ai_audit_event_immutable BEFORE UPDATE ON ai_audit_events
 FOR EACH ROW EXECUTE FUNCTION prevent_ai_audit_event_update();
` };
