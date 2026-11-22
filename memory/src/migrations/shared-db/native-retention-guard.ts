import {LIFECYCLE_RETENTION_MIGRATION} from '../../retention/lifecycle-v3-migration.js'

// Keep the governance fence verbatim except for the source of the exact
// historical bundle membership proof. PL/pgSQL must not plan a reference to
// a removed table just to check an unrelated Claim or Version update.
const previous=LIFECYCLE_RETENTION_MIGRATION.statements.find(sql=>sql.startsWith('CREATE OR REPLACE FUNCTION memory_governance_fence_writer'))!
const originalMembership=`EXISTS(
   SELECT 1 FROM memory_task_bundle_sources bs JOIN source_events se USING(installation_id,source_event_id)
    WHERE bs.installation_id=r.installation_id AND bs.bundle_id=(new_record->>'bundle_id')::uuid AND se.turn_id=r.turn_id
     AND NOT EXISTS(SELECT 1 FROM memory_task_bundle_sources members JOIN source_events source USING(installation_id,source_event_id)
      WHERE members.installation_id=bs.installation_id AND members.bundle_id=bs.bundle_id AND source.body_reclaimed_at IS NULL))`
if(!previous.includes(originalMembership))throw Error('governance_retention_fence_definition_changed')

export const NATIVE_RETENTION_GUARD=[
 `CREATE OR REPLACE FUNCTION memory.memory_bundle_reclamation_allowed(i UUID,b UUID,s TEXT,t TEXT)
 RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,memory,shared AS $$
 BEGIN
  IF b IS NULL THEN RETURN FALSE; END IF;
  IF (SELECT projection_storage_retired FROM shared.memory_source_contract WHERE singleton) THEN
   RETURN EXISTS(SELECT 1 FROM memory.memory_task_bundles bundle
    JOIN shared.memory_team_history_bundle_links member USING(installation_id,bundle_id)
    JOIN shared.memory_team_history_inputs h ON h.installation_id=i AND h.kind='source' AND h.id=member.source_event_id::text
    WHERE bundle.installation_id=i AND bundle.bundle_id=b AND bundle.session_id=s AND h.session_id=s
     AND h.metadata->>'turn_id'=t AND bundle.body_state='reclaimed');
  END IF;
  RETURN EXISTS(SELECT 1 FROM memory.memory_task_bundle_sources m JOIN memory.source_events e USING(installation_id,source_event_id)
   WHERE m.installation_id=i AND m.bundle_id=b AND e.turn_id=t AND e.session_id=s AND NOT EXISTS(
    SELECT 1 FROM memory.memory_task_bundle_sources x JOIN memory.source_events se USING(installation_id,source_event_id)
     WHERE x.installation_id=i AND x.bundle_id=b AND se.body_reclaimed_at IS NULL));
 END $$`,
 `REVOKE ALL ON FUNCTION memory.memory_bundle_reclamation_allowed(UUID,UUID,TEXT,TEXT) FROM PUBLIC`,
 previous.replace('FUNCTION memory_governance_fence_writer','FUNCTION memory.memory_governance_fence_writer')
  .replace('LANGUAGE plpgsql AS', 'LANGUAGE plpgsql SET search_path=pg_catalog,memory,shared AS')
  .replace(originalMembership,"memory.memory_bundle_reclamation_allowed(r.installation_id,(new_record->>'bundle_id')::uuid,r.session_id,r.turn_id)"),
] as const
