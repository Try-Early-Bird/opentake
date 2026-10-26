// The shared envelope for every action (trades, agent runs,
// Take changes) and the venues it can run on. New tables reference `venues`
// instead of a CHECK list, so a new platform is one appended INSERT migration.
export const actionJobMigration={version:100,name:'Shared action jobs and venues',sql:`
CREATE TABLE venues (
 id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,31}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO venues(id) VALUES ('coinbase'),('robinhood');
CREATE TABLE action_jobs (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,47}$'),
 origin text NOT NULL CHECK (origin IN ('rule','agent','member')),
 origin_id uuid NOT NULL,
 take_id uuid REFERENCES takes(id) ON DELETE CASCADE,
 account_id uuid REFERENCES linked_accounts(id),
 venue text REFERENCES venues(id),
 idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
 input jsonb NOT NULL DEFAULT '{}' CHECK (octet_length(input::text) <= 65536),
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','waiting','succeeded','blocked','failed','needs_attention','cancelled')),
 waiting_for text CHECK (waiting_for IN ('approval','market_open','funds','inputs','account')),
 reason text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{1,63}$'),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_run_at timestamptz NOT NULL DEFAULT now(),
 adapter_state jsonb NOT NULL DEFAULT '{}' CHECK (octet_length(adapter_state::text) <= 65536),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((state = 'waiting') = (waiting_for IS NOT NULL)),
 CHECK (account_id IS NULL OR venue IS NOT NULL)
);
CREATE INDEX action_jobs_due ON action_jobs(next_run_at) WHERE state IN ('queued','running','waiting');
CREATE INDEX action_jobs_by_take ON action_jobs(take_id, updated_at DESC);
CREATE INDEX action_jobs_by_origin ON action_jobs(origin, origin_id);
CREATE TABLE action_job_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES action_jobs(id) ON DELETE CASCADE,
 state text NOT NULL,
 waiting_for text,
 reason text,
 attempts integer NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX action_job_events_by_job ON action_job_events(job_id, id DESC);
CREATE FUNCTION record_action_job_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' OR (NEW.state, NEW.waiting_for, NEW.reason, NEW.attempts)
  IS DISTINCT FROM (OLD.state, OLD.waiting_for, OLD.reason, OLD.attempts) THEN
  INSERT INTO action_job_events(job_id, state, waiting_for, reason, attempts)
  VALUES (NEW.id, NEW.state, NEW.waiting_for, NEW.reason, NEW.attempts);
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER action_job_events AFTER INSERT OR UPDATE ON action_jobs
 FOR EACH ROW EXECUTE FUNCTION record_action_job_event();
`};
