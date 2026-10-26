export const jobDiagnosticsMigration = { version: 5, name: 'Job execution events and history retention', sql: `
CREATE TABLE job_history_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  retention_days integer CHECK (retention_days IN (7, 30, 90))
);
INSERT INTO job_history_settings DEFAULT VALUES;
CREATE TABLE job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
  state text NOT NULL,
  attempts integer NOT NULL,
  error_code text,
  next_run_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX job_events_by_job ON job_events(job_id, id DESC);
CREATE FUNCTION record_job_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (NEW.state, NEW.attempts, NEW.error_code, NEW.next_run_at)
    IS DISTINCT FROM (OLD.state, OLD.attempts, OLD.error_code, OLD.next_run_at) THEN
    INSERT INTO job_events(job_id, state, attempts, error_code, next_run_at)
    VALUES (NEW.id, NEW.state, NEW.attempts,
      CASE WHEN NEW.error_code IN ('reauth_required','storage_locked','transient','cancelled','busy','host_restarted','restored_backup','disconnected')
        THEN NEW.error_code WHEN NEW.error_code IS NOT NULL THEN 'unknown' ELSE NULL END,
      NEW.next_run_at);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER background_job_events AFTER INSERT OR UPDATE ON background_jobs
  FOR EACH ROW EXECUTE FUNCTION record_job_event();
` };
