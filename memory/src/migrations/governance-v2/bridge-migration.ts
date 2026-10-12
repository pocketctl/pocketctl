/** Transactional capture, including connections from pre-Bridge binaries.
 * Frozen source tables only; queues/projections/usage/packs never recurse.
 * Sequence allocation is NOT commit ordering. Task26 must drain writers and
 * replay an overlap before declaring a final watermark complete.
 */
const directTables=[
 'memory_installations','memory_owner_scopes','memory_scope_memberships',
 'repositories','repo_snapshots','source_sessions','source_turns','source_events','source_artifacts','work_episodes',
 'memory_candidates','memory_session_tombstones','knowledge_claims','knowledge_versions',
 'knowledge_evidence','knowledge_evidence_capsules','knowledge_tombstones',
 'memory_authority_records','memory_review_policy_sets',
 'memory_feature_settings','memory_policy_sets','memory_policy_versions','memory_policy_heads',
 'memory_repository_tombstones','memory_source_snapshot_tombstones','memory_source_snapshots',
 'memory_wikis','memory_wiki_heads','memory_wiki_versions','memory_wiki_pages','memory_wiki_sections',
 'memory_wiki_source_bindings','memory_wiki_manual_section_versions','memory_wiki_manual_section_heads','memory_wiki_stale_marks',
 'memory_skill_archives','memory_skill_archive_sources','memory_skill_tasks','memory_skill_task_runs',
 'memory_skill_candidates','memory_skills','memory_skill_versions','memory_skill_heads','memory_skill_review_decisions',
 'memory_skill_publication_policy_versions','memory_skill_publication_policy_heads',
 'memory_skill_publication_events','memory_skill_publication_heads','memory_skill_version_revocations','memory_skill_rollouts',
 'memory_git_connections','memory_git_actor_mappings','memory_git_asset_bindings',
 'memory_git_snapshots','memory_git_snapshot_assets','memory_git_revision_links',
 'memory_git_import_proposals','memory_git_conflicts','memory_git_review_decisions',
 'memory_git_resolution_authors','memory_git_original_authors','memory_git_governed_revisions',
 'memory_git_revision_evidence','memory_git_revision_reviews','memory_git_confirmed_bases',
 'memory_git_claim_authority','memory_git_claim_authority_decisions',
 'memory_git_tombstones','memory_git_lifecycle_epochs','memory_git_proposal_identities',
 'memory_git_snapshot_sources','memory_git_snapshot_keys','memory_git_sync_principals','memory_git_retained_outcomes',
]
const indirectTables=[
 'memory_git_attestation_keys','memory_scope_tombstones','memory_review_policy_versions','memory_review_policy_heads',
 'memory_promotion_candidates','memory_promotion_candidate_versions','memory_promotion_evidence','memory_review_decisions',
]
// Raw/control-feed ingress, revocation mirrors and source deletion are not
// fresh semantic admission. Their durable capture must continue during hold.
const gitSemanticTables=[
 'memory_git_asset_bindings','memory_git_snapshots','memory_git_snapshot_assets','memory_git_revision_links',
 'memory_git_import_proposals','memory_git_conflicts','memory_git_review_decisions','memory_git_resolution_authors',
 'memory_git_original_authors','memory_git_governed_revisions','memory_git_revision_evidence','memory_git_revision_reviews',
 'memory_git_confirmed_bases','memory_git_claim_authority','memory_git_claim_authority_decisions',
]
const protectedTables=[...directTables
 .filter(table=>!['knowledge_tombstones','memory_skill_version_revocations'].includes(table))
 .filter(table=>table.startsWith('knowledge_')||table==='memory_candidates'||table==='memory_authority_records'||table.startsWith('memory_review_policy_')||table.startsWith('memory_policy_')||table.startsWith('memory_wiki')||table.startsWith('memory_skill')),
 ...gitSemanticTables,
]
export const GOVERNANCE_BRIDGE_MIGRATION={version:53,statements:[
 `ALTER TABLE memory_governance_migration_changes
    ADD COLUMN writer_capability TEXT NOT NULL DEFAULT 'legacy_unknown',
    ADD COLUMN transaction_id xid8`,
 `CREATE FUNCTION memory_governance_change_scopes(table_name TEXT,record JSONB) RETURNS UUID[] LANGUAGE plpgsql AS $$
   DECLARE scope_ids UUID[];
   BEGIN
     IF record IS NULL THEN RETURN ARRAY[]::UUID[]; END IF;
     IF table_name='memory_git_attestation_keys' THEN
       SELECT array_agg(DISTINCT installation_id) INTO scope_ids FROM memory_git_snapshot_keys WHERE key_id=record->>'key_id';
     ELSIF table_name='memory_scope_tombstones' THEN
       SELECT array_agg(installation_id) INTO scope_ids FROM memory_owner_scopes
       WHERE owner_scope_kind=record->>'owner_scope_kind' AND owner_scope_id=(record->>'owner_scope_id')::uuid;
     ELSIF table_name IN('memory_policy_sets','memory_policy_versions','memory_policy_heads') THEN
       IF table_name='memory_policy_sets' THEN scope_ids:=ARRAY[(record->>'installation_id')::uuid];
       ELSE SELECT ARRAY[installation_id] INTO scope_ids FROM memory_policy_sets WHERE policy_id=(record->>'policy_id')::uuid; END IF;
       -- Installation-null system policies affect every existing scope. A
       -- cascaded deletion with no surviving policy is already represented by
       -- its parent event; do not invent a global change for a missing parent.
       IF scope_ids=ARRAY[NULL]::UUID[] THEN SELECT array_agg(installation_id) INTO scope_ids FROM memory_installations; END IF;
     ELSIF table_name IN('memory_review_policy_versions','memory_review_policy_heads') THEN
       SELECT ARRAY[installation_id] INTO scope_ids FROM memory_review_policy_sets WHERE policy_id=(record->>'policy_id')::uuid;
     ELSIF table_name='memory_promotion_candidates' THEN
       scope_ids:=ARRAY[(record->>'target_installation_id')::uuid,(record->>'source_installation_id')::uuid];
     ELSIF table_name='memory_promotion_candidate_versions' THEN
       SELECT ARRAY[target_installation_id] INTO scope_ids FROM memory_promotion_candidates WHERE candidate_id=(record->>'candidate_id')::uuid;
     ELSIF table_name IN('memory_promotion_evidence','memory_review_decisions') THEN
       SELECT ARRAY[c.target_installation_id] INTO scope_ids FROM memory_promotion_candidate_versions v
       JOIN memory_promotion_candidates c USING(candidate_id) WHERE v.candidate_revision_id=(record->>'candidate_revision_id')::uuid;
     ELSE scope_ids:=ARRAY[(record->>'installation_id')::uuid]; END IF;
     RETURN COALESCE(scope_ids,ARRAY[]::UUID[]);
   END $$`,
 `CREATE FUNCTION memory_governance_capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE old_record JSONB; new_record JSONB; change RECORD; capability TEXT;
   BEGIN
     IF TG_OP<>'INSERT' THEN old_record:=to_jsonb(OLD); END IF;
     IF TG_OP<>'DELETE' THEN new_record:=to_jsonb(NEW); END IF;
     IF TG_OP='UPDATE' THEN
       IF old_record=new_record THEN RETURN NULL; END IF;
       IF TG_TABLE_NAME='memory_installations' AND
          (old_record-ARRAY['poll_owner','poll_epoch','poll_expires_at','last_feed_id','last_pull_at','last_ack_at','last_error_code','updated_at'])=
          (new_record-ARRAY['poll_owner','poll_epoch','poll_expires_at','last_feed_id','last_pull_at','last_ack_at','last_error_code','updated_at']) THEN RETURN NULL; END IF;
       IF TG_TABLE_NAME='memory_owner_scopes' AND (old_record-ARRAY['last_feed_id','updated_at'])=(new_record-ARRAY['last_feed_id','updated_at']) THEN RETURN NULL; END IF;
     END IF;
     capability:=current_setting('pocketctl.writer_capability',true);
     IF capability IS NULL OR capability='' THEN capability:='legacy_unknown';
     ELSIF capability<>'bridge_v2' THEN capability:='unrecognized'; END IF;
     FOR change IN
       SELECT DISTINCT scope_id,key_id FROM (
         SELECT id AS scope_id,(SELECT jsonb_object_agg(key,value ORDER BY key) FROM jsonb_each(old_record) WHERE key=ANY(string_to_array(TG_ARGV[0],',')))::text AS key_id
           FROM unnest(memory_governance_change_scopes(TG_TABLE_NAME,old_record)) id
         UNION ALL
         SELECT id AS scope_id,(SELECT jsonb_object_agg(key,value ORDER BY key) FROM jsonb_each(new_record) WHERE key=ANY(string_to_array(TG_ARGV[0],',')))::text AS key_id
           FROM unnest(memory_governance_change_scopes(TG_TABLE_NAME,new_record)) id
       ) changes ORDER BY scope_id,key_id
     LOOP
       -- Deleted installation has no remaining data to backfill. Its queue
       -- cascades away; privacy/revocation replay relies on durable tombstones.
       IF EXISTS(SELECT 1 FROM memory_installations WHERE installation_id=change.scope_id) THEN
         INSERT INTO memory_governance_migration_changes(installation_id,entity_kind,entity_id,operation,source_revision,writer_capability,transaction_id)
         VALUES(change.scope_id,TG_TABLE_NAME,change.key_id,TG_OP,
           COALESCE(new_record->>'revision',new_record->>'version_number',new_record->>'revision_number',new_record->>'membership_revision',new_record->>'authorization_epoch',
             old_record->>'revision',old_record->>'version_number',old_record->>'revision_number',old_record->>'membership_revision',old_record->>'authorization_epoch'),
           capability,pg_current_xact_id());
       END IF;
     END LOOP;
     RETURN NULL;
   END $$`,
 `DO $$ DECLARE table_name TEXT; primary_columns TEXT; BEGIN
   FOREACH table_name IN ARRAY ARRAY[${[...directTables,...indirectTables].map(t=>`'${t}'`).join(',')}] LOOP
     SELECT string_agg(a.attname,',' ORDER BY k.ordinality) INTO primary_columns
     FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
     JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
     WHERE i.indrelid=to_regclass('public.'||table_name) AND i.indisprimary;
     IF primary_columns IS NULL THEN RAISE EXCEPTION 'memory_capture_source_missing: %',table_name; END IF;
     EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION memory_governance_capture_change(%L)',table_name||'_governance_capture',table_name,primary_columns);
   END LOOP;
 END $$`,

 `CREATE FUNCTION memory_governance_control_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     -- Internal, on-first-write defaults are not a cutover transaction. GUCs
     -- are an operational contract for trusted DB roles, never an auth grant.
     IF current_setting('pocketctl.writer_initializing_state',true)='true' THEN RETURN NULL; END IF;
     IF current_setting('pocketctl.semantic_write_transaction',true)='true' THEN
       RAISE EXCEPTION 'memory_writer_incompatible:control_transaction' USING ERRCODE='55000';
     END IF;
     PERFORM set_config('pocketctl.control_write_transaction','true',true);
     RETURN NULL;
   END $$`,
 `CREATE TRIGGER memory_governance_control_transaction BEFORE INSERT OR UPDATE ON memory_governance_v2_states
    FOR EACH STATEMENT EXECUTE FUNCTION memory_governance_control_transaction()`,
 `CREATE FUNCTION memory_governance_fence_writer() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE old_record JSONB; new_record JSONB; scope_id UUID; control RECORD; capability TEXT; writer_generation TEXT;
   BEGIN
     -- Deletes and strictly restrictive lifecycle edits are privacy-safe; do
     -- not make revoke/purge depend on a writer's admission capability.
     IF TG_OP='DELETE' THEN RETURN OLD; END IF;
     new_record:=to_jsonb(NEW);
     IF TG_OP='UPDATE' THEN
       old_record:=to_jsonb(OLD);
       IF old_record=new_record THEN RETURN NEW; END IF;
       IF TG_TABLE_NAME='knowledge_claims' AND new_record->>'state' IN('revoked','expired')
          AND (old_record-ARRAY['state','revision','updated_at','consumption_hold_reason'])=(new_record-ARRAY['state','revision','updated_at','consumption_hold_reason']) THEN RETURN NEW; END IF;
       IF TG_TABLE_NAME='knowledge_versions' AND new_record->>'valid_until' IS NOT NULL
          AND (old_record->>'valid_until' IS NULL OR (new_record->>'valid_until')::timestamptz<=(old_record->>'valid_until')::timestamptz)
          AND (old_record-'valid_until')=(new_record-'valid_until') THEN RETURN NEW; END IF;
     END IF;
     IF current_setting('pocketctl.control_write_transaction',true)='true' THEN
       RAISE EXCEPTION 'memory_writer_incompatible:control_transaction' USING ERRCODE='55000';
     END IF;
     PERFORM set_config('pocketctl.semantic_write_transaction','true',true);
     capability:=COALESCE(current_setting('pocketctl.writer_capability',true),'');
     writer_generation:=COALESCE(NULLIF(current_setting('pocketctl.writer_identity_generation',true),''),'1');
     FOR scope_id IN SELECT DISTINCT id FROM unnest(memory_governance_change_scopes(TG_TABLE_NAME,old_record)||memory_governance_change_scopes(TG_TABLE_NAME,new_record)) id ORDER BY id LOOP
       PERFORM set_config('pocketctl.writer_initializing_state','true',true);
       INSERT INTO memory_governance_v2_states(installation_id) VALUES(scope_id) ON CONFLICT(installation_id) DO NOTHING;
       PERFORM set_config('pocketctl.writer_initializing_state','false',true);
       -- Lock the control row through source commit. A state-only transition
       -- either precedes this lock or waits for it. Stale repeatable-read
       -- snapshots serialize-fail rather than observing an obsolete floor.
       SELECT phase,writer_floor,identity_generation INTO STRICT control FROM memory_governance_v2_states WHERE installation_id=scope_id FOR SHARE;
       IF control.phase IN('cutover','hold') THEN
         RAISE EXCEPTION 'memory_writer_incompatible:phase' USING ERRCODE='55000';
       END IF;
       IF control.writer_floor NOT IN('v1','bridge_v2') OR ((control.writer_floor='bridge_v2' OR control.phase IN('backfill','validate','active')) AND capability<>'bridge_v2') THEN
         RAISE EXCEPTION 'memory_writer_incompatible:capability' USING ERRCODE='55000';
       END IF;
       IF writer_generation<>'1' OR writer_generation<>control.identity_generation::text THEN
         RAISE EXCEPTION 'memory_writer_incompatible:identity_generation' USING ERRCODE='55000';
       END IF;
     END LOOP;
     RETURN NEW;
   END $$`,
 ...[...protectedTables,'memory_review_policy_versions','memory_review_policy_heads','memory_promotion_candidates','memory_promotion_candidate_versions','memory_promotion_evidence','memory_review_decisions'].map(table=>
   `CREATE TRIGGER ${table}_governance_writer BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION memory_governance_fence_writer()`),
 ]} as const
