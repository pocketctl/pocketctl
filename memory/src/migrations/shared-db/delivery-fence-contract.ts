/** Accepted capsules keep independent ownership. Explicit artifact withdrawal
 * has a stable global submission identity even when no tombstone row exists. */
export const SHARED_DELIVERY_FENCE_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.fence_memory_delivery_withdrawal() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE submission UUID;BEGIN
   FOR submission IN SELECT DISTINCT id FROM unnest(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.submission_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.submission_id END]) id WHERE id IS NOT NULL ORDER BY id LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('memory:delivery-submission-privacy:v1:'||submission::text,0)) THEN RAISE EXCEPTION 'delivery_privacy_fence_busy' USING ERRCODE='55P03';END IF;
   END LOOP;
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.lock_memory_delivery_commit(p_proofs JSONB) RETURNS BOOLEAN
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE submission UUID;BEGIN
   IF p_proofs IS NULL OR jsonb_typeof(p_proofs)<>'array' OR octet_length(p_proofs::text)>2097152 THEN RETURN FALSE;END IF;
   IF jsonb_array_length(p_proofs) NOT BETWEEN 1 AND 512 THEN RETURN FALSE;END IF;
   BEGIN
    IF NOT EXISTS(SELECT 1 FROM shared.memory_source_contract c WHERE to_jsonb(c)->>'delivery_privacy_capture_version'='1')
     OR EXISTS(SELECT 1 FROM unnest(ARRAY['public.team_artifact_revocations','public.team_delivery_memory_withdrawals','memory.memory_team_delivery_withdrawals']) relation
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(relation) AND t.tgname='memory_delivery_privacy_fence'
       AND t.tgfoid=to_regprocedure('shared.fence_memory_delivery_withdrawal()') AND t.tgtype=31 AND t.tgenabled IN('O','A'))) THEN RAISE lock_not_available;END IF;
    IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_proofs) p(team_id text,team_session_id text,submission_id uuid,decision_id uuid)
     WHERE p.team_id IS NULL OR length(p.team_id) NOT BETWEEN 1 AND 512 OR p.team_session_id IS NULL OR length(p.team_session_id) NOT BETWEEN 1 AND 512 OR p.submission_id IS NULL OR p.decision_id IS NULL) THEN RAISE lock_not_available;END IF;
    FOR submission IN SELECT DISTINCT p.submission_id FROM jsonb_to_recordset(p_proofs) p(submission_id uuid) ORDER BY p.submission_id LOOP
     IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('memory:delivery-submission-privacy:v1:'||submission::text,0)) THEN RAISE lock_not_available;END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_proofs) p(team_id text,team_session_id text,submission_id uuid,decision_id uuid)
     WHERE EXISTS(SELECT 1 FROM memory.memory_team_delivery_withdrawals w WHERE(w.team_id,w.team_session_id,w.submission_id,w.decision_id)=(p.team_id,p.team_session_id,p.submission_id,p.decision_id))
      OR EXISTS(SELECT 1 FROM public.team_delivery_memory_withdrawals w WHERE(w.team_id,w.team_session_id,w.submission_id,w.decision_id)=(p.team_id,p.team_session_id,p.submission_id,p.decision_id))
      OR EXISTS(SELECT 1 FROM public.team_artifact_revocations a WHERE a.submission_id=p.submission_id)) THEN RAISE lock_not_available;END IF;
    RETURN TRUE;
   EXCEPTION WHEN lock_not_available OR invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value OR undefined_table THEN RETURN FALSE;END;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.fence_memory_delivery_withdrawal(),shared.lock_memory_delivery_commit(JSONB) FROM PUBLIC`,
 `DO $$ BEGIN IF to_regclass('memory.memory_team_delivery_withdrawals') IS NOT NULL THEN
   DROP TRIGGER IF EXISTS memory_delivery_privacy_fence ON memory.memory_team_delivery_withdrawals;
   CREATE TRIGGER memory_delivery_privacy_fence BEFORE INSERT OR UPDATE OR DELETE ON memory.memory_team_delivery_withdrawals FOR EACH ROW EXECUTE FUNCTION shared.fence_memory_delivery_withdrawal();
  END IF;END $$`,
] as const
