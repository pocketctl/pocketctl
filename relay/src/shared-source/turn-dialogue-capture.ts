/** Terminal notification and effective input changes are durable in the event
 * transaction. Completion headers can arrive after the initial INSERT. */
export const TURN_DIALOGUE_INDEXES = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS events_dialogue_turn ON public.events
   (session_id,(body_header->>'turn_id'),event_type,id)
   WHERE (event_type IN('turn_status','user_text') OR event_type='agent_text' AND body_header->>'message_phase'='final_answer') AND body_header->>'actor_scope'='root'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS events_dialogue_control ON public.events(session_id,(body_header->>'turn_id'),id)
   WHERE source_classification ? 'memory_source' AND (source_classification#>>'{memory_source,skill_state}' IS DISTINCT FROM 'non_skill'
    OR source_classification#>>'{memory_source,lineage_complete}' IS DISTINCT FROM 'true' OR source_classification#>>'{memory_source,skill_invocation_id}' IS NOT NULL)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS events_dialogue_operation ON public.events(session_id,(body_header->>'turn_id'),id)
   WHERE body_header ? 'dialogue_operation' OR source_classification ? 'memory_source' AND (
    source_classification#>>'{memory_source,skill_state}'='skill' OR source_classification#>>'{memory_source,skill_invocation_id}' IS NOT NULL)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS events_dialogue_message ON public.events(session_id,(body_header->>'turn_id'),(body_header->>'dialogue_message_id'))
   WHERE event_type='agent_text' AND body_header->>'actor_scope'='root' AND body_header ? 'dialogue_message_id'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS events_dialogue_stream ON public.events
   (session_id,(body_header->>'turn_id'),(body_header->>'stream_id'),id)
   WHERE event_type='agent_text' AND body_header->>'actor_scope'='root'`,
] as const

export const TURN_DIALOGUE_CAPTURE = [
  `CREATE OR REPLACE FUNCTION shared.capture_turn_dialogue() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE r RECORD;term RECORD;changes TEXT;BEGIN
  IF NOT EXISTS(SELECT 1 FROM shared.memory_dialogue_installations) THEN RETURN NULL;END IF;
  changes='SELECT session_id,logical_source_session_id,user_id,event_type,body_header,effect_status,source_classification FROM capture_new';
  IF TG_OP='UPDATE' THEN
   changes=changes||' UNION ALL SELECT o.session_id,o.logical_source_session_id,o.user_id,o.event_type,o.body_header,o.effect_status,o.source_classification
    FROM capture_old o JOIN capture_new n USING(id) WHERE
    (o.body_header,o.effect_status,o.source_classification,o.session_id,o.logical_source_session_id,o.user_id)
     IS DISTINCT FROM (n.body_header,n.effect_status,n.source_classification,n.session_id,n.logical_source_session_id,n.user_id)';
  END IF;
  FOR r IN EXECUTE format($changed$SELECT DISTINCT i.installation_id,e.session_id,e.logical_source_session_id AS logical,e.body_header->>'turn_id' AS turn
   FROM (%s) e JOIN public.extension_installations i ON i.owner_user_id=e.user_id
   JOIN shared.memory_dialogue_installations policy USING(installation_id)
   JOIN memory.memory_installations local USING(installation_id)
   JOIN public.sessions s ON s.session_id=e.session_id
   WHERE i.status='active' AND i.owner_scope_kind='personal' AND i.provider_id='pocketctl-memory'
   AND NOT COALESCE(s.is_subagent,FALSE) AND e.body_header->>'actor_scope'='root'
   AND e.effect_status IN('completed','none') AND e.body_header->>'turn_id'<>''
   AND (e.body_header ? 'dialogue_operation' OR e.event_type='user_text' OR e.event_type='turn_status' AND e.body_header->>'turn_status' IN('completed','failed','interrupted','abandoned')
    OR e.event_type='agent_text' AND (e.body_header->>'message_phase'='final_answer' OR
       EXISTS(SELECT 1 FROM public.events anchor WHERE anchor.session_id=e.session_id AND anchor.event_type IN('agent_text','turn_status')
        AND anchor.body_header->>'turn_id'=e.body_header->>'turn_id' AND anchor.body_header->>'actor_scope'='root'
        AND anchor.body_header->>'message_phase'='final_answer' AND
        (anchor.body_header->>'stream_id'=e.body_header->>'stream_id' OR anchor.body_header->>'dialogue_message_id'=e.body_header->>'dialogue_message_id')))
    OR e.source_classification ? 'memory_source' AND
       (e.source_classification#>>'{memory_source,skill_state}' IS DISTINCT FROM 'non_skill'
        OR e.source_classification#>>'{memory_source,lineage_complete}' IS DISTINCT FROM 'true'
        OR e.source_classification#>>'{memory_source,skill_invocation_id}' IS NOT NULL))
   ORDER BY 1,2,3,4$changed$,changes) LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('turn-dialogue:'||r.installation_id::text||':'||r.turn,0));
   SELECT e.id INTO term FROM public.events e JOIN shared.memory_dialogue_installations policy ON policy.installation_id=r.installation_id
    WHERE e.session_id=r.session_id AND e.event_type='turn_status' AND e.body_header->>'actor_scope'='root'
     AND e.body_header->>'turn_id'=r.turn AND e.body_header->>'turn_status' IN('completed','failed','interrupted','abandoned')
     AND e.effect_status IN('completed','none') AND e.created_at>=policy.enabled_at ORDER BY e.id DESC LIMIT 1;
   IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM memory.work_episodes w WHERE w.installation_id=r.installation_id
     AND w.session_id=r.logical AND w.turn_id=r.turn AND w.compiler_version='relay-turn-v1') THEN CONTINUE; END IF;
   INSERT INTO shared.memory_dialogue_pending(installation_id,session_id,turn_id)
    VALUES(r.installation_id,r.logical,r.turn) ON CONFLICT(installation_id,session_id,turn_id)
    DO UPDATE SET touched_at=clock_timestamp();
  END LOOP;RETURN NULL;
 END $$`,
  `REVOKE ALL ON FUNCTION shared.capture_turn_dialogue() FROM PUBLIC`,
  ...['INSERT', 'UPDATE', 'DELETE'].map(
    (op) => `DROP TRIGGER IF EXISTS turn_dialogue_${op.toLowerCase()} ON public.events;
  CREATE TRIGGER turn_dialogue_${op.toLowerCase()} AFTER ${op} ON public.events
   REFERENCING ${op === 'UPDATE' ? 'OLD TABLE AS capture_old NEW' : op === 'DELETE' ? 'OLD' : 'NEW'} TABLE AS capture_new FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_turn_dialogue()`,
  ),
] as const
