-- Read-only inventory. Run with psql against the shared Relay/Memory database.
-- Dynamic SQL and application code require a separate review.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH candidates(name) AS (VALUES
 ('memory.source_events'), ('memory.source_artifacts'), ('memory.source_turns'), ('memory.source_sessions'),
 ('memory.memory_canonical_projection_progress'), ('memory.memory_task_bundle_sources'),
 ('shared.memory_projection_policies'), ('shared.memory_projection_windows'), ('shared.memory_source_shadow_progress'),
 ('memory.memory_inbox_checkpoints'), ('memory.memory_feed_inbox'), ('memory.memory_snapshot_events'), ('memory.memory_snapshot_runs'))
SELECT name, to_regclass(name) IS NOT NULL AS present, pg_total_relation_size(to_regclass(name)) AS bytes
FROM candidates ORDER BY name;

WITH old AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='memory' AND c.relname IN('source_events','source_artifacts','source_turns','source_sessions',
  'memory_canonical_projection_progress','memory_task_bundle_sources','memory_inbox_checkpoints','memory_feed_inbox','memory_snapshot_events','memory_snapshot_runs'))
 OR (n.nspname='shared' AND c.relname IN('memory_projection_policies','memory_projection_windows','memory_source_shadow_progress')))
SELECT conrelid::regclass AS dependent, confrelid::regclass AS referenced, conname AS constraint_name,
 pg_get_constraintdef(oid) AS definition FROM pg_constraint
 WHERE contype='f' AND confrelid IN(SELECT oid FROM old) ORDER BY 1,2,3;

-- SQL-language and PL/pgSQL bodies can survive a DROP RESTRICT and fail on first execution.
WITH objects AS (
 SELECT p.oid::regprocedure::text AS object,p.prosrc AS definition,'function' AS kind
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.prokind IN('f','p') AND n.nspname IN('memory','shared','public')
 UNION ALL SELECT schemaname||'.'||viewname,definition,'view' FROM pg_views WHERE schemaname IN('memory','shared','public')
 UNION ALL SELECT schemaname||'.'||matviewname,definition,'materialized view' FROM pg_matviews WHERE schemaname IN('memory','shared','public'))
SELECT kind,object,array_agg(DISTINCT matched[1] ORDER BY matched[1]) AS referenced
 FROM objects CROSS JOIN LATERAL regexp_matches(definition,
 '\m(source_events|source_artifacts|source_turns|source_sessions|memory_canonical_projection_progress|memory_task_bundle_sources|memory_projection_policies|memory_projection_windows|memory_source_shadow_progress|memory_inbox_checkpoints|memory_feed_inbox|memory_snapshot_events|memory_snapshot_runs)\M','gi') matched
 GROUP BY kind,object ORDER BY kind,object;

SELECT job_type,state,count(*) AS jobs FROM memory.memory_jobs
 WHERE state IN('pending','running','dead') AND
 (job_type IN('project_feed','snapshot_reconcile')
 OR job_type='project_shared_source' AND COALESCE(payload#>>'{root,kind}','') NOT IN('team_collaboration','team_delivery')
 OR job_type='compile_episode' AND NOT(payload ? 'dialogue_session'))
 GROUP BY job_type,state ORDER BY job_type,state;
-- Dependencies tracked by PostgreSQL also include defaults, rewrite rules,
-- generated expressions and user-defined triggers outside the two schemas.
WITH old(rel) AS (SELECT to_regclass(name) FROM unnest(ARRAY[
 'memory.source_events','memory.source_sessions','memory.source_turns','memory.source_artifacts','memory.memory_task_bundle_sources',
 'memory.memory_canonical_projection_progress','shared.memory_projection_windows','shared.memory_projection_policies',
 'shared.memory_source_shadow_progress','memory.memory_feed_inbox','memory.memory_inbox_checkpoints','memory.memory_snapshot_events','memory.memory_snapshot_runs']) name)
SELECT DISTINCT d.refobjid::regclass AS referenced,pg_describe_object(d.classid,d.objid,d.objsubid) AS dependent,d.deptype
 FROM pg_depend d JOIN old ON old.rel=d.refobjid
 WHERE d.refclassid='pg_class'::regclass AND d.deptype='n' ORDER BY 1,2,3;

SELECT e.compiler_version,count(*) AS episodes,
 count(*) FILTER(WHERE e.evidence_manifest->'dialogue'->>'kind'='relay_turn_v1') AS dialogue_locator,
 count(*) FILTER(WHERE EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(e.evidence_manifest)='object'
  THEN e.evidence_manifest ELSE '{}'::jsonb END) m WHERE m.value ?| ARRAY['source_event_id','artifact_id'])) AS legacy_handles
 FROM memory.work_episodes e GROUP BY e.compiler_version ORDER BY 1;
SELECT 'knowledge_evidence' AS consumer,count(*) FILTER(WHERE source_event_id IS NOT NULL) AS event_refs,
 count(*) FILTER(WHERE artifact_id IS NOT NULL) AS artifact_refs FROM memory.knowledge_evidence
 UNION ALL SELECT 'memory_skill_archive_sources',count(*) FILTER(WHERE source_event_id IS NOT NULL),
 count(*) FILTER(WHERE artifact_id IS NOT NULL) FROM memory.memory_skill_archive_sources;
SELECT m.mode,count(*) AS installations FROM shared.memory_source_modes m GROUP BY m.mode ORDER BY m.mode;
ROLLBACK;
