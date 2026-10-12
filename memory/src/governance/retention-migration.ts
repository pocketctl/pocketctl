export const GOVERNANCE_TTL_MIGRATION={version:57,statements:[
 `CREATE FUNCTION memory_check_candidate_ttl() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE stamp jsonb;
 BEGIN
   stamp:=NULLIF(current_setting('pocketctl.candidate_ttl',true),'')::jsonb;
   IF stamp IS NOT NULL AND (stamp->>'expiresAt')::timestamptz<=clock_timestamp() THEN
     RAISE EXCEPTION 'candidate_ttl_expired' USING ERRCODE='55000';
   END IF;
   RETURN NULL;
 END $$`,
 `CREATE CONSTRAINT TRIGGER memory_candidate_ttl AFTER INSERT OR UPDATE ON memory_review_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_candidate_ttl()`,
 `CREATE CONSTRAINT TRIGGER memory_candidate_ttl AFTER INSERT OR UPDATE ON memory_authority_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_candidate_ttl()`,
 `CREATE CONSTRAINT TRIGGER memory_candidate_ttl AFTER INSERT OR UPDATE ON memory_promotion_candidates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_candidate_ttl()`,
 `CREATE CONSTRAINT TRIGGER memory_candidate_ttl AFTER INSERT OR UPDATE ON memory_governance_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_candidate_ttl()`,
 `CREATE CONSTRAINT TRIGGER memory_candidate_ttl AFTER INSERT OR UPDATE ON memory_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_candidate_ttl()`,
]}
