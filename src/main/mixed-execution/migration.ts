export const mixedPreviewMigration={version:69,name:'Mixed Take funding previews',sql:`
CREATE TABLE mixed_take_previews (
 operation_id uuid PRIMARY KEY,request_hash text NOT NULL,
 id uuid NOT NULL UNIQUE,take_id uuid NOT NULL REFERENCES takes(id),
 version_id uuid NOT NULL REFERENCES strategy_versions(id),route_revision uuid NOT NULL,
 payload jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mixed_take_previews_expiry ON mixed_take_previews(expires_at);
`};
