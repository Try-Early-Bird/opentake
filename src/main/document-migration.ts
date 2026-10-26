export const documentMigration={version:82,name:'Stored PDF documents and scoped retrieval',sql:`
ALTER TABLE takes ADD COLUMN draft_documents jsonb NOT NULL DEFAULT '[]';
CREATE TABLE take_documents (
 id uuid PRIMARY KEY, take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 name text NOT NULL, bytes integer NOT NULL CHECK(bytes>0 AND bytes<=52428800),
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','ready')),
 pages integer, scanned_pages integer, created_at timestamptz NOT NULL DEFAULT now(),
 file_sha256 text CHECK(file_sha256 IS NULL OR file_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX take_documents_take ON take_documents(take_id);
CREATE TABLE take_document_pages (
 document_id uuid NOT NULL REFERENCES take_documents(id) ON DELETE CASCADE,
 page integer NOT NULL CHECK(page BETWEEN 1 AND 1000), text text NOT NULL,
 PRIMARY KEY(document_id,page)
);
CREATE INDEX take_document_search ON take_document_pages USING gin(to_tsvector('simple',text));
CREATE TABLE take_document_usage (
 run_id uuid PRIMARY KEY REFERENCES take_runs(id) ON DELETE CASCADE,
 units integer NOT NULL DEFAULT 0, images integer NOT NULL DEFAULT 0
);
`};
