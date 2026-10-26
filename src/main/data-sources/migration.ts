export const dataSourceStorageMigration = { version: 83, name: 'Versioned custom data source configuration and sampled observations', sql: `
CREATE TABLE data_sources (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES local_owners(id),
 current_revision integer NOT NULL CHECK(current_revision>0),
 enabled boolean NOT NULL DEFAULT false, validated boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE data_source_revisions (
 source_id uuid NOT NULL REFERENCES data_sources(id), revision integer NOT NULL CHECK(revision>0),
 config jsonb NOT NULL CHECK(octet_length(config::text)<=65536), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_id,revision)
);
ALTER TABLE data_sources ADD CONSTRAINT data_source_current_revision
 FOREIGN KEY(id,current_revision) REFERENCES data_source_revisions(source_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE data_source_latest (
 source_id uuid NOT NULL, revision integer NOT NULL, feed_id text NOT NULL,
 received_at timestamptz NOT NULL, event_time timestamptz, data jsonb NOT NULL,
 PRIMARY KEY(source_id,revision,feed_id),
 FOREIGN KEY(source_id,revision) REFERENCES data_source_revisions(source_id,revision)
);
CREATE TABLE data_source_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_id uuid NOT NULL, revision integer NOT NULL, feed_id text NOT NULL,
 received_at timestamptz NOT NULL, event_time timestamptz, expires_at timestamptz NOT NULL,
 data jsonb NOT NULL, FOREIGN KEY(source_id,revision) REFERENCES data_source_revisions(source_id,revision)
);
CREATE INDEX data_source_history_feed_time ON data_source_history(source_id,revision,feed_id,received_at DESC,id DESC);
CREATE INDEX data_source_history_expiry ON data_source_history(expires_at,id);
` };
