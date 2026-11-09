/** Versioned, conservative body-production policy. Only a reviewed retired
 * personal owner may omit a journal body. Every other Provider remains an
 * independent consumer; paused subscriptions keep custody for recovery. */
const topics="ARRAY['session.event.v1','session.lifecycle.v1','turn.lifecycle.v1','session.deleted.v1','session.access.revoked.v1']::text[]"
const facts=(table:string)=>`SELECT jsonb_build_array(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,subscriptions,start_policy) AS fact FROM ${table}`
export const SHARED_SESSION_CONSUMER_FUNCTIONS=[
 `CREATE TABLE IF NOT EXISTS shared.session_transport_consumer_clock(
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),version INT NOT NULL CHECK(version=1),revision BIGINT NOT NULL CHECK(revision>0))`,
 `INSERT INTO shared.session_transport_consumer_clock VALUES(TRUE,1,1) ON CONFLICT DO NOTHING`,
 `CREATE TABLE IF NOT EXISTS shared.session_transport_body_gaps(
  owner_user_id INT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,first_gated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
 `CREATE OR REPLACE FUNCTION shared.capture_session_transport_consumers() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE changed BOOLEAN;BEGIN
   IF TG_OP='INSERT' THEN SELECT EXISTS(SELECT 1 FROM consumer_new) INTO changed;
   ELSIF TG_OP='DELETE' THEN SELECT EXISTS(SELECT 1 FROM consumer_old) INTO changed;
   ELSE SELECT EXISTS((${facts('consumer_new')} EXCEPT ${facts('consumer_old')}) UNION (${facts('consumer_old')} EXCEPT ${facts('consumer_new')})) INTO changed;END IF;
   IF changed THEN
    -- Config writers may already own native rows. Reject rather than wait
    -- backwards behind a publisher holding this original consumer snapshot.
    PERFORM 1 FROM shared.session_transport_consumer_clock WHERE singleton FOR UPDATE NOWAIT;
    UPDATE shared.session_transport_consumer_clock SET revision=revision+1 WHERE singleton;
    IF NOT FOUND THEN RAISE EXCEPTION 'session_transport_consumer_policy_missing';END IF;
   END IF;RETURN NULL;
  END $$`,
 ...['INSERT','UPDATE','DELETE'].map(op=>`DROP TRIGGER IF EXISTS session_transport_consumers_${op.toLowerCase()} ON public.extension_installations;
  CREATE TRIGGER session_transport_consumers_${op.toLowerCase()} AFTER ${op} ON public.extension_installations
   REFERENCING ${op!=='INSERT'?'OLD TABLE AS consumer_old ':''}${op!=='DELETE'?'NEW TABLE AS consumer_new ':''}
   FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_session_transport_consumers()`),
 `CREATE OR REPLACE FUNCTION shared.require_session_transport_gap_snapshot() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF NEW.owner_user_id IS NULL OR NEW.start_policy<>'retained_history' OR NOT(NEW.subscriptions&&${topics}) THEN RETURN NULL;END IF;
   IF TG_OP='UPDATE' AND OLD.start_policy='retained_history' AND OLD.subscriptions&&${topics} THEN RETURN NULL;END IF;
   IF EXISTS(SELECT 1 FROM shared.session_transport_body_gaps WHERE owner_user_id=NEW.owner_user_id) THEN
    INSERT INTO public.extension_checkpoints(installation_id,snapshot_required_at) VALUES(NEW.installation_id,clock_timestamp())
     ON CONFLICT(installation_id) DO UPDATE SET snapshot_required_at=COALESCE(extension_checkpoints.snapshot_required_at,EXCLUDED.snapshot_required_at),
      lease_epoch=extension_checkpoints.lease_epoch+1,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp();
   END IF;RETURN NULL;
  END $$`,
 `DROP TRIGGER IF EXISTS session_transport_gap_snapshot ON public.extension_installations;
  CREATE TRIGGER session_transport_gap_snapshot AFTER INSERT OR UPDATE ON public.extension_installations
   FOR EACH ROW EXECUTE FUNCTION shared.require_session_transport_gap_snapshot()`,
 `CREATE OR REPLACE FUNCTION shared.assert_session_transport_consumer_policy() RETURNS VOID
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM shared.session_transport_consumer_clock WHERE singleton AND version=1)
    OR EXISTS(SELECT 1 FROM(VALUES('session_transport_consumers_insert',4),('session_transport_consumers_update',16),('session_transport_consumers_delete',8)) expected(trigger_name,trigger_type)
     WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.extension_installations'::regclass AND t.tgname=expected.trigger_name
      AND t.tgfoid=to_regprocedure('shared.capture_session_transport_consumers()') AND t.tgtype=expected.trigger_type AND t.tgenabled IN('O','A')))
    OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.extension_installations'::regclass AND t.tgname='session_transport_gap_snapshot'
     AND t.tgfoid=to_regprocedure('shared.require_session_transport_gap_snapshot()') AND t.tgtype=21 AND t.tgenabled IN('O','A'))
    THEN RAISE EXCEPTION 'session_transport_consumer_policy_missing';END IF;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.session_transport_consumer_policy(p_owner BIGINT) RETURNS JSONB
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE clock_revision BIGINT;retired BOOLEAN;required BOOLEAN;BEGIN
   IF p_owner IS NULL OR p_owner<1 THEN RAISE EXCEPTION 'invalid_session_transport_owner';END IF;
   PERFORM shared.assert_session_transport_consumer_policy();
   SELECT revision INTO clock_revision FROM shared.session_transport_consumer_clock WHERE singleton AND version=1 FOR SHARE NOWAIT;
   IF clock_revision IS NULL THEN RAISE EXCEPTION 'session_transport_consumer_policy_missing';END IF;
   SELECT EXISTS(SELECT 1 FROM shared.memory_session_transport_retirements r JOIN public.extension_installations i USING(installation_id)
    WHERE i.provider_id='pocketctl-memory' AND i.owner_scope_kind='personal' AND i.owner_user_id=p_owner) INTO retired;
   required=NOT retired OR EXISTS(SELECT 1 FROM public.extension_installations i
    WHERE i.status IN('pending','active','paused') AND i.subscriptions&&${topics}
     AND(i.owner_user_id=p_owner OR i.owner_user_id IS NULL));
   RETURN jsonb_build_object('version',1,'revision',clock_revision::text,'bodyRequired',required,'scope',CASE WHEN retired THEN 'retired-personal' ELSE 'legacy' END);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.record_session_transport_body_gap(p_owner BIGINT) RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF (shared.session_transport_consumer_policy(p_owner)->>'bodyRequired')::boolean IS DISTINCT FROM FALSE
    THEN RAISE EXCEPTION 'session_transport_body_omission_not_allowed';END IF;
   INSERT INTO shared.session_transport_body_gaps(owner_user_id) VALUES(p_owner) ON CONFLICT DO NOTHING;
  END $$`,
 `REVOKE ALL ON shared.session_transport_consumer_clock,shared.session_transport_body_gaps FROM PUBLIC`,
 `REVOKE ALL ON FUNCTION shared.capture_session_transport_consumers(),shared.require_session_transport_gap_snapshot(),
  shared.assert_session_transport_consumer_policy(),shared.session_transport_consumer_policy(BIGINT),shared.record_session_transport_body_gap(BIGINT) FROM PUBLIC`,
] as const
