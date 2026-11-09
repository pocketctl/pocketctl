/** Distribution is metadata, separate from source processing. A root is not
 * acknowledged merely because its current page or one principal is ready. */
export const SHARED_SOURCE_DISTRIBUTION_FUNCTIONS=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS distribution_version INT NOT NULL DEFAULT 0`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_distributions(
  source_kind TEXT NOT NULL,root_key TEXT NOT NULL,scan_id UUID NOT NULL UNIQUE,
  work_revision BIGINT NOT NULL CHECK(work_revision>0),control_revision BIGINT NOT NULL CHECK(control_revision>0),
  cursor_key TEXT NOT NULL DEFAULT '' CHECK(length(cursor_key)<=2048),state TEXT NOT NULL CHECK(state IN('scanning','sealed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(source_kind,root_key),
  FOREIGN KEY(source_kind,root_key) REFERENCES shared.memory_source_work(source_kind,root_key))`,
 `ALTER TABLE shared.memory_source_distributions ADD COLUMN IF NOT EXISTS dispatch_cursor TEXT NOT NULL DEFAULT '' CHECK(length(dispatch_cursor)<=2048)`,
 `ALTER TABLE shared.memory_source_distributions ADD COLUMN IF NOT EXISTS dispatch_complete BOOLEAN NOT NULL DEFAULT FALSE`,
 `ALTER TABLE shared.memory_source_distributions ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_owner TEXT,ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_distribution_targets(
  scan_id UUID NOT NULL,cursor_key TEXT NOT NULL CHECK(length(cursor_key) BETWEEN 1 AND 2048),
  installation_id UUID NOT NULL,source_scope JSONB NOT NULL CHECK(jsonb_typeof(source_scope)='object'),
  source_version JSONB NOT NULL CHECK(jsonb_typeof(source_version)='object'),
  target_mode TEXT NOT NULL CHECK(target_mode IN('shared-shadow','shared-active')),state TEXT NOT NULL,
  PRIMARY KEY(scan_id,cursor_key))`,
 `CREATE INDEX IF NOT EXISTS memory_source_distribution_installation ON shared.memory_source_distribution_targets(scan_id,installation_id,cursor_key)`,
 `CREATE OR REPLACE FUNCTION shared.resume_memory_source_distribution(p_kind TEXT,p_root TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT)
  RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE d shared.memory_source_distributions;BEGIN
   IF NOT shared.assert_memory_source_lease(p_kind,p_root,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_lease_lost';END IF;
   SELECT * INTO d FROM shared.memory_source_distributions WHERE(source_kind,root_key)=(p_kind,p_root);
   IF NOT FOUND OR d.work_revision<>p_revision OR d.control_revision<>shared.memory_source_control_snapshot()::bigint THEN RETURN NULL;END IF;
   RETURN jsonb_build_object('scanId',d.scan_id,'state',d.state,'cursor',d.cursor_key,'reset',FALSE,
    'dispatchCursor',d.dispatch_cursor,'dispatchComplete',d.dispatch_complete,'controlRevision',d.control_revision::text,'workRevision',d.work_revision::text);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.step_memory_source_distribution(p_kind TEXT,p_root TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT,p_scan UUID,p_after TEXT,p_limit INT)
  RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE d shared.memory_source_distributions;item RECORD;current_control BIGINT;page_count INT=0;BEGIN
   IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 OR p_after IS NULL OR length(p_after)>2048
    OR p_kind IS NULL OR p_kind NOT IN('relay_event','team_collaboration','team_delivery') THEN RAISE EXCEPTION 'invalid_source_distribution_page';END IF;
   IF NOT shared.assert_memory_source_lease(p_kind,p_root,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_lease_lost';END IF;
   current_control=shared.memory_source_control_snapshot()::bigint;
   SELECT * INTO d FROM shared.memory_source_distributions WHERE source_kind=p_kind AND root_key=p_root FOR UPDATE NOWAIT;
   IF FOUND AND(d.work_revision,d.control_revision) IS DISTINCT FROM(p_revision,current_control) THEN
    UPDATE shared.memory_source_distributions SET scan_id=gen_random_uuid(),work_revision=p_revision,control_revision=current_control,
     cursor_key='',state='scanning',dispatch_cursor='',dispatch_complete=FALSE,updated_at=clock_timestamp() WHERE source_kind=p_kind AND root_key=p_root RETURNING * INTO d;
    -- A changed authority snapshot requires a fresh cursor, never adoption of
    -- the old caller's page position. Old metadata remains auditable.
    UPDATE shared.memory_source_distributions current_scan SET claim_token=w.lease_token,claim_owner=w.lease_owner,claim_until=w.lease_until
     FROM shared.memory_source_work w WHERE(current_scan.source_kind,current_scan.root_key)=(p_kind,p_root) AND(w.source_kind,w.root_key)=(p_kind,p_root);
    RETURN jsonb_build_object('scanId',d.scan_id,'state',d.state,'cursor','','reset',TRUE,'controlRevision',d.control_revision::text,'workRevision',d.work_revision::text);
   ELSIF NOT FOUND THEN
    IF p_scan IS NOT NULL OR p_after<>'' THEN RAISE EXCEPTION 'source_distribution_cursor_changed';END IF;
    INSERT INTO shared.memory_source_distributions(source_kind,root_key,scan_id,work_revision,control_revision,state)
     VALUES(p_kind,p_root,gen_random_uuid(),p_revision,current_control,'scanning') RETURNING * INTO d;
   ELSE
    IF p_scan IS DISTINCT FROM d.scan_id OR p_after IS DISTINCT FROM d.cursor_key THEN RAISE EXCEPTION 'source_distribution_cursor_changed';END IF;
   END IF;
   UPDATE shared.memory_source_distributions current_scan SET claim_token=w.lease_token,claim_owner=w.lease_owner,claim_until=w.lease_until
    FROM shared.memory_source_work w WHERE(current_scan.source_kind,current_scan.root_key)=(p_kind,p_root) AND(w.source_kind,w.root_key)=(p_kind,p_root);
   IF d.state='scanning' THEN
    FOR item IN SELECT * FROM shared.enumerate_memory_source_targets(p_kind,p_root,d.cursor_key,p_limit) LOOP
     INSERT INTO shared.memory_source_distribution_targets(scan_id,cursor_key,installation_id,source_scope,source_version,target_mode,state)
      VALUES(d.scan_id,item.cursor_key,(item.source_scope->>'installationId')::uuid,item.source_scope,item.source_version,item.target_mode,item.state);
     d.cursor_key=item.cursor_key;page_count=page_count+1;
    END LOOP;
    -- An empty tail is an explicit exhaustion proof even for a full page.
    IF page_count=0 THEN d.state='sealed';END IF;
    UPDATE shared.memory_source_distributions SET cursor_key=d.cursor_key,state=d.state,updated_at=clock_timestamp()
     WHERE source_kind=p_kind AND root_key=p_root;
   END IF;
   IF NOT shared.assert_memory_source_lease(p_kind,p_root,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_lease_lost';END IF;
   IF NOT shared.guard_memory_control_commit(current_control) THEN RAISE EXCEPTION 'source_distribution_control_changed';END IF;
   RETURN jsonb_build_object('scanId',d.scan_id,'state',d.state,'cursor',d.cursor_key,'reset',FALSE,
    'controlRevision',d.control_revision::text,'workRevision',d.work_revision::text,'pageCount',page_count);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.dispatch_memory_source_distribution(p_kind TEXT,p_root TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT,p_scan UUID,p_after TEXT,p_limit INT)
  RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE d shared.memory_source_distributions;item RECORD;page_count INT=0;BEGIN
   IF p_scan IS NULL OR p_after IS NULL OR length(p_after)>2048 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid_source_dispatch_page';END IF;
   IF NOT shared.assert_memory_source_lease(p_kind,p_root,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_lease_lost';END IF;
   SELECT * INTO d FROM shared.memory_source_distributions WHERE source_kind=p_kind AND root_key=p_root FOR UPDATE NOWAIT;
   IF NOT FOUND OR d.scan_id<>p_scan OR d.work_revision<>p_revision OR d.state<>'sealed'
    OR d.control_revision<>shared.memory_source_control_snapshot()::bigint THEN RAISE EXCEPTION 'source_context_set_not_ready';END IF;
   IF d.dispatch_complete OR d.dispatch_cursor IS DISTINCT FROM p_after THEN RAISE EXCEPTION 'source_distribution_cursor_changed';END IF;
   UPDATE shared.memory_source_distributions current_scan SET claim_token=w.lease_token,claim_owner=w.lease_owner,claim_until=w.lease_until
    FROM shared.memory_source_work w WHERE(current_scan.source_kind,current_scan.root_key)=(p_kind,p_root) AND(w.source_kind,w.root_key)=(p_kind,p_root);
   FOR item IN SELECT * FROM shared.memory_source_distribution_targets t WHERE t.scan_id=p_scan
    AND t.cursor_key COLLATE "C">d.dispatch_cursor COLLATE "C" ORDER BY t.cursor_key COLLATE "C" LIMIT p_limit LOOP
    IF item.state='current' THEN
     INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
      VALUES(gen_random_uuid(),item.installation_id,'project_shared_source',
       'shared-source:'||p_scan::text||':'||encode(sha256(convert_to(item.cursor_key,'UTF8')),'hex'),52,
       jsonb_build_object('scope',item.source_scope,'root',jsonb_build_object('kind',p_kind,'key',p_root),'distribution_scan',p_scan::text,'target_cursor',item.cursor_key))
      ON CONFLICT DO NOTHING;
     IF item.target_mode='shared-active' THEN
      PERFORM shared.record_memory_source_dispatch(item.installation_id,(item.source_scope->>'modeGeneration')::bigint,p_kind,p_root,p_revision,
       COALESCE((item.source_scope->>'bindingRevision')::bigint,1),(item.source_scope->>'authorizationRevision')::bigint);
     END IF;
    END IF;
    -- Non-current targets remain explicit metadata for the separate bounded
    -- invalidation consumer; no positive source job is created for them.
    d.dispatch_cursor=item.cursor_key;page_count=page_count+1;
   END LOOP;
   IF NOT shared.guard_memory_control_commit(d.control_revision) THEN RAISE EXCEPTION 'source_distribution_control_changed';END IF;
   IF NOT shared.assert_memory_source_lease(p_kind,p_root,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_lease_lost';END IF;
   UPDATE shared.memory_source_distributions SET dispatch_cursor=d.dispatch_cursor,dispatch_complete=page_count=0,updated_at=clock_timestamp()
    WHERE source_kind=p_kind AND root_key=p_root;
   IF page_count=0 AND NOT shared.ack_memory_source_work(p_kind,p_root,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_lease_lost';END IF;
   RETURN jsonb_build_object('scanId',p_scan,'cursor',d.dispatch_cursor,'complete',page_count=0,'pageCount',page_count,'workRevision',p_revision::text);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.check_memory_source_distribution_commit() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE d shared.memory_source_distributions;BEGIN
   SELECT * INTO d FROM shared.memory_source_distributions WHERE(source_kind,root_key)=(NEW.source_kind,NEW.root_key);
   IF d.claim_until IS NULL OR d.claim_until<=clock_timestamp() OR NOT shared.guard_memory_control_commit(d.control_revision)
    THEN RAISE EXCEPTION 'source_distribution_commit_fence';END IF;
   IF d.dispatch_complete THEN
    IF NOT EXISTS(SELECT 1 FROM shared.memory_source_work WHERE(source_kind,root_key)=(d.source_kind,d.root_key) AND processed_revision>=d.work_revision)
     THEN RAISE EXCEPTION 'source_distribution_commit_fence';END IF;
   ELSIF NOT shared.assert_memory_source_lease(d.source_kind,d.root_key,d.claim_token,d.claim_owner,d.work_revision)
    THEN RAISE EXCEPTION 'source_distribution_commit_fence';END IF;
   RETURN NULL;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_source_distribution_commit ON shared.memory_source_distributions;
  CREATE CONSTRAINT TRIGGER memory_source_distribution_commit AFTER INSERT OR UPDATE ON shared.memory_source_distributions
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.check_memory_source_distribution_commit()`,
 `CREATE OR REPLACE FUNCTION shared.read_memory_source_context_set(p_kind TEXT,p_root TEXT,p_scan UUID,p_installation UUID,p_after TEXT,p_limit INT)
  RETURNS TABLE(cursor_key TEXT,source_scope JSONB,source_version JSONB,target_mode TEXT,state TEXT)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_scan IS NULL OR p_installation IS NULL OR p_after IS NULL OR length(p_after)>2048 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid_source_context_page';END IF;
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_distributions d WHERE d.source_kind=p_kind AND d.root_key=p_root AND d.scan_id=p_scan
    AND d.state='sealed' AND d.control_revision=shared.memory_source_control_snapshot()::bigint) THEN RAISE EXCEPTION 'source_context_set_not_ready';END IF;
   RETURN QUERY SELECT t.cursor_key,t.source_scope,t.source_version,t.target_mode,t.state FROM shared.memory_source_distribution_targets t
    WHERE t.scan_id=p_scan AND t.installation_id=p_installation AND t.cursor_key COLLATE "C">p_after COLLATE "C"
    ORDER BY t.cursor_key COLLATE "C" LIMIT p_limit;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.current_memory_source_distribution(p_kind TEXT,p_root TEXT,p_installation UUID) RETURNS JSONB
  LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
   SELECT jsonb_build_object('scanId',d.scan_id,'controlRevision',d.control_revision::text,'workRevision',d.work_revision::text,
    'targetCount',(SELECT count(*)::text FROM shared.memory_source_distribution_targets t WHERE t.scan_id=d.scan_id AND t.installation_id=p_installation))
   FROM shared.memory_source_distributions d JOIN shared.memory_source_work w USING(source_kind,root_key)
   WHERE d.source_kind=p_kind AND d.root_key=p_root AND d.state='sealed' AND d.work_revision=w.revision
    AND d.control_revision=shared.memory_source_control_snapshot()::bigint
  $$`,
 `REVOKE ALL ON FUNCTION shared.step_memory_source_distribution(TEXT,TEXT,UUID,TEXT,BIGINT,UUID,TEXT,INT),
  shared.read_memory_source_context_set(TEXT,TEXT,UUID,UUID,TEXT,INT),
  shared.resume_memory_source_distribution(TEXT,TEXT,UUID,TEXT,BIGINT),
  shared.current_memory_source_distribution(TEXT,TEXT,UUID),
  shared.dispatch_memory_source_distribution(TEXT,TEXT,UUID,TEXT,BIGINT,UUID,TEXT,INT),shared.check_memory_source_distribution_commit() FROM PUBLIC`,
 `UPDATE shared.memory_source_contract SET distribution_version=1 WHERE singleton`,
] as const
