/** Reuse the trusted native bootstrap enumerators. A control change can
 * redistribute old roots even when no new event will ever arrive. */
export const SHARED_SOURCE_BOOTSTRAP_FUNCTIONS=[
 `CREATE TABLE IF NOT EXISTS shared.memory_source_control_progress(
  control_kind TEXT NOT NULL,control_key TEXT NOT NULL,claimed_revision BIGINT NOT NULL CHECK(claimed_revision>0),
  control_revision BIGINT NOT NULL CHECK(control_revision>0),phase TEXT NOT NULL CHECK(phase IN('personal','collaboration','delivery','known','complete')),
  cursor_key TEXT NOT NULL DEFAULT '',cursor_kind TEXT NOT NULL DEFAULT '',
  claim_token UUID NOT NULL,claim_owner TEXT NOT NULL,claim_until TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(control_kind,control_key),
  FOREIGN KEY(control_kind,control_key) REFERENCES shared.memory_source_control_work(control_kind,control_key))`,
 `CREATE OR REPLACE FUNCTION shared.step_memory_control_bootstrap(p_kind TEXT,p_key TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT,p_limit INT)
  RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE progress shared.memory_source_control_progress;item RECORD;current_control BIGINT;page_count INT=0;admitted_until TIMESTAMPTZ;BEGIN
   IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid_control_bootstrap_page';END IF;
   IF NOT shared.assert_memory_control_lease(p_kind,p_key,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_control_lease_lost';END IF;
   PERFORM shared.assert_memory_control_capture();
   current_control=shared.memory_source_control_snapshot()::bigint;
   SELECT lease_until INTO admitted_until FROM shared.memory_source_control_work WHERE(control_kind,control_key)=(p_kind,p_key);
   SELECT * INTO progress FROM shared.memory_source_control_progress WHERE(control_kind,control_key)=(p_kind,p_key) FOR UPDATE NOWAIT;
   IF NOT FOUND OR(progress.claimed_revision,progress.control_revision) IS DISTINCT FROM(p_revision,current_control) THEN
    INSERT INTO shared.memory_source_control_progress(control_kind,control_key,claimed_revision,control_revision,phase,claim_token,claim_owner,claim_until)
     VALUES(p_kind,p_key,p_revision,current_control,'personal',p_token,p_worker,admitted_until)
     ON CONFLICT(control_kind,control_key) DO UPDATE SET claimed_revision=p_revision,control_revision=current_control,phase='personal',
      cursor_key='',cursor_kind='',claim_token=p_token,claim_owner=p_worker,claim_until=admitted_until RETURNING * INTO progress;
   END IF;
   IF progress.phase='personal' THEN
    FOR item IN SELECT * FROM shared.bootstrap_memory_relay_roots(COALESCE(NULLIF(progress.cursor_key,''),'0')::bigint,p_limit) LOOP
     progress.cursor_key=GREATEST(COALESCE(NULLIF(progress.cursor_key,''),'0')::bigint,item.session_row_id::bigint)::text;page_count=page_count+1;
    END LOOP;
    IF page_count=0 THEN progress.phase='collaboration';progress.cursor_key='';END IF;
   ELSIF progress.phase IN('collaboration','delivery') THEN
    FOR item IN SELECT * FROM shared.bootstrap_memory_team_roots(CASE WHEN progress.phase='collaboration' THEN 'team_collaboration' ELSE 'team_delivery' END,progress.cursor_key,p_limit) LOOP
     progress.cursor_key=item.root_key;page_count=page_count+1;
    END LOOP;
    IF page_count=0 THEN progress.phase=CASE WHEN progress.phase='collaboration' THEN 'delivery' ELSE 'known' END;progress.cursor_key='';END IF;
   ELSIF progress.phase='known' THEN
    -- Include deleted/revoked historical roots as invalidation/distribution
    -- candidates. Authority adapters decide availability; no body is read.
    FOR item IN SELECT source_kind,root_key FROM shared.memory_source_work
     WHERE source_kind IN('relay_event','team_collaboration','team_delivery')
      AND(source_kind COLLATE "C",root_key COLLATE "C")>(progress.cursor_kind COLLATE "C",progress.cursor_key COLLATE "C")
     ORDER BY source_kind COLLATE "C",root_key COLLATE "C" LIMIT p_limit LOOP
     PERFORM shared.mark_memory_source_dirty(item.source_kind,item.root_key);
     progress.cursor_kind=item.source_kind;progress.cursor_key=item.root_key;page_count=page_count+1;
    END LOOP;
    IF page_count=0 THEN progress.phase='complete';END IF;
   ELSE RAISE EXCEPTION 'source_control_lease_lost';END IF;
   IF NOT shared.guard_memory_control_commit(current_control) THEN RAISE EXCEPTION 'source_control_bootstrap_changed';END IF;
   IF NOT shared.assert_memory_control_lease(p_kind,p_key,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_control_lease_lost';END IF;
   UPDATE shared.memory_source_control_progress SET phase=progress.phase,cursor_key=progress.cursor_key,cursor_kind=progress.cursor_kind,
    claim_token=p_token,claim_owner=p_worker,claim_until=admitted_until,updated_at=clock_timestamp() WHERE(control_kind,control_key)=(p_kind,p_key);
   IF progress.phase='complete' AND NOT shared.ack_memory_control_work(p_kind,p_key,p_token,p_worker,p_revision) THEN RAISE EXCEPTION 'source_control_lease_lost';END IF;
   RETURN jsonb_build_object('phase',progress.phase,'cursor',progress.cursor_key,'pageCount',page_count,'complete',progress.phase='complete',
    'controlRevision',current_control::text,'claimedRevision',p_revision::text);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.check_memory_control_bootstrap_commit() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE progress shared.memory_source_control_progress;BEGIN
   SELECT * INTO progress FROM shared.memory_source_control_progress WHERE(control_kind,control_key)=(NEW.control_kind,NEW.control_key);
   IF progress.claim_until<=clock_timestamp() OR NOT shared.guard_memory_control_commit(progress.control_revision) THEN RAISE EXCEPTION 'source_control_bootstrap_commit_fence';END IF;
   IF progress.phase='complete' THEN
    IF NOT EXISTS(SELECT 1 FROM shared.memory_source_control_work WHERE(control_kind,control_key)=(progress.control_kind,progress.control_key)
     AND processed_revision>=progress.claimed_revision) THEN RAISE EXCEPTION 'source_control_bootstrap_commit_fence';END IF;
   ELSIF NOT shared.assert_memory_control_lease(progress.control_kind,progress.control_key,progress.claim_token,progress.claim_owner,progress.claimed_revision)
    THEN RAISE EXCEPTION 'source_control_bootstrap_commit_fence';END IF;
   RETURN NULL;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_control_bootstrap_commit ON shared.memory_source_control_progress;
  CREATE CONSTRAINT TRIGGER memory_control_bootstrap_commit AFTER INSERT OR UPDATE ON shared.memory_source_control_progress
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.check_memory_control_bootstrap_commit()`,
 `REVOKE ALL ON FUNCTION shared.step_memory_control_bootstrap(TEXT,TEXT,UUID,TEXT,BIGINT,INT),shared.check_memory_control_bootstrap_commit() FROM PUBLIC`,
] as const
