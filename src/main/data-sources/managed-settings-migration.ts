export const managedSourceSettingsMigration = {version:85,name:'Configurable managed source polling',sql:`
CREATE TABLE managed_source_settings (
 owner_id uuid NOT NULL REFERENCES local_owners(id), job_id text NOT NULL,
 collection text NOT NULL CHECK(collection IN ('automatic','off')),
 interval_ms integer NOT NULL CHECK(interval_ms BETWEEN 5000 AND 86400000),
 revision integer NOT NULL CHECK(revision>0),
 PRIMARY KEY(owner_id,job_id)
);
`};
