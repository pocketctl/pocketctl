// The append classifier runs first (PostgreSQL orders statement triggers by
// name). Record only statements guaranteed to have dirtied this exact root.
// An unclassified revision breaks the chain, including mixed update/delete,
// ownership changes and dirty publications outside public.events.
export const OFFLINE_PROJECTION_CAPTURE = [
 `CREATE OR REPLACE FUNCTION shared.capture_memory_projection_window() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE
  r RECORD; w shared.memory_projection_windows; rev BIGINT; late BIGINT[]; sid TEXT;
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM shared.memory_projection_policies) THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' THEN
   IF EXISTS(
    SELECT 1 FROM capture_new n FULL JOIN capture_old o USING(id)
    WHERE n.id IS NULL OR o.id IS NULL OR (n.user_id,n.session_id) IS DISTINCT FROM (o.user_id,o.session_id)
     OR (COALESCE(o.effect_status='pending' AND n.effect_status='completed',FALSE)
      OR (o.source_header_version IS NULL AND n.source_header_version=1 AND n.effect_status IN('none','completed')
       AND (n.owner_retired,n.created_at,n.event_type,n.source_body_change_revision,n.effect_status)
        IS NOT DISTINCT FROM (o.owner_retired,o.created_at,o.event_type,o.source_body_change_revision,o.effect_status))) IS NOT TRUE)
   THEN RETURN NULL; END IF;
  END IF;
  FOR r IN SELECT e.user_id,e.session_id,min(e.id) AS lo,max(e.id) AS hi FROM capture_new e
    WHERE e.effect_status IN('none','completed') AND e.user_id>0 AND length(e.session_id) BETWEEN 1 AND 512
     AND e.session_id NOT LIKE 'pending-%' AND e.session_id NOT LIKE 'app-review-demo-%'
     AND NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.session_id=e.session_id AND s.source='app_review_demo')
     AND EXISTS(SELECT 1 FROM shared.memory_projection_policies p JOIN public.extension_installations i USING(installation_id)
      WHERE i.owner_user_id=e.user_id)
    GROUP BY e.user_id,e.session_id ORDER BY e.user_id,e.session_id LOOP
   sid=r.user_id::text||':'||r.session_id;
   SELECT revision INTO STRICT rev FROM shared.memory_source_work WHERE source_kind='relay_event' AND root_key=sid;
   SELECT * INTO w FROM shared.memory_projection_windows WHERE root_key=sid;
   IF w.last_revision IS DISTINCT FROM rev-1 THEN w=NULL; END IF;
   late=COALESCE(w.late_ids,'{}'::bigint[]);
   IF TG_OP='INSERT' THEN
    w.first_id=least(w.first_id,r.lo);w.last_id=greatest(w.last_id,r.hi);
   ELSE
    -- Publishing the header of a captured event is part of the same range.
    -- Historical header repairs outside this window require reconciliation.
    IF EXISTS(SELECT 1 FROM capture_new n JOIN capture_old o USING(id)
      WHERE n.user_id=r.user_id AND n.session_id=r.session_id AND o.effect_status<>'pending'
       AND NOT(COALESCE(n.id BETWEEN w.first_id AND w.last_id,FALSE) OR n.id=ANY(late))) THEN CONTINUE; END IF;
    SELECT ARRAY(SELECT DISTINCT id FROM (
      SELECT unnest(late) AS id UNION ALL SELECT n.id FROM capture_new n JOIN capture_old o USING(id)
       WHERE n.user_id=r.user_id AND n.session_id=r.session_id AND o.effect_status='pending') q
      WHERE NOT COALESCE(id BETWEEN w.first_id AND w.last_id,FALSE) ORDER BY id LIMIT 65) INTO late;
    IF cardinality(late)>64 THEN CONTINUE; END IF;
   END IF;
   INSERT INTO shared.memory_projection_windows(root_key,first_revision,last_revision,first_id,last_id,late_ids,due_at)
    VALUES(sid,COALESCE(w.first_revision,rev),rev,w.first_id,w.last_id,late,
      COALESCE(w.due_at,to_timestamp((floor(extract(epoch FROM statement_timestamp())/300)+1)*300)))
    ON CONFLICT(root_key) DO UPDATE SET first_revision=excluded.first_revision,last_revision=excluded.last_revision,
     first_id=excluded.first_id,last_id=excluded.last_id,late_ids=excluded.late_ids,due_at=excluded.due_at;
  END LOOP;
  RETURN NULL;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.capture_memory_projection_window() FROM PUBLIC`,
 ...['INSERT','UPDATE'].map(op=>`DROP TRIGGER IF EXISTS memory_window_capture_${op.toLowerCase()} ON public.events;
  CREATE TRIGGER memory_window_capture_${op.toLowerCase()} AFTER ${op} ON public.events
   REFERENCING NEW TABLE AS capture_new ${op==='UPDATE'?'OLD TABLE AS capture_old':''}
   FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_projection_window()`),
] as const
