/** Separate Team authority and typed normalized inputs, never personal events
 * or transient Feed bodies. No file bytes/manifest/evidence are returned. */
export const SHARED_TEAM_READER_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_team_installation(p_scope JSONB) RETURNS JSONB
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE i RECORD;principal INT;BEGIN
   principal=(p_scope->>'principalUserId')::int;
   IF EXISTS(SELECT 1 FROM memory.memory_installations WHERE installation_id=(p_scope->>'installationId')::uuid AND local_status IN ('purging','purged','integrity_error')) THEN RETURN NULL;END IF;
   IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=principal AND team_enabled)
    OR NOT EXISTS(SELECT 1 FROM public.extension_providers WHERE provider_id='pocketctl-memory' AND status='enabled') THEN RETURN NULL;END IF;
   SELECT * INTO i FROM public.extension_installations WHERE installation_id=(p_scope->>'installationId')::uuid
    AND provider_id='pocketctl-memory' AND status='active' AND owner_scope_kind=p_scope->>'ownerScopeKind' AND owner_scope_id::text=p_scope->>'ownerScopeId'
    AND authorization_epoch::text=p_scope->>'authorizationRevision' AND config_version::text=p_scope->>'configVersion'
    AND granted_scopes @> ARRAY['session:events:read']::text[] AND enabled_services @> ARRAY['memory.manage']::text[];
   IF NOT FOUND THEN RETURN NULL;END IF;
   IF i.owner_scope_kind='personal' THEN IF i.owner_user_id IS DISTINCT FROM principal THEN RETURN NULL;END IF;
   ELSIF i.owner_scope_kind IN ('team','organization') THEN
    IF NOT EXISTS(SELECT 1 FROM public.extension_scope_memberships WHERE scope_kind=i.owner_scope_kind AND scope_id=i.owner_scope_id
     AND user_id=principal AND state='active' AND roles && ARRAY['reader','contributor','reviewer','publisher','scope_administrator']::text[]) THEN RETURN NULL;END IF;
    IF i.owner_scope_kind='organization' AND NOT EXISTS(SELECT 1 FROM public.extension_organizations WHERE organization_id=i.owner_scope_id AND state='active') THEN RETURN NULL;END IF;
    IF i.owner_scope_kind='team' AND NOT EXISTS(SELECT 1 FROM public.extension_teams t JOIN public.extension_organizations o USING(organization_id) WHERE t.team_id=i.owner_scope_id AND t.state='active' AND o.state='active') THEN RETURN NULL;END IF;
   ELSE RETURN NULL;END IF;
   IF EXISTS(SELECT 1 FROM memory.memory_scope_tombstones tombstone WHERE tombstone.owner_scope_kind=i.owner_scope_kind AND tombstone.owner_scope_id=i.owner_scope_id
    AND tombstone.authorization_epoch>=CASE i.owner_scope_kind WHEN 'team' THEN(SELECT authorization_epoch FROM public.extension_teams WHERE team_id=i.owner_scope_id) WHEN 'organization' THEN(SELECT authorization_epoch FROM public.extension_organizations WHERE organization_id=i.owner_scope_id) ELSE i.authorization_epoch END) THEN RETURN NULL;END IF;
   IF jsonb_typeof(i.event_filter) IS DISTINCT FROM 'object' OR i.event_filter-'daemon_ids'-'agent_types'<>'{}'::jsonb
    OR (i.event_filter ? 'daemon_ids' AND jsonb_typeof(i.event_filter->'daemon_ids') IS DISTINCT FROM 'array')
    OR (i.event_filter ? 'agent_types' AND jsonb_typeof(i.event_filter->'agent_types') IS DISTINCT FROM 'array') THEN RETURN NULL;END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(i.event_filter->'daemon_ids','[]')||COALESCE(i.event_filter->'agent_types','[]')) e WHERE jsonb_typeof(e)<>'string') THEN RETURN NULL;END IF;
   IF COALESCE(i.event_filter->'agent_types','[]')<>'[]'::jsonb AND NOT(i.event_filter->'agent_types' ? 'team_collaboration') THEN RETURN NULL;END IF;
   RETURN jsonb_build_object('authorization',i.authorization_epoch::text,'eventFilter',i.event_filter);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_team_source_authority(p_scope JSONB,p_kind TEXT,p_root TEXT)
  RETURNS TABLE(state TEXT,content_revision TEXT,authorization_revision TEXT,storage_revision TEXT,context JSONB)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE i JSONB;a RECORD;d RECORD;m RECORD;w RECORD;call_key TEXT;turn_key TEXT;BEGIN
   IF p_kind NOT IN ('team_collaboration','team_delivery') THEN RETURN QUERY SELECT 'revoked','0','0','0',NULL::jsonb;RETURN;END IF;
   i=shared.memory_team_installation(p_scope);
   IF i IS NULL THEN RETURN QUERY SELECT 'revoked','0','0','0',NULL::jsonb;RETURN;END IF;
   SELECT mode,generation INTO m FROM shared.memory_source_modes WHERE installation_id=(p_scope->>'installationId')::uuid;
   IF NOT FOUND OR m.mode NOT IN ('shared-shadow','shared-active') OR m.generation::text IS DISTINCT FROM p_scope->>'modeGeneration' THEN RETURN QUERY SELECT 'changed','0',i->>'authorization','0',NULL::jsonb;RETURN;END IF;
   call_key=p_root;
   IF p_kind='team_delivery' THEN
    SELECT r.*,s.source_call_id INTO d FROM public.team_delivery_memory_sources r JOIN public.team_task_submissions s USING(submission_id)
     WHERE r.source_session_id=p_root AND r.reader_user_id=(p_scope->>'principalUserId')::int;
    IF NOT FOUND OR d.revoked_at IS NOT NULL OR d.withdrawn_at IS NOT NULL THEN RETURN QUERY SELECT 'revoked','0',i->>'authorization','0',NULL::jsonb;RETURN;END IF;
    call_key=d.source_call_id;
    turn_key='team-delivery:'||d.submission_id::text||':'||d.decision_id::text;
   END IF;
   SELECT c.call_id,c.offer_id,c.task_id,c.state AS call_state,c.event_id,c.context_version::text,s.team_session_id,s.team_id,
    b.installation_id::text AS target_installation_id,b.owner_scope_kind AS target_owner_scope_kind,b.owner_scope_id::text AS target_owner_scope_id,
    b.binding_id,b.revision::text AS binding_revision,p.revision::text AS participant_revision
    INTO a FROM public.collaboration_calls c JOIN public.collaboration_sessions s USING(team_session_id)
     JOIN public.collaboration_teams t ON t.team_id=s.team_id
     JOIN public.team_memory_bindings b ON b.team_id=s.team_id
     JOIN public.extension_installations target ON target.installation_id=b.installation_id AND target.provider_id='pocketctl-memory' AND target.status='active'
      AND target.owner_scope_kind=b.owner_scope_kind AND target.owner_scope_id=b.owner_scope_id
     JOIN public.collaboration_session_participants p ON p.team_session_id=s.team_session_id AND p.user_id=(p_scope->>'principalUserId')::int
     JOIN public.collaboration_team_memberships member ON member.team_id=s.team_id AND member.user_id=p.user_id
    WHERE c.call_id=call_key
     AND (p_scope->>'ownerScopeKind'='personal' OR (b.installation_id=(p_scope->>'installationId')::uuid AND b.owner_scope_kind=p_scope->>'ownerScopeKind' AND b.owner_scope_id::text=p_scope->>'ownerScopeId'))
     AND (b.owner_scope_kind='personal'
      OR b.owner_scope_kind='organization' AND EXISTS(SELECT 1 FROM public.extension_organizations org WHERE org.organization_id=b.owner_scope_id AND org.state='active')
      OR b.owner_scope_kind='team' AND EXISTS(SELECT 1 FROM public.extension_teams et JOIN public.extension_organizations org USING(organization_id) WHERE et.team_id=b.owner_scope_id AND et.state='active' AND org.state='active'))
     AND NOT EXISTS(SELECT 1 FROM memory.memory_scope_tombstones tombstone WHERE tombstone.owner_scope_kind=b.owner_scope_kind AND tombstone.owner_scope_id=b.owner_scope_id
      AND tombstone.authorization_epoch>=CASE b.owner_scope_kind WHEN 'team' THEN(SELECT authorization_epoch FROM public.extension_teams WHERE team_id=b.owner_scope_id) WHEN 'organization' THEN(SELECT authorization_epoch FROM public.extension_organizations WHERE organization_id=b.owner_scope_id) ELSE target.authorization_epoch END)
     AND s.state IN ('active','paused') AND t.state='active' AND b.state='active' AND p.state='active' AND member.state='active'
     AND b.revision::text=p_scope->>'bindingRevision' AND p.revision::text=p_scope->>'participantRevision';
   IF NOT FOUND THEN RETURN QUERY SELECT 'revoked','0',i->>'authorization','0',NULL::jsonb;RETURN;END IF;
   IF COALESCE(i->'eventFilter'->'daemon_ids','[]')<>'[]'::jsonb AND NOT EXISTS(SELECT 1 FROM public.team_agent_offers offer WHERE offer.offer_id=a.offer_id AND i->'eventFilter'->'daemon_ids' ? offer.daemon_id) THEN RETURN QUERY SELECT 'revoked','0',i->>'authorization','0',NULL::jsonb;RETURN;END IF;
   IF p_kind='team_collaboration' AND a.call_state NOT IN ('completed','failed','cancelled','blocked') THEN RETURN QUERY SELECT 'changed','0',i->>'authorization','0',NULL::jsonb;RETURN;END IF;
   IF p_kind='team_delivery' THEN
    IF d.binding_id IS DISTINCT FROM a.binding_id OR d.binding_revision::text IS DISTINCT FROM a.binding_revision
     OR d.participant_revision::text IS DISTINCT FROM a.participant_revision OR d.team_session_id IS DISTINCT FROM a.team_session_id OR d.team_id IS DISTINCT FROM a.team_id
     OR NOT EXISTS(SELECT 1 FROM public.team_acceptance_decisions decision JOIN public.team_task_submissions submission ON submission.submission_id=decision.submission_id
      JOIN public.team_task_specs spec ON spec.task_id=submission.task_id AND spec.revision=submission.spec_revision AND spec.reviewer_user_id=decision.reviewer_user_id
      WHERE decision.decision_id=d.decision_id AND decision.decision='accepted' AND submission.submission_id=d.submission_id AND submission.state='published'
       AND decision.task_id=submission.task_id AND decision.spec_revision=submission.spec_revision AND submission.source_call_id=a.call_id AND submission.task_id=a.task_id AND submission.source_offer_id=a.offer_id AND submission.context_version::text=a.context_version)
     OR EXISTS(SELECT 1 FROM public.team_delivery_memory_withdrawals withdrawal_record WHERE(withdrawal_record.team_id,withdrawal_record.team_session_id,withdrawal_record.submission_id,withdrawal_record.decision_id)=(d.team_id,d.team_session_id,d.submission_id,d.decision_id))
     OR EXISTS(SELECT 1 FROM memory.memory_team_delivery_withdrawals withdrawal_record WHERE(withdrawal_record.team_id,withdrawal_record.team_session_id,withdrawal_record.submission_id,withdrawal_record.decision_id)=(d.team_id,d.team_session_id,d.submission_id,d.decision_id))
     OR EXISTS(SELECT 1 FROM public.team_artifact_revocations WHERE submission_id=d.submission_id) THEN RETURN QUERY SELECT 'revoked','0',i->>'authorization','0',NULL::jsonb;RETURN;END IF;
   END IF;
   SELECT revision,work.storage_revision INTO w FROM shared.memory_source_work work WHERE source_kind=p_kind AND root_key=p_root;
   IF NOT FOUND THEN RETURN QUERY SELECT 'changed','0',i->>'authorization','0',NULL::jsonb;RETURN;END IF;
   IF turn_key IS NULL THEN turn_key='team-call:'||a.call_id;END IF;
   RETURN QUERY SELECT 'current',w.revision::text,i->>'authorization',
    (w.storage_revision+COALESCE((SELECT rights.revision FROM shared.memory_local_source_rights rights WHERE rights.installation_id=(p_scope->>'installationId')::uuid),0))::text,
    jsonb_build_object('teamId',a.team_id,'teamSessionId',a.team_session_id,'callId',a.call_id,'turnId',turn_key,'offerId',a.offer_id,'goalEventId',a.event_id,
     'targetInstallationId',a.target_installation_id,'targetOwnerScopeKind',a.target_owner_scope_kind,'targetOwnerScopeId',a.target_owner_scope_id,
     'contextVersion',a.context_version,'bindingId',a.binding_id,'bindingRevision',a.binding_revision,'participantRevision',a.participant_revision);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.read_memory_team_source(p_scope JSONB,p_kind TEXT,p_root TEXT) RETURNS JSONB
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE a RECORD;g RECORD;o RECORD;replies JSONB;result JSONB;BEGIN
   SELECT * INTO a FROM shared.memory_team_source_authority(p_scope,p_kind,p_root);
   IF a.state<>'current' THEN RAISE EXCEPTION 'source_%',a.state;END IF;
   IF shared.memory_team_input_admitted(p_scope,p_kind,p_root,a.context) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'source_input_start_denied';END IF;
   IF p_kind='team_collaboration' THEN
    SELECT event_id,event_seq::text,author_user_id,created_at,CASE WHEN octet_length(content)<=33554432 THEN content ELSE NULL END AS content INTO g
     FROM public.collaboration_events WHERE event_id=a.context->>'goalEventId' AND team_session_id=a.context->>'teamSessionId' AND kind='member_message';
    IF NOT FOUND THEN RAISE EXCEPTION 'source_changed';END IF;
    SELECT event_id,event_seq::text,created_at,CASE WHEN octet_length(content)<=33554432 THEN content ELSE NULL END AS content INTO o FROM public.collaboration_events
     WHERE call_id=a.context->>'callId' AND team_session_id=a.context->>'teamSessionId' AND kind='status' ORDER BY event_seq DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'source_changed';END IF;
    WITH selected AS (SELECT event_id,event_seq,author_offer_id,content,created_at FROM public.collaboration_events
      WHERE call_id=a.context->>'callId' AND team_session_id=a.context->>'teamSessionId' AND kind='agent_message' AND event_seq<o.event_seq::bigint ORDER BY event_seq LIMIT 513),
     bounded AS (SELECT *,sum(octet_length(content)) OVER(ORDER BY event_seq) AS bytes FROM selected)
     SELECT jsonb_agg(jsonb_build_object('event_id',event_id,'event_seq',event_seq::text,'author_offer_id',author_offer_id,'created_at',created_at,
      'content',CASE WHEN bytes<=33554432 THEN content ELSE NULL END) ORDER BY event_seq) INTO replies FROM bounded;
    RETURN jsonb_build_object('context',a.context,'goal',to_jsonb(g),'outcome',to_jsonb(o),'replies',COALESCE(replies,'[]'));
   END IF;
   SELECT jsonb_build_object('context',a.context,'taskId',s.task_id,
    'spec',jsonb_build_object('revision',spec.revision::text,'goal',CASE WHEN octet_length(spec.goal)<=128000 THEN spec.goal ELSE NULL END,
      'acceptance',CASE WHEN octet_length(spec.acceptance)<=64000 THEN spec.acceptance ELSE NULL END,'authorUserId',spec.created_by_user_id,'createdAt',spec.created_at),
    'submission',jsonb_build_object('id',s.submission_id::text,'version',s.version::text,'summary',CASE WHEN octet_length(s.summary)<=128000 THEN s.summary ELSE NULL END,
      'manifestSha256',s.manifest_sha256,'authorOfferId',s.source_offer_id,'publishedAt',s.published_at),
    'decision',jsonb_build_object('id',d.decision_id::text,'decision',d.decision,'reviewerUserId',d.reviewer_user_id,'createdAt',d.created_at)) INTO result
    FROM public.team_delivery_memory_sources receipt JOIN public.team_task_submissions s USING(submission_id)
     JOIN public.team_acceptance_decisions d ON d.decision_id=receipt.decision_id
     JOIN public.team_task_specs spec ON spec.task_id=s.task_id AND spec.revision=s.spec_revision
    WHERE receipt.source_session_id=p_root AND receipt.reader_user_id=(p_scope->>'principalUserId')::int;
   RETURN result;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_team_installation(JSONB),shared.memory_team_source_authority(JSONB,TEXT,TEXT),shared.read_memory_team_source(JSONB,TEXT,TEXT) FROM PUBLIC`,
] as const
