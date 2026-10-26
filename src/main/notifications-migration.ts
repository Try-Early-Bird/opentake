export const notificationsMigration = { version: 21, name: 'Local notifications and native delivery', sql: `
CREATE TABLE notification_delivery (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 throttle_until timestamptz NOT NULL DEFAULT '-infinity',
 urgent_used boolean NOT NULL DEFAULT false,
 recovery_until timestamptz NOT NULL DEFAULT now() + interval '10 seconds',
 navigation jsonb
);
INSERT INTO notification_delivery DEFAULT VALUES;
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 identity jsonb NOT NULL UNIQUE,
 payload jsonb NOT NULL,
 seen boolean NOT NULL DEFAULT false,
 resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 origin text NOT NULL CHECK(origin IN ('live','recovery')),
 delivery text NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','attempted','suppressed','failed')),
 pruned boolean NOT NULL DEFAULT false
);
CREATE INDEX notifications_pending ON notifications(sequence) WHERE delivery='pending';
CREATE INDEX notifications_attention ON notifications(sequence DESC) WHERE resolved_at IS NULL AND NOT pruned;

-- Same identity shape as NotificationKey. JSONB equality ignores key ordering.
CREATE FUNCTION record_local_notification(p jsonb, recovery boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO notifications(identity,payload,expires_at,origin)
 VALUES(jsonb_build_object('kind',p->'kind','context',p->'context','source',p->'source','eventKey',p->'eventKey'),p,
 (p->>'expiresAt')::timestamptz,CASE WHEN recovery THEN 'recovery' ELSE 'live' END)
 ON CONFLICT(identity) DO NOTHING;
END;
$$;
CREATE FUNCTION connection_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE notifications SET resolved_at=coalesce(resolved_at,now()) WHERE payload->'source'->>'type'='connection' AND payload->'source'->>'id'=OLD.id::text;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 UPDATE notifications SET resolved_at=coalesce(resolved_at,now()) WHERE payload->'source'->>'type'='connection' AND payload->'source'->>'id'=NEW.id::text;
 IF NEW.status='reauth_required' AND NEW.maintenance_enabled THEN
  PERFORM record_local_notification(jsonb_build_object(
   'kind','connection_attention','tier','act_now','requiresAction',true,'eventKey',gen_random_uuid()::text,
   'context',jsonb_build_object('venue',NEW.venue,'connectionId',NEW.id),
   'source',jsonb_build_object('type','connection','id',NEW.id),
   'occurredAt',now(),'title','Platform sign-in needed','body','Open Connections to reconnect your trading platform.'),
   (SELECT recovery_until>now() FROM notification_delivery));
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER connection_notifications AFTER INSERT OR UPDATE OF status OR DELETE ON platform_connections
 FOR EACH ROW EXECUTE FUNCTION connection_notification();
CREATE FUNCTION approval_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval_id uuid; source_type text; take_id uuid;
BEGIN
 source_type:=CASE WHEN TG_TABLE_NAME='tool_approvals' THEN 'tool_approval' ELSE 'platform_approval' END;
 IF TG_OP='DELETE' THEN approval_id:=OLD.id; ELSE approval_id:=NEW.id; END IF;
 IF TG_OP='DELETE' THEN
  UPDATE notifications SET resolved_at=coalesce(resolved_at,now()) WHERE payload->'source'->>'type'=source_type AND payload->'source'->>'id'=approval_id::text;
  RETURN OLD;
 END IF;
 IF NEW.state='pending' AND NEW.expires_at>now() THEN
  SELECT r.take_id INTO take_id FROM take_runs r WHERE r.id=NEW.run_id AND r.state IN ('starting','running');
  IF take_id IS NOT NULL THEN
   PERFORM record_local_notification(jsonb_build_object(
    'kind','run_approval_needed','tier','act_now','requiresAction',true,'eventKey',NEW.id,
    'context',jsonb_build_object('takeId',take_id),'source',jsonb_build_object('type',source_type,'id',NEW.id),
    'occurredAt',NEW.created_at,'expiresAt',NEW.expires_at,'title','A take needs your approval',
    'body',CASE WHEN source_type='tool_approval' THEN 'Review the tool request in your take.' ELSE 'Review platform data access in your take.' END));
  END IF;
 ELSE
  UPDATE notifications SET resolved_at=coalesce(resolved_at,now()) WHERE payload->'source'->>'type'=source_type AND payload->'source'->>'id'=NEW.id::text;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER tool_approval_notifications AFTER INSERT OR UPDATE OF state OR DELETE ON tool_approvals FOR EACH ROW EXECUTE FUNCTION approval_notification();
CREATE TRIGGER platform_approval_notifications AFTER INSERT OR UPDATE OF state OR DELETE ON platform_access_requests FOR EACH ROW EXECUTE FUNCTION approval_notification();
-- Reconcile connections already requiring attention at upgrade. Approval owners
-- expire interrupted runs during startup; do not replay those old requests.
SELECT record_local_notification(jsonb_build_object(
 'kind','connection_attention','tier','act_now','requiresAction',true,'eventKey',gen_random_uuid()::text,
 'context',jsonb_build_object('venue',venue,'connectionId',id),'source',jsonb_build_object('type','connection','id',id),
 'occurredAt',now(),'title','Platform sign-in needed','body','Open Connections to reconnect your trading platform.'),true)
 FROM platform_connections WHERE status='reauth_required' AND maintenance_enabled;
` };
