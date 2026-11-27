import {LIFECYCLE_SOURCE_POLICY} from '../episodes/source-admission.js'

// Both queries return at most 1001 small observations per installation.
// Projected turns predate the native episode/intake binding. Their historical
// receipt coverage remains available with an explicitly different basis.
export const projectedTurnCoverage = `
 SELECT sample.n,r.disposition,r.complete AND b.state IN('completed','skipped_unresolved') AS complete,
  CASE WHEN r.disposition='provenance_unknown' THEN 'unknown' WHEN r.allowed_count>0 THEN 'trusted'
   WHEN r.disposition='skipped_policy' THEN 'skipped_policy' END AS input_provenance,
  r.allowed_count>0 AS has_trusted_input,r.allowed_count>0 AND r.excluded_count>0 AS partially_trusted,
  b.state='blocked' AS blocked,history.disposition AS recorded_projection_disposition,history.complete AS recorded_projection_complete
 FROM (SELECT turn_id,session_id,updated_at,row_number() OVER(ORDER BY updated_at DESC,turn_id) AS n
  FROM source_turns WHERE installation_id=i.installation_id AND i.active
   AND state IN('completed','interrupted','failed','abandoned') AND updated_at>=i.observation_window_start
  ORDER BY updated_at DESC,turn_id LIMIT 1001) sample
 LEFT JOIN LATERAL (SELECT bundle_id,revision,source_digest,state FROM memory_task_bundles b
  WHERE b.installation_id=i.installation_id AND b.session_id=sample.session_id AND b.task_key='source:'||sample.turn_id
   AND b.bundle_kind='intake' AND b.updated_at>=sample.updated_at LIMIT 1) b ON true
 LEFT JOIN LATERAL (SELECT disposition,complete,allowed_count,excluded_count FROM memory_source_processing_receipts r
  WHERE r.installation_id=i.installation_id AND r.turn_id=sample.turn_id AND r.session_id=sample.session_id
   AND r.source_digest=b.source_digest AND r.policy_version='${LIFECYCLE_SOURCE_POLICY}' AND r.created_at>=sample.updated_at
   AND (SELECT true FROM memory_curation_runs run WHERE run.installation_id=i.installation_id
    AND run.bundle_id=b.bundle_id AND run.bundle_revision=b.revision AND run.source_digest=b.source_digest
    AND run.policy_revision=i.policy_revision AND run.mode=i.effective_mode AND r.created_at>=run.started_at
    AND run.state='completed' LIMIT 1)
  LIMIT 1) r ON true
 LEFT JOIN LATERAL (SELECT disposition,complete FROM memory_source_processing_receipts r
  WHERE r.installation_id=i.installation_id AND r.turn_id=sample.turn_id AND r.session_id=sample.session_id
  ORDER BY created_at DESC,source_digest,policy_version LIMIT 1) history ON true`

export const nativeTurnCoverage = `
 WITH inputs AS MATERIALIZED (
  (SELECT e.turn_id,e.session_id,e.source_digest AS episode_digest,e.event_count,e.compiled_at,
     e.dialogue_completion AS marker,e.evidence_manifest->'lifecycle_admission' AS admission,true AS compiled,
     false AS operational
   FROM work_episodes e LEFT JOIN memory_dialogue_turns t USING(installation_id,session_id,turn_id)
   LEFT JOIN memory_dialogue_compile_receipts r ON r.installation_id=t.installation_id AND r.session_id=t.session_id
     AND r.turn_id=t.turn_id AND r.generation=t.requested_generation
   WHERE e.installation_id=i.installation_id AND i.active AND e.compiler_version='relay-turn-v1'
     AND e.terminal_at IS NOT NULL AND e.state='ready' AND e.compiled_at>=i.observation_window_start
     AND (t.turn_id IS NULL OR e.dialogue_generation=t.requested_generation OR r.status IN ('published','not_admitted') AND r.reason IS DISTINCT FROM 'operational_turn')
   ORDER BY e.compiled_at DESC,e.turn_id,e.session_id LIMIT 1001)
  UNION ALL
  (SELECT t.turn_id,t.session_id,e.source_digest,e.event_count,t.requested_at,e.dialogue_completion,
     e.evidence_manifest->'lifecycle_admission',e.episode_id IS NOT NULL,
     r.status='not_admitted' AND r.reason='operational_turn'
   FROM memory_dialogue_turns t LEFT JOIN memory_dialogue_compile_receipts r ON r.installation_id=t.installation_id
     AND r.session_id=t.session_id AND r.turn_id=t.turn_id AND r.generation=t.requested_generation
   LEFT JOIN work_episodes e ON e.installation_id=t.installation_id AND e.session_id=t.session_id AND e.turn_id=t.turn_id
     AND e.compiler_version='relay-turn-v1' AND e.terminal_at IS NOT NULL AND e.state='ready'
     AND (e.dialogue_generation=t.requested_generation OR r.status IN ('published','not_admitted') AND r.reason IS DISTINCT FROM 'operational_turn')
   WHERE t.installation_id=i.installation_id AND i.active AND t.requested_at>=i.observation_window_start
     AND (e.episode_id IS NULL OR e.compiled_at<i.observation_window_start)
   ORDER BY t.requested_at DESC,t.turn_id,t.session_id LIMIT 1001)
 ), sample AS (
  SELECT inputs.*,row_number() OVER(ORDER BY compiled_at DESC,turn_id,session_id) n
  FROM inputs ORDER BY compiled_at DESC,turn_id,session_id LIMIT 1001
 ), counts AS (
  SELECT s.*,
   CASE WHEN jsonb_typeof(admission->'allowed_count')='number' AND admission->>'allowed_count' ~ '^(0|[1-9][0-9]{0,8})$'
    THEN (admission->>'allowed_count')::int END AS allowed,
   CASE WHEN jsonb_typeof(admission->'excluded_count')='number' AND admission->>'excluded_count' ~ '^(0|[1-9][0-9]{0,8})$'
    THEN (admission->>'excluded_count')::int END AS excluded
  FROM sample s
 ), intake AS (
  SELECT s.*,b.bundle_id,b.revision,b.state,b.updated_at AS intake_updated_at,b.source_digest AS intake_digest,
   CASE WHEN jsonb_typeof(b.dialogue_members)='array' THEN jsonb_array_length(b.dialogue_members) END AS admitted_count,
   octet_length(s.episode_digest)=32 AND s.admission @> jsonb_build_object('episode_digest',encode(s.episode_digest,'hex'),'source_policy','${LIFECYCLE_SOURCE_POLICY}'::text)
   AND jsonb_typeof(s.admission->'digest')='string' AND s.admission->>'digest' ~ '^[a-f0-9]{64}$'
   AND s.allowed+s.excluded=s.event_count AND s.event_count>0
   AND CASE s.admission->>'provenance' WHEN 'trusted' THEN s.allowed>0 WHEN 'unknown' THEN s.excluded>0
    WHEN 'skipped_policy' THEN s.allowed=0 ELSE false END AS attested
  FROM counts s LEFT JOIN LATERAL (SELECT bundle_id,revision,state,updated_at,source_digest,dialogue_members
   FROM memory_task_bundles b WHERE b.installation_id=i.installation_id AND b.session_id=s.session_id
    AND s.compiled AND b.task_key='dialogue:'||s.turn_id AND b.bundle_kind='intake' LIMIT 1) b ON true
 ), authority AS MATERIALIZED (
  -- Legacy intakes attest admitted members. A newly compiled episode can
  -- supersede them; a present but invalid modern attestation never falls back.
  SELECT t.*,CASE WHEN attested THEN decode(admission->>'digest','hex')
   WHEN admission IS NULL AND intake_updated_at>=compiled_at THEN intake_digest END AS digest
  FROM intake t
 ), markers AS MATERIALIZED (
  -- Successful native reclamation deletes both the intake and its receipt.
  -- The legacy producer retained the marker on the episode and cleared it
  -- atomically whenever it replaced the corresponding Relay inventory.
  SELECT a.*,marker @> jsonb_build_object('policy',i.policy_revision)
   AND COALESCE(marker->'source_policy','"memory-source-admission-v1"'::jsonb)=to_jsonb('${LIFECYCLE_SOURCE_POLICY}'::text)
   AND jsonb_typeof(marker->'digest')='string' AND marker->>'digest' ~ '^[a-f0-9]{64}$'
   AND (NOT marker ? 'disposition' OR marker->>'disposition' IN('skipped_policy','provenance_unknown'))
   AND (marker->>'digest'=encode(digest,'hex') OR (bundle_id IS NULL AND admission IS NULL))
   AND (admission IS NULL OR attested AND CASE admission->>'provenance'
    WHEN 'unknown' THEN marker->>'disposition'='provenance_unknown'
    WHEN 'skipped_policy' THEN marker->>'disposition'='skipped_policy'
    WHEN 'trusted' THEN NOT marker ? 'disposition' END)
   AND (bundle_id IS NULL OR intake_digest=digest AND state IN('completed','skipped_unresolved')
     OR attested AND marker ? 'disposition') AS current_marker
  FROM authority a
 ), receipts AS (
  SELECT m.*,r.disposition AS recorded,r.complete AS recorded_complete
  FROM markers m LEFT JOIN LATERAL (SELECT disposition,complete FROM memory_source_processing_receipts r WHERE r.installation_id=i.installation_id
   AND r.session_id=m.session_id AND r.turn_id=m.turn_id AND r.source_digest=m.digest
   AND r.policy_version='${LIFECYCLE_SOURCE_POLICY}' AND r.created_at>=i.observation_window_start
   AND m.intake_digest=m.digest AND (SELECT true FROM memory_curation_runs run
    WHERE run.installation_id=i.installation_id AND run.bundle_id=m.bundle_id AND run.bundle_revision=m.revision
     AND run.source_digest=m.digest AND run.policy_revision=i.policy_revision AND run.mode=i.effective_mode AND r.created_at>=run.started_at
     AND run.state='completed' LIMIT 1) LIMIT 1) r ON true
 )
 SELECT n,CASE WHEN operational THEN 'skipped_policy' WHEN recorded IS NOT NULL THEN recorded
   WHEN current_marker THEN COALESCE(marker->>'disposition','concluded') END AS disposition,
  CASE WHEN operational THEN true WHEN recorded IS NOT NULL THEN recorded_complete AND state IN('completed','skipped_unresolved')
    AND (admission IS NULL OR admission->>'provenance'<>'unknown')
   WHEN current_marker THEN marker->>'disposition' IS DISTINCT FROM 'provenance_unknown' END AS complete,
  CASE WHEN operational THEN 'skipped_policy' WHEN attested THEN admission->>'provenance' WHEN admission IS NULL THEN CASE
   WHEN current_marker AND marker->>'disposition'='provenance_unknown' OR recorded='provenance_unknown' THEN 'unknown'
   WHEN current_marker AND marker->>'disposition'='skipped_policy' THEN 'skipped_policy'
   WHEN current_marker OR recorded IN('concluded','no_durable_conclusion')
     OR digest IS NOT NULL AND admitted_count=event_count AND event_count>0 THEN 'trusted'
   END END AS input_provenance,
  CASE WHEN attested THEN allowed>0 WHEN admission IS NULL THEN
   digest IS NOT NULL AND admitted_count>0 OR current_marker AND NOT marker ? 'disposition' END AS has_trusted_input,
  CASE WHEN attested THEN allowed>0 AND excluded>0 WHEN admission IS NULL THEN
   digest IS NOT NULL AND admitted_count>0 AND admitted_count<event_count END AS partially_trusted,
  state='blocked' AND intake_digest=digest AS blocked,NULL::text AS recorded_projection_disposition,false AS recorded_projection_complete
 FROM receipts`
