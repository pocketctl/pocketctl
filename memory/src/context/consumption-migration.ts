const watched:Record<string,string[]>={
 knowledge_claims:['installation_id','state','current_version_id','scope_kind','scope_key','canonical_repository_key','consumption_hold_reason'],
 knowledge_versions:['installation_id','statement','structured_content','authority','applicability','repository_id','repo_snapshot_id','branch','valid_from','valid_until','freshness_at'],
 repositories:['installation_id','canonical_remote','repository_key'],
 repo_snapshots:['installation_id','repository_id','commit_sha','branch'],
 memory_owner_scopes:['installation_id','owner_scope_kind','owner_scope_id','state','authorization_epoch'],
 memory_wikis:['installation_id','repository_id'],
 memory_wiki_heads:['installation_id','repository_id','wiki_id','active_version_id','revision'],
 memory_wiki_versions:['installation_id','wiki_id','source_snapshot_id','graph_version_id','state','content_hash'],
 memory_wiki_sections:['installation_id','wiki_version_id','heading','markdown','authority'],
 memory_source_snapshots:['installation_id','repository_id','commit_sha','state'],
 memory_repository_tombstones:['installation_id','repository_id'],
 memory_source_snapshot_tombstones:['installation_id','repository_id','commit_sha'],
 memory_scope_tombstones:['owner_scope_kind','owner_scope_id','authorization_epoch'],
}
/** Additive consumer stamps. Migration control generation remains a separate domain. */
export const CONTEXT_CONSUMPTION_MIGRATION={version:52,statements:[
 `CREATE TABLE memory_scope_consumption_generations(
   installation_id UUID PRIMARY KEY REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
   generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0))`,
 `ALTER TABLE memory_context_packs ADD COLUMN consumption_generation BIGINT,
   ADD COLUMN query_context JSONB,
   ADD CONSTRAINT memory_context_consumption_generation CHECK(consumption_generation IS NULL OR consumption_generation>0),
   ADD CONSTRAINT memory_context_query_context CHECK(query_context IS NULL OR jsonb_typeof(query_context)='object')`,
 `ALTER TABLE memory_context_injections ADD COLUMN consumption_generation BIGINT,
   ADD CONSTRAINT memory_injection_consumption_generation CHECK(consumption_generation IS NULL OR consumption_generation>0)`,
 `CREATE FUNCTION memory_bump_consumption_generation() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE scope_id UUID; scope_ids UUID[];
   BEGIN
     IF TG_TABLE_NAME='memory_scope_tombstones' THEN
       IF TG_OP='INSERT' THEN SELECT array_agg(installation_id) INTO scope_ids FROM memory_owner_scopes WHERE owner_scope_kind=NEW.owner_scope_kind AND owner_scope_id=NEW.owner_scope_id;
       ELSIF TG_OP='DELETE' THEN SELECT array_agg(installation_id) INTO scope_ids FROM memory_owner_scopes WHERE owner_scope_kind=OLD.owner_scope_kind AND owner_scope_id=OLD.owner_scope_id;
       ELSE SELECT array_agg(installation_id) INTO scope_ids FROM memory_owner_scopes WHERE (owner_scope_kind=OLD.owner_scope_kind AND owner_scope_id=OLD.owner_scope_id) OR (owner_scope_kind=NEW.owner_scope_kind AND owner_scope_id=NEW.owner_scope_id); END IF;
     ELSIF TG_OP='INSERT' THEN scope_ids:=ARRAY[NEW.installation_id];
     ELSIF TG_OP='DELETE' THEN scope_ids:=ARRAY[OLD.installation_id];
     ELSE scope_ids:=ARRAY[OLD.installation_id,NEW.installation_id]; END IF;
     FOR scope_id IN SELECT DISTINCT id FROM unnest(scope_ids) id ORDER BY id LOOP
       -- Cascaded installation deletion has no surviving consumer to fence.
       IF EXISTS(SELECT 1 FROM memory_installations WHERE installation_id=scope_id) THEN
         INSERT INTO memory_scope_consumption_generations(installation_id,generation) VALUES(scope_id,2)
         ON CONFLICT(installation_id) DO UPDATE SET generation=memory_scope_consumption_generations.generation+1;
       END IF;
     END LOOP;
     RETURN NULL;
   END $$`,
 ...Object.entries(watched).flatMap(([table,columns])=>[
  `CREATE TRIGGER ${table}_consumption_insert_delete AFTER INSERT OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION memory_bump_consumption_generation()`,
  `CREATE TRIGGER ${table}_consumption_update AFTER UPDATE OF ${columns.join(',')} ON ${table} FOR EACH ROW
    WHEN (${columns.map(column=>`OLD.${column} IS DISTINCT FROM NEW.${column}`).join(' OR ')}) EXECUTE FUNCTION memory_bump_consumption_generation()`,
 ]),
 // Historical packs have no invented query frame or generation; no backfill or native cutover.
 ]} as const
