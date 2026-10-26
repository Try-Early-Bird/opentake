export const notificationRecoveryMigration = { version: 23, name: 'Notification recovery and disabled maintenance attention', sql: `
ALTER TABLE notification_delivery ADD COLUMN recovery_sent boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION connection_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE notifications SET resolved_at=coalesce(resolved_at,now()) WHERE payload->'source'->>'type'='connection' AND payload->'source'->>'id'=OLD.id::text;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 UPDATE notifications SET resolved_at=coalesce(resolved_at,now()) WHERE payload->'source'->>'type'='connection' AND payload->'source'->>'id'=NEW.id::text;
 IF NEW.status='reauth_required' THEN
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
SELECT record_local_notification(jsonb_build_object(
 'kind','connection_attention','tier','act_now','requiresAction',true,'eventKey',gen_random_uuid()::text,
 'context',jsonb_build_object('venue',venue,'connectionId',id),'source',jsonb_build_object('type','connection','id',id),
 'occurredAt',now(),'title','Platform sign-in needed','body','Open Connections to reconnect your trading platform.'),true)
 FROM platform_connections WHERE status='reauth_required' AND NOT maintenance_enabled
 AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.payload->'source'->>'type'='connection' AND n.payload->'source'->>'id'=platform_connections.id::text AND n.resolved_at IS NULL);
` };
