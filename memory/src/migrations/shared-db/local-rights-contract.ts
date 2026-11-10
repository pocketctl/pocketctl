/** A Memory-only retention fence. Canonical Relay data is never changed.
 * An installation-wide monotonic counter catches a receipt committed while
 * a reader is doing lock-free archive IO, including receipt deletion/replay.
 * It is deliberately conservative: unrelated turns may require a retry.
 */
const captures = [
 ['memory_source_retention_receipts', ''],
 ['source_events', 'body'],
 ['memory_session_tombstones', ''],
 ['memory_installations', 'installation'],
 ['memory_owner_scopes', 'owner'],
 ['memory_repository_tombstones', ''],
 ['memory_source_snapshot_tombstones', ''],
 ['memory_scope_tombstones', 'scope'],
] as const
export const SHARED_LOCAL_RIGHTS_FUNCTIONS = [
 `CREATE TABLE IF NOT EXISTS shared.memory_local_source_rights(
   installation_id UUID PRIMARY KEY,revision BIGINT NOT NULL CHECK(revision>0))`,
 ...captures.flatMap(([table, filter]) => ['INSERT','UPDATE','DELETE'].filter(op=>filter!=='body'||op!=='INSERT').flatMap(op=>{
  const name=`capture_${table}_rights_${op.toLowerCase()}`
  // Drop only transport/lease bookkeeping. Any new semantic column remains
  // a rights change by default; status, config and scope changes stay fenced.
  const ignored=filter==='installation'?['updated_at','created_at','discovery_generation','poll_owner','poll_epoch','poll_expires_at','last_feed_id','last_pull_at','last_ack_at','last_error_code']:['updated_at','last_feed_id']
  const ignoredSql=`ARRAY[${ignored.map(column=>`'${column}'`).join(',')}]::text[]`
  const semanticRows=`SELECT n.installation_id FROM rights_new n LEFT JOIN rights_old o USING(installation_id)
    WHERE (to_jsonb(n)-${ignoredSql}) IS DISTINCT FROM (to_jsonb(o)-${ignoredSql})
    UNION SELECT o.installation_id FROM rights_old o LEFT JOIN rights_new n USING(installation_id) WHERE n.installation_id IS NULL`
  const ordinaryRows=op==='INSERT'?'SELECT installation_id FROM rights_new':op==='DELETE'?'SELECT installation_id FROM rights_old':filter==='body'?
   `SELECT n.installation_id FROM rights_new n JOIN rights_old o USING(source_event_id)
    WHERE n.body_reclaimed_at IS DISTINCT FROM o.body_reclaimed_at`:
   ['installation','owner'].includes(filter)?semanticRows:'SELECT installation_id FROM rights_new UNION SELECT installation_id FROM rights_old'
  const scopeRows=op==='INSERT'?'SELECT owner_scope_kind,owner_scope_id FROM rights_new':op==='DELETE'?'SELECT owner_scope_kind,owner_scope_id FROM rights_old':'SELECT owner_scope_kind,owner_scope_id FROM rights_new UNION SELECT owner_scope_kind,owner_scope_id FROM rights_old'
  // An organization tombstone also restricts native child teams, including
  // those whose local ancestry is stale or whose parent has no installation.
  const rows=filter==='scope'?`SELECT o.installation_id FROM (
    SELECT installation_id,owner_scope_kind,owner_scope_id FROM memory.memory_owner_scopes
    UNION SELECT installation_id,owner_scope_kind,owner_scope_id FROM public.extension_installations WHERE provider_id='pocketctl-memory'
    UNION SELECT i.installation_id,'organization'::text,t.organization_id FROM public.extension_installations i
      JOIN public.extension_teams t ON i.owner_scope_kind='team' AND t.team_id=i.owner_scope_id WHERE i.provider_id='pocketctl-memory'
    ) o JOIN (${scopeRows}) s USING(owner_scope_kind,owner_scope_id)`:ordinaryRows
  return [
   `CREATE OR REPLACE FUNCTION shared.${name}() RETURNS TRIGGER
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE affected_installation UUID;BEGIN
     -- An AFTER writer can already own business rows. Never wait for the
     -- earlier installation fence: reject and roll back the whole statement.
     FOR affected_installation IN SELECT DISTINCT installation_id FROM (${rows}) affected ORDER BY installation_id LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||affected_installation::text,0)) THEN
       RAISE EXCEPTION 'source_privacy_fence_busy' USING ERRCODE='55P03';
      END IF;
     END LOOP;
     INSERT INTO shared.memory_local_source_rights(installation_id,revision)
      SELECT DISTINCT installation_id,1 FROM (${rows}) affected ORDER BY installation_id
      ON CONFLICT(installation_id) DO UPDATE SET revision=memory_local_source_rights.revision+1;
     RETURN NULL;
    END $$`,
   `REVOKE ALL ON FUNCTION shared.${name}() FROM PUBLIC`,
   `DO $$ BEGIN IF to_regclass('memory.${table}') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS ${name} ON memory.${table};
    CREATE TRIGGER ${name} AFTER ${op} ON memory.${table}
    REFERENCING ${op!=='INSERT'?'OLD TABLE AS rights_old':''} ${op!=='DELETE'?'NEW TABLE AS rights_new':''}
    FOR EACH STATEMENT EXECUTE FUNCTION shared.${name}();
    END IF;END $$`,
  ]
 })),
] as const
