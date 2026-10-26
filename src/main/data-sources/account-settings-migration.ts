export const accountSourceSettingsMigration={version:86,name:'Account-owned source collection and Coinbase feed selection',sql:`
CREATE TABLE account_source_settings (
 account_id uuid NOT NULL REFERENCES linked_accounts(id), job_id text NOT NULL,
 collection text NOT NULL CHECK(collection IN ('automatic','off')),
 interval_ms integer NOT NULL CHECK(interval_ms BETWEEN 5000 AND 86400000),
 revision integer NOT NULL CHECK(revision>0), PRIMARY KEY(account_id,job_id)
);
CREATE TABLE coinbase_account_source_settings (
 account_id uuid PRIMARY KEY REFERENCES linked_accounts(id),
 revision integer NOT NULL CHECK(revision>0), config jsonb NOT NULL CHECK(octet_length(config::text)<=32768)
);
`};
