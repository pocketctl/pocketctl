// Keep the capture query and the partial index predicate syntactically aligned.
// PG13 does not infer this predicate from event_type IN ('agent_text','turn_status')
// plus message_phase='final_answer'; it can scan a whole session for each delta.
const turnIndexMember = (prefix: '' | 'anchor.') =>
  `(${prefix}event_type IN('turn_status','user_text') OR ${prefix}event_type='agent_text' AND ${prefix}body_header->>'message_phase'='final_answer')`

// Generate separate static statements for INSERT/DELETE and UPDATE. Each uses
// only the transition relations that exist for that operation. PL/pgSQL can
// then reuse its prepared statement across many small writes on one connection.
const columns = ['session_id','logical_source_session_id','user_id','event_type','body_header','effect_status','source_classification']
const evidence = [...columns,'canonical_payload_hash','source_body_change_revision','source_header_version','source_sequence','owner_retired','created_at']
const cols = (alias:string,names:string[])=>names.map(name=>alias+'.'+name).join(',')
const changed = `(${cols('o',evidence)}) IS DISTINCT FROM (${cols('n',evidence)})`
const newRows = `SELECT ${columns.join(',')} FROM capture_new`
const updatedRows = ['n','o'].map(alias=>`SELECT ${cols(alias,columns)} FROM capture_old o JOIN capture_new n USING(id) WHERE ${changed}`).join(' UNION ALL ')
const unsafeControl = (alias:string)=>`${alias}.source_classification ? 'memory_source' AND
       (${alias}.source_classification#>>'{memory_source,skill_state}' IS DISTINCT FROM 'non_skill'
        OR ${alias}.source_classification#>>'{memory_source,lineage_complete}' IS DISTINCT FROM 'true'
        OR ${alias}.source_classification#>>'{memory_source,skill_invocation_id}' IS NOT NULL)`
const eligibleTurns = (changedRows: string) => `SELECT DISTINCT i.installation_id,e.session_id,e.logical_source_session_id AS logical,e.body_header->>'turn_id' AS turn
   FROM (${changedRows}) e JOIN public.extension_installations i ON i.owner_user_id=e.user_id
   JOIN shared.memory_dialogue_installations policy USING(installation_id)
   JOIN memory.memory_installations local USING(installation_id)
   JOIN public.sessions s ON s.session_id=e.session_id
   WHERE i.status='active' AND i.owner_scope_kind='personal' AND i.provider_id='pocketctl-memory'
   AND local.local_status NOT IN('purging','purged','integrity_error') AND local.relay_status='active'
   AND NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones d WHERE d.installation_id=i.installation_id AND d.session_id=e.logical_source_session_id)
   AND NOT COALESCE(s.is_subagent,FALSE) AND e.body_header->>'turn_id'<>'' AND (
    (${unsafeControl('e')}) OR (e.body_header->>'actor_scope'='root' AND e.effect_status IN('completed','none')
     AND (e.body_header ? 'dialogue_operation' OR e.event_type IN('turn_status','user_text')
      OR e.event_type='agent_text' AND (e.body_header->>'message_phase'='final_answer'
       OR e.body_header ? 'stream_id' OR e.body_header ? 'dialogue_message_id'))))
   ORDER BY 1,2,3,4`

/** Terminal notification and effective input changes are durable in the event
 * transaction. Completion headers can arrive after the initial INSERT. */
export const TURN_DIALOGUE_INDEXES = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS events_dialogue_turn ON public.events
   (session_id,(body_header->>'turn_id'),event_type,id)
   WHERE ${turnIndexMember('')} AND body_header->>'actor_scope'='root'`,
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

export const TURN_DIALOGUE_CAPTURE_FUNCTION = `CREATE OR REPLACE FUNCTION shared.capture_turn_dialogue() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE r RECORD;term RECORD;affected refcursor;tracked BOOLEAN;BEGIN
   -- Dialogue generation capture v2. Negative invocation evidence participates
   -- even when the row itself cannot be admitted as a published message.
   IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM capture_new e WHERE e.effect_status IN('completed','none') OR (${unsafeControl('e')})) THEN RETURN NULL;END IF;
   ELSIF TG_OP='UPDATE' THEN
    IF NOT EXISTS(SELECT 1 FROM capture_old e WHERE e.effect_status IN('completed','none') OR (${unsafeControl('e')}))
     AND NOT EXISTS(SELECT 1 FROM capture_new e WHERE e.effect_status IN('completed','none') OR (${unsafeControl('e')})) THEN RETURN NULL;END IF;
   END IF;
  IF NOT EXISTS(SELECT 1 FROM shared.memory_dialogue_installations) THEN RETURN NULL;END IF;
  IF TG_OP='UPDATE' THEN OPEN affected FOR ${eligibleTurns(updatedRows)};
  ELSE OPEN affected FOR ${eligibleTurns(newRows)}; END IF;
  LOOP
   FETCH affected INTO r;
   EXIT WHEN NOT FOUND;
   PERFORM pg_advisory_xact_lock(hashtextextended('turn-dialogue:'||r.installation_id::text||':'||r.logical||':'||r.turn,0));
   SELECT e.id INTO term FROM public.events e JOIN shared.memory_dialogue_installations policy ON policy.installation_id=r.installation_id
    WHERE e.session_id=r.session_id AND e.event_type='turn_status' AND e.body_header->>'actor_scope'='root'
     AND e.body_header->>'turn_id'=r.turn AND e.body_header->>'turn_status' IN('completed','failed','interrupted','abandoned')
     AND e.effect_status IN('completed','none') AND e.created_at>=policy.enabled_at ORDER BY e.id DESC LIMIT 1;
   IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM memory.work_episodes w WHERE w.installation_id=r.installation_id
     AND w.session_id=r.logical AND w.turn_id=r.turn AND w.compiler_version='relay-turn-v1')
    AND NOT EXISTS(SELECT 1 FROM shared.memory_dialogue_pending p WHERE (p.installation_id,p.session_id,p.turn_id)=(r.installation_id,r.logical,r.turn))
    AND NOT EXISTS(SELECT 1 FROM memory.memory_jobs j WHERE j.installation_id=r.installation_id AND j.job_type='compile_episode'
      AND j.idempotency_key='dialogue:'||encode(sha256(convert_to(jsonb_build_array(r.logical,r.turn)::text,'UTF8')),'hex'))
    THEN
     -- During a rolling upgrade older databases still have only the pending
     -- table. Once installed, the durable turn survives job detail retention.
     tracked=FALSE;
     IF to_regclass('memory.memory_dialogue_turns') IS NOT NULL THEN
      SELECT EXISTS(SELECT 1 FROM memory.memory_dialogue_turns g WHERE
       (g.installation_id,g.session_id,g.turn_id)=(r.installation_id,r.logical,r.turn)) INTO tracked;
     END IF;
     IF NOT tracked THEN CONTINUE;END IF;
   END IF;
   INSERT INTO shared.memory_dialogue_pending(installation_id,session_id,turn_id)
    VALUES(r.installation_id,r.logical,r.turn) ON CONFLICT(installation_id,session_id,turn_id)
    DO UPDATE SET touched_at=clock_timestamp();
  END LOOP;CLOSE affected;RETURN NULL;
 END $$`

export const TURN_DIALOGUE_CAPTURE = [
  TURN_DIALOGUE_CAPTURE_FUNCTION,
  `REVOKE ALL ON FUNCTION shared.capture_turn_dialogue() FROM PUBLIC`,
  ...['INSERT', 'UPDATE', 'DELETE'].map(
    (op) => `DROP TRIGGER IF EXISTS turn_dialogue_${op.toLowerCase()} ON public.events;
  CREATE TRIGGER turn_dialogue_${op.toLowerCase()} AFTER ${op} ON public.events
   REFERENCING ${op === 'UPDATE' ? 'OLD TABLE AS capture_old NEW' : op === 'DELETE' ? 'OLD' : 'NEW'} TABLE AS capture_new FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_turn_dialogue()`,
  ),
] as const
