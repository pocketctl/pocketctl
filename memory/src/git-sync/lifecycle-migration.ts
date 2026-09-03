/** Content projections disappear synchronously; identity, costs and exact remote
 * intent survive independently. Never acquire a source lock from a key hook. */
const dependencies=[
  ['evidence_id','knowledge_evidence','evidence_id'],['version_id','knowledge_versions','version_id'],
  ['episode_id','work_episodes','episode_id'],['repo_snapshot_id','repo_snapshots','repo_snapshot_id'],
  ['source_snapshot_id','memory_source_snapshots','snapshot_id'],['graph_version_id','memory_code_graph_versions','graph_version_id'],
  ['build_run_id','memory_wiki_build_runs','run_id'],['archive_id','memory_skill_archives','archive_id'],
] as const
export const GIT_LIFECYCLE_MIGRATION={version:44,statements:[
  `CREATE TABLE memory_git_tombstones(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,identity_id UUID NOT NULL,kind TEXT NOT NULL CHECK(kind IN('export','claim','rule','wiki','skill')),
    generation BIGINT NOT NULL CHECK(generation>0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,connection_id,kind,identity_id))`,
  `CREATE TABLE memory_git_lifecycle_epochs(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,transaction_id BIGINT NOT NULL,generation BIGINT NOT NULL,
    PRIMARY KEY(installation_id,connection_id,transaction_id))`,
  `CREATE TABLE memory_git_proposal_identities(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,proposal_id UUID NOT NULL,export_id UUID NOT NULL,
    PRIMARY KEY(installation_id,connection_id,proposal_id),UNIQUE(installation_id,proposal_id))`,
  `INSERT INTO memory_git_proposal_identities SELECT installation_id,connection_id,proposal_id,export_id FROM memory_git_import_proposals`,
  `CREATE FUNCTION memory_git_keep_proposal_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO memory_git_proposal_identities VALUES(NEW.installation_id,NEW.connection_id,NEW.proposal_id,NEW.export_id);
    RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_keep_proposal_identity AFTER INSERT ON memory_git_import_proposals FOR EACH ROW EXECUTE FUNCTION memory_git_keep_proposal_identity()`,
  ...['memory_git_original_authors','memory_git_resolution_authors','memory_git_governed_revisions'].flatMap(table=>[
    `DO $$ DECLARE n TEXT; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='${table}'::regclass AND confrelid='memory_git_import_proposals'::regclass AND contype='f'; EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I',n); END $$`,
    `ALTER TABLE ${table} ADD FOREIGN KEY(installation_id,connection_id,proposal_id)
      REFERENCES memory_git_proposal_identities(installation_id,connection_id,proposal_id) ON DELETE CASCADE`,
  ]),
  `ALTER TABLE memory_git_run_receipts ADD UNIQUE(installation_id,connection_id,run_id)`,
  `DO $$ DECLARE n TEXT; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='memory_git_original_authors'::regclass AND confrelid='memory_git_runs'::regclass AND contype='f'; EXECUTE format('ALTER TABLE memory_git_original_authors DROP CONSTRAINT %I',n); END $$`,
  `ALTER TABLE memory_git_original_authors ADD FOREIGN KEY(installation_id,connection_id,run_id)
    REFERENCES memory_git_run_receipts(installation_id,connection_id,run_id) ON DELETE CASCADE`,
  `CREATE TABLE memory_git_retained_outcomes(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,export_id UUID NOT NULL,
    proposal_revision BIGINT NOT NULL,generation BIGINT NOT NULL,commit_sha TEXT NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    link_id UUID NOT NULL,version_id UUID NOT NULL,asset_id UUID NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN('published','draft_appended','linked','revoked')),
    PRIMARY KEY(installation_id,proposal_id),
    FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_proposal_identities(installation_id,connection_id,proposal_id) ON DELETE CASCADE)`,
  `CREATE TABLE memory_git_remote_cleanup(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,export_id UUID NOT NULL,old_run_id UUID NOT NULL,generation BIGINT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN('github','gitee','gitlab')),provider_repository_id TEXT NOT NULL,
    target_branch TEXT NOT NULL,target_owner TEXT,target_repository TEXT,target_private BOOLEAN,
    remote_branch TEXT NOT NULL,expected_commit TEXT,expected_tree TEXT,description_hash TEXT,remote_pr_id TEXT,
    cleanup_pending BOOLEAN NOT NULL DEFAULT TRUE,recognized_at TIMESTAMPTZ,recognized_run_id UUID,
    PRIMARY KEY(installation_id,connection_id,export_id),
    CHECK(char_length(target_owner)<=256 AND char_length(target_repository)<=256 AND char_length(remote_pr_id)<=64),
    CHECK(expected_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),CHECK(expected_tree ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    CHECK(description_hash ~ '^[0-9a-f]{64}$'))`,
  `ALTER TABLE memory_git_outbox ADD COLUMN target_owner TEXT CHECK(char_length(target_owner) BETWEEN 1 AND 256),
    ADD COLUMN target_repository TEXT CHECK(char_length(target_repository) BETWEEN 1 AND 256),ADD COLUMN target_private BOOLEAN`,
  `CREATE TABLE memory_git_retained_steps(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,export_id UUID NOT NULL,outbox_id UUID NOT NULL,
    step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 511),operation TEXT NOT NULL CHECK(operation IN('tree','commit','branch','file','pull_request')),
    state TEXT NOT NULL CHECK(state IN('pending','dispatching','reconciling','completed','conflicted')),
    expected_head TEXT,expected_blob TEXT,expected_tree TEXT,expected_commit TEXT,remote_sha TEXT,remote_tree TEXT,remote_number TEXT,expected_content_blob TEXT,
    PRIMARY KEY(installation_id,connection_id,outbox_id,step),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_remote_cleanup(installation_id,connection_id,export_id) ON DELETE CASCADE,
    CHECK(expected_head ~ '^[0-9a-f]{40}$'),CHECK(expected_blob ~ '^[0-9a-f]{40}$'),CHECK(expected_tree ~ '^[0-9a-f]{40}$'),
    CHECK(expected_commit ~ '^[0-9a-f]{40}$'),CHECK(remote_sha ~ '^[0-9a-f]{40}$'),CHECK(remote_tree ~ '^[0-9a-f]{40}$'),
    CHECK(remote_number ~ '^[1-9][0-9]{0,14}$'),CHECK(expected_content_blob ~ '^[0-9a-f]{40}$'))`,
  `ALTER TABLE memory_git_outbox_steps ADD COLUMN expected_content_blob TEXT CHECK(expected_content_blob ~ '^[0-9a-f]{40}$')`,
  `ALTER TABLE memory_git_runs ADD COLUMN recovery_export_id UUID,
    ADD FOREIGN KEY(installation_id,connection_id,recovery_export_id) REFERENCES memory_git_remote_cleanup(installation_id,connection_id,export_id)`,
  `ALTER TABLE memory_git_runs DROP CONSTRAINT memory_git_runs_trigger_source_check`,
  `ALTER TABLE memory_git_runs ADD CHECK(trigger_source IN('webhook','poll','preview','export','recovery'))`,
  `CREATE TABLE memory_git_snapshot_sources(
    source_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,installation_id UUID NOT NULL,connection_id UUID NOT NULL,export_id UUID NOT NULL,
    ${dependencies.map(([column])=>`${column} UUID`).join(',')},
    CHECK(num_nonnulls(${dependencies.map(([c])=>c).join(',')})=1),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
    ${dependencies.map(([c,t,id])=>`FOREIGN KEY(installation_id,${c}) REFERENCES ${t}(installation_id,${id}) ON DELETE CASCADE`).join(',')})`,
  ...dependencies.map(([c])=>`CREATE INDEX memory_git_source_${c} ON memory_git_snapshot_sources(installation_id,${c}) WHERE ${c} IS NOT NULL`),
  `CREATE FUNCTION memory_git_capture_sources() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE evidence UUID;version UUID;archive UUID; BEGIN
    FOR evidence IN SELECT (e->>'evidenceId')::uuid FROM jsonb_array_elements(COALESCE(NEW.base_document->'immutable'->'evidence','[]')) e LOOP
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,evidence_id) VALUES(NEW.installation_id,NEW.connection_id,NEW.export_id,evidence);
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,episode_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,episode_id FROM knowledge_evidence WHERE installation_id=NEW.installation_id AND evidence_id=evidence;
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,version_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,version_id FROM knowledge_evidence WHERE installation_id=NEW.installation_id AND evidence_id=evidence;
    END LOOP;
    IF NEW.claim_version_id IS NOT NULL THEN
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,version_id) VALUES(NEW.installation_id,NEW.connection_id,NEW.export_id,NEW.claim_version_id);
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,repo_snapshot_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,repo_snapshot_id FROM knowledge_versions WHERE version_id=NEW.claim_version_id AND repo_snapshot_id IS NOT NULL;
    END IF;
    IF NEW.wiki_version_id IS NOT NULL THEN
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,source_snapshot_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,source_snapshot_id FROM memory_wiki_versions WHERE wiki_version_id=NEW.wiki_version_id;
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,graph_version_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,graph_version_id FROM memory_wiki_versions WHERE wiki_version_id=NEW.wiki_version_id;
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,build_run_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,build_run_id FROM memory_wiki_versions WHERE wiki_version_id=NEW.wiki_version_id AND build_run_id IS NOT NULL;
    END IF;
    IF NEW.skill_version_id IS NOT NULL THEN
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,archive_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,archive_id FROM memory_skill_versions WHERE version_id=NEW.skill_version_id;
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,repo_snapshot_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,a.repo_snapshot_id FROM memory_skill_versions v JOIN memory_skill_archives a USING(installation_id,archive_id) WHERE v.version_id=NEW.skill_version_id;
    END IF;
    RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_capture_sources AFTER INSERT ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_capture_sources()`,
  // Legacy43 projections are conservatively invalidated at the end of this
  // migration, after durable metadata anchors exist. Never rehydrate a missing
  // legacy Evidence FK merely to copy then delete already-invalid body data.
  `CREATE TRIGGER memory_git_sources_immutable BEFORE UPDATE ON memory_git_snapshot_sources FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable()`,
  `CREATE TRIGGER memory_git_sources_registered BEFORE INSERT ON memory_git_snapshot_sources FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_asset_insert()`,
  `CREATE FUNCTION memory_git_retain_export(i UUID,c UUID,e UUID) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO memory_git_retained_outcomes
      SELECT o.installation_id,o.connection_id,o.proposal_id,p.export_id,o.proposal_revision,p.generation,l.commit_sha,l.link_id,l.version_id,l.asset_id,o.outcome
      FROM memory_git_import_outcomes o JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id)
      JOIN memory_git_revision_links l ON l.installation_id=o.installation_id AND l.connection_id=o.connection_id AND l.link_id=o.link_id
      WHERE p.installation_id=i AND p.connection_id=c AND p.export_id=e AND p.state='applied' AND p.revision=o.proposal_revision AND p.head_commit=l.commit_sha
      ON CONFLICT DO NOTHING;
    INSERT INTO memory_git_remote_cleanup(installation_id,connection_id,export_id,old_run_id,generation,provider,provider_repository_id,target_branch,
      target_owner,target_repository,target_private,remote_branch,expected_commit,expected_tree,description_hash,remote_pr_id)
      SELECT DISTINCT ON(b.export_id) b.installation_id,b.connection_id,b.export_id,b.run_id,b.generation,k.provider,k.provider_repository_id,k.target_branch,
        b.target_owner,b.target_repository,b.target_private,COALESCE(b.remote_branch,'pocketctl/export/'||b.export_id),b.expected_commit,b.expected_tree,b.description_hash,b.remote_pr_id
      FROM memory_git_outbox b JOIN memory_git_connections k USING(installation_id,connection_id)
      WHERE b.installation_id=i AND b.connection_id=c AND b.export_id=e
      ORDER BY b.export_id,(b.remote_pr_id IS NOT NULL) DESC,(b.operation='pull_request') DESC ON CONFLICT DO NOTHING;
    INSERT INTO memory_git_retained_steps
      SELECT s.installation_id,s.connection_id,b.export_id,s.outbox_id,s.step,s.operation,s.state,
        s.expected_head,s.expected_blob,s.expected_tree,s.expected_commit,s.remote_sha,s.remote_tree,s.remote_number,s.expected_content_blob
      FROM memory_git_outbox_steps s JOIN memory_git_outbox b USING(installation_id,connection_id,outbox_id)
      WHERE b.installation_id=i AND b.connection_id=c AND b.export_id=e ON CONFLICT DO NOTHING;
    UPDATE memory_git_run_receipts p SET attempts=GREATEST(p.attempts,r.http_attempts),failures=GREATEST(p.failures,r.failure_count),
      state=CASE WHEN r.state IN('cancelled','dead') THEN r.state WHEN p.unfinished THEN 'invalidated' ELSE p.state END,reason_code=CASE WHEN p.unfinished THEN 'source_invalidated' ELSE p.reason_code END
      FROM memory_git_runs r WHERE p.installation_id=r.installation_id AND p.run_id=r.run_id AND r.installation_id=i AND r.connection_id=c AND r.export_id=e;
    UPDATE memory_jobs SET state='dead',claim_expires_at=NULL,last_error_code='source_invalidated'
      WHERE installation_id=i AND state IN('pending','running') AND job_id IN(SELECT job_id FROM memory_git_runs WHERE installation_id=i AND connection_id=c AND export_id=e);
    INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,export_id,action,outcome,reason_code)
      VALUES(gen_random_uuid(),i,c,e,'invalidate','invalidated','source_invalid');
  END $$`,
  `CREATE FUNCTION memory_git_forget_export() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE g BIGINT; BEGIN
    PERFORM memory_git_retain_export(OLD.installation_id,OLD.connection_id,OLD.export_id);
    INSERT INTO memory_git_tombstones(installation_id,connection_id,identity_id,kind,generation)
      VALUES(OLD.installation_id,OLD.connection_id,OLD.export_id,'export',OLD.generation) ON CONFLICT DO NOTHING;
    INSERT INTO memory_git_lifecycle_epochs(installation_id,connection_id,transaction_id,generation)
      SELECT installation_id,connection_id,txid_current(),generation+1 FROM memory_git_connections WHERE installation_id=OLD.installation_id AND connection_id=OLD.connection_id
      ON CONFLICT DO NOTHING RETURNING generation INTO g;
    IF g IS NOT NULL THEN UPDATE memory_git_connections SET generation=g WHERE installation_id=OLD.installation_id AND connection_id=OLD.connection_id; END IF;
    RETURN OLD; END $$`,
  `CREATE TRIGGER memory_git_forget_export BEFORE DELETE ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION memory_git_forget_export()`,
  `CREATE FUNCTION memory_git_invalidate_connection(i UUID,c UUID) RETURNS void LANGUAGE plpgsql AS $$ DECLARE g BIGINT; BEGIN
    INSERT INTO memory_git_lifecycle_epochs(installation_id,connection_id,transaction_id,generation)
      SELECT installation_id,connection_id,txid_current(),generation+1 FROM memory_git_connections WHERE installation_id=i AND connection_id=c
      ON CONFLICT DO NOTHING RETURNING generation INTO g;
    IF g IS NOT NULL THEN UPDATE memory_git_connections SET generation=g WHERE installation_id=i AND connection_id=c; END IF;
    DELETE FROM memory_git_snapshots WHERE installation_id=i AND connection_id=c;
    UPDATE memory_git_run_receipts SET state='invalidated',reason_code='source_invalidated' WHERE installation_id=i AND connection_id=c AND unfinished AND state NOT IN('cancelled','dead');
    UPDATE memory_jobs SET state='dead',claim_expires_at=NULL,last_error_code='source_invalidated' WHERE installation_id=i AND state IN('pending','running')
      AND job_id IN(SELECT job_id FROM memory_git_runs WHERE installation_id=i AND connection_id=c);
    UPDATE memory_git_runs SET state=CASE WHEN state IN('cancelled','dead','invalidated','closed') THEN state ELSE 'invalidated' END,
      dry_run_result=NULL,result=NULL,grant_facts=NULL,error_code='source_invalidated' WHERE installation_id=i AND connection_id=c;
    DELETE FROM memory_git_sync_principals WHERE installation_id=i AND connection_id=c;
  END $$`,
  `CREATE FUNCTION memory_git_dependency_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    -- During parent deletion the snapshot is already invisible; don't recurse.
    IF EXISTS(SELECT 1 FROM memory_git_snapshots WHERE installation_id=OLD.installation_id AND export_id=OLD.export_id) THEN
      PERFORM memory_git_invalidate_connection(OLD.installation_id,OLD.connection_id);
    END IF; RETURN OLD; END $$`,
  `CREATE TRIGGER memory_git_dependency_deleted AFTER DELETE ON memory_git_snapshot_sources FOR EACH ROW EXECUTE FUNCTION memory_git_dependency_deleted()`,
  `CREATE FUNCTION memory_git_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE row JSONB;id UUID;c UUID;column_name TEXT; BEGIN
    row=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
    id=(row->>'installation_id')::uuid;column_name=TG_ARGV[0];
    FOR c IN EXECUTE format('SELECT DISTINCT connection_id FROM memory_git_snapshot_sources WHERE installation_id=$1 AND %I=$2',column_name)
      USING id,(row->>TG_ARGV[1])::uuid LOOP PERFORM memory_git_invalidate_connection(id,c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`,
  ...dependencies.map(([c,t,id])=>`CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('${c}','${id}')`),
  ...[
    ['knowledge_evidence','evidence_id','evidence_id','excerpt,excerpt_hash,visibility,source_event_id,artifact_id,episode_id',''],
    ['work_episodes','episode_id','episode_id','state,source_digest',"WHEN (NEW.state<>'ready' OR NEW.source_digest IS DISTINCT FROM OLD.source_digest)"],
    ['knowledge_versions','version_id','version_id','valid_until,valid_from',''],
    ['memory_source_snapshots','source_snapshot_id','snapshot_id','state',"WHEN (NEW.state NOT IN('active','superseded'))"],
    ['memory_code_graph_versions','graph_version_id','graph_version_id','state',"WHEN (NEW.state NOT IN('active','superseded'))"],
    ['memory_wiki_build_runs','build_run_id','run_id','state',"WHEN (OLD.state='published' AND NEW.state<>'published')"],
  ].map(([t,c,id,cols,when])=>`CREATE TRIGGER memory_git_source_update BEFORE UPDATE OF ${cols} ON ${t} FOR EACH ROW ${when} EXECUTE FUNCTION memory_git_source_changed('${c}','${id}')`),
  ...[['memory_code_nodes','graph_version_id','graph_version_id'],['memory_wiki_build_sources','build_run_id','run_id'],
    ['memory_source_snapshot_entries','source_snapshot_id','snapshot_id']].flatMap(([t,c,id])=>[
    `CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('${c}','${id}')`,
    `CREATE TRIGGER memory_git_source_update BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('${c}','${id}')`,
  ]),
  `CREATE FUNCTION memory_git_wiki_binding_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    IF TG_OP='UPDATE' AND (NEW.installation_id,NEW.wiki_version_id,NEW.section_id,NEW.binding_id,NEW.source_kind,NEW.source_token,NEW.source_snapshot_id,NEW.commit_sha)
      IS NOT DISTINCT FROM (OLD.installation_id,OLD.wiki_version_id,OLD.section_id,OLD.binding_id,OLD.source_kind,OLD.source_token,OLD.source_snapshot_id,OLD.commit_sha)
      THEN RETURN NEW; END IF;
    FOR c IN SELECT DISTINCT connection_id FROM memory_git_snapshot_assets
      WHERE installation_id=OLD.installation_id AND wiki_version_id=OLD.wiki_version_id ORDER BY connection_id
      LOOP PERFORM memory_git_invalidate_connection(OLD.installation_id,c); END LOOP;
    IF TG_OP='UPDATE' AND (NEW.installation_id,NEW.wiki_version_id) IS DISTINCT FROM (OLD.installation_id,OLD.wiki_version_id) THEN
      FOR c IN SELECT DISTINCT connection_id FROM memory_git_snapshot_assets
        WHERE installation_id=NEW.installation_id AND wiki_version_id=NEW.wiki_version_id ORDER BY connection_id
        LOOP PERFORM memory_git_invalidate_connection(NEW.installation_id,c); END LOOP;
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`,
  `CREATE TRIGGER memory_git_wiki_binding_deleted BEFORE DELETE ON memory_wiki_source_bindings FOR EACH ROW EXECUTE FUNCTION memory_git_wiki_binding_changed()`,
  `CREATE TRIGGER memory_git_wiki_binding_changed BEFORE UPDATE OF installation_id,wiki_version_id,section_id,binding_id,source_kind,source_token,source_snapshot_id,commit_sha
    ON memory_wiki_source_bindings FOR EACH ROW EXECUTE FUNCTION memory_git_wiki_binding_changed()`,
  `CREATE FUNCTION memory_git_asset_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a UUID;i UUID;b RECORD; BEGIN
    i=OLD.installation_id;a=(to_jsonb(OLD)->>TG_ARGV[0])::uuid;
    FOR b IN SELECT * FROM memory_git_asset_bindings WHERE installation_id=i AND asset_id=a LOOP
      IF TG_OP='DELETE' OR TG_ARGV[1]='terminal' THEN
        INSERT INTO memory_git_tombstones(installation_id,connection_id,identity_id,kind,generation)
          SELECT i,b.connection_id,a,b.kind,generation FROM memory_git_connections WHERE connection_id=b.connection_id ON CONFLICT DO NOTHING;
      END IF;
      PERFORM memory_git_invalidate_connection(i,b.connection_id);
    END LOOP; RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`,
  `CREATE TRIGGER memory_git_claim_withdrawn BEFORE UPDATE OF state ON knowledge_claims FOR EACH ROW WHEN (NEW.state<>'active' AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION memory_git_asset_withdrawn('claim_id','terminal')`,
  `CREATE TRIGGER memory_git_skill_withdrawn BEFORE UPDATE OF state ON memory_skill_heads FOR EACH ROW WHEN (NEW.state IN('revoked','archived') AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION memory_git_asset_withdrawn('skill_id','terminal')`,
  `CREATE TRIGGER memory_git_wiki_lock_changed BEFORE UPDATE OF locked ON memory_wiki_manual_section_heads FOR EACH ROW WHEN (NEW.locked IS DISTINCT FROM OLD.locked) EXECUTE FUNCTION memory_git_asset_withdrawn('wiki_id','projection')`,
  `CREATE TRIGGER memory_git_wiki_version_withdrawn BEFORE UPDATE OF state ON memory_wiki_versions FOR EACH ROW WHEN (NEW.state IN('revoked','purged') AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION memory_git_asset_withdrawn('wiki_id','projection')`,
  `CREATE TRIGGER memory_git_skill_publication_disabled BEFORE UPDATE OF state ON memory_skill_publication_heads FOR EACH ROW WHEN (NEW.state='disabled' AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION memory_git_asset_withdrawn('skill_id','projection')`,
  `CREATE FUNCTION memory_git_skill_version_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    FOR c IN SELECT DISTINCT connection_id FROM memory_git_snapshot_assets WHERE installation_id=NEW.installation_id AND skill_version_id=NEW.version_id LOOP
      PERFORM memory_git_invalidate_connection(NEW.installation_id,c); END LOOP; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_skill_version_withdrawn BEFORE INSERT ON memory_skill_version_revocations FOR EACH ROW EXECUTE FUNCTION memory_git_skill_version_withdrawn()`,
  ...[['knowledge_claims','claim_id'],['memory_wikis','wiki_id'],['memory_skills','skill_id']].map(([t,id])=>
    `CREATE TRIGGER memory_git_asset_delete BEFORE DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION memory_git_asset_withdrawn('${id}','terminal')`),
  `CREATE FUNCTION memory_git_scope_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE i UUID;c UUID; BEGIN
    i=CASE WHEN TG_OP='DELETE' THEN OLD.installation_id ELSE NEW.installation_id END;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
    FOR c IN SELECT k.connection_id FROM memory_git_connections k JOIN memory_owner_scopes s USING(installation_id)
      WHERE s.installation_id=i OR s.parent_organization_id IN(SELECT owner_scope_id FROM memory_owner_scopes WHERE installation_id=i AND owner_scope_kind='organization')
      ORDER BY k.connection_id LOOP
      PERFORM memory_git_invalidate_connection((SELECT installation_id FROM memory_git_connections WHERE connection_id=c),c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`,
  `CREATE TRIGGER memory_git_scope_changed BEFORE UPDATE OF state,authorization_epoch ON memory_owner_scopes FOR EACH ROW EXECUTE FUNCTION memory_git_scope_changed()`,
  `CREATE FUNCTION memory_git_scope_tombstoned() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c RECORD; BEGIN
    FOR c IN SELECT k.installation_id,k.connection_id FROM memory_git_connections k JOIN memory_owner_scopes s USING(installation_id)
      WHERE (s.owner_scope_kind=NEW.owner_scope_kind AND s.owner_scope_id=NEW.owner_scope_id AND s.authorization_epoch<=NEW.authorization_epoch)
        OR (NEW.owner_scope_kind='organization' AND s.parent_organization_id=NEW.owner_scope_id)
      ORDER BY k.connection_id LOOP PERFORM memory_git_invalidate_connection(c.installation_id,c.connection_id); END LOOP; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_scope_tombstoned BEFORE INSERT OR UPDATE ON memory_scope_tombstones FOR EACH ROW EXECUTE FUNCTION memory_git_scope_tombstoned()`,
  `CREATE TRIGGER memory_git_installation_changed BEFORE UPDATE OF local_status,relay_status,config_version ON memory_installations FOR EACH ROW EXECUTE FUNCTION memory_git_scope_changed()`,
  `CREATE FUNCTION memory_git_member_dependency_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    IF TG_OP='UPDATE' AND (NEW.state,NEW.membership_revision,NEW.roles,NEW.valid_from,NEW.valid_until) IS NOT DISTINCT FROM (OLD.state,OLD.membership_revision,OLD.roles,OLD.valid_from,OLD.valid_until) THEN RETURN NEW; END IF;
    FOR c IN
      SELECT connection_id FROM memory_git_runs WHERE installation_id=OLD.installation_id AND membership_id=OLD.membership_id AND state NOT IN('closed','invalidated','cancelled','dead')
      UNION SELECT connection_id FROM memory_git_sync_principals WHERE installation_id=OLD.installation_id AND membership_id=OLD.membership_id
      UNION SELECT a.connection_id FROM memory_git_original_authors a JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id)
        WHERE a.installation_id=OLD.installation_id AND a.author_membership_id=OLD.membership_id
      UNION SELECT a.connection_id FROM memory_git_resolution_authors a JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id)
        WHERE a.installation_id=OLD.installation_id AND a.resolver_membership_id=OLD.membership_id
      UNION SELECT p.connection_id FROM memory_git_revision_reviews r JOIN memory_git_governed_revisions g USING(installation_id,revision_id)
        JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id) WHERE r.installation_id=OLD.installation_id AND r.reviewer_membership_id=OLD.membership_id
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN knowledge_evidence e ON e.installation_id=d.installation_id AND e.evidence_id=d.evidence_id
        WHERE d.installation_id=OLD.installation_id AND e.contributor_membership_id=OLD.membership_id
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN memory_authority_records a ON a.installation_id=d.installation_id AND a.version_id=d.version_id
        WHERE d.installation_id=OLD.installation_id AND a.publisher_membership_id=OLD.membership_id
      ORDER BY connection_id
    LOOP PERFORM memory_git_invalidate_connection(OLD.installation_id,c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`,
  `CREATE TRIGGER memory_git_member_changed BEFORE UPDATE OF state,membership_revision,roles,valid_from,valid_until ON memory_scope_memberships FOR EACH ROW EXECUTE FUNCTION memory_git_member_dependency_changed()`,
  `CREATE TRIGGER memory_git_member_deleted BEFORE DELETE ON memory_scope_memberships FOR EACH ROW EXECUTE FUNCTION memory_git_member_dependency_changed()`,
  `CREATE FUNCTION memory_git_repository_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    FOR c IN SELECT connection_id FROM memory_git_connections WHERE installation_id=NEW.installation_id AND repository_id=NEW.repository_id ORDER BY connection_id LOOP
      PERFORM memory_git_invalidate_connection(NEW.installation_id,c); END LOOP; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_repository_withdrawn BEFORE INSERT ON memory_repository_tombstones FOR EACH ROW EXECUTE FUNCTION memory_git_repository_withdrawn()`,
  `CREATE FUNCTION memory_git_session_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID;i UUID;s TEXT; BEGIN
    i=CASE WHEN TG_OP='DELETE' THEN OLD.installation_id ELSE NEW.installation_id END;
    s=CASE WHEN TG_OP='DELETE' THEN OLD.session_id ELSE NEW.session_id END;
    FOR c IN SELECT DISTINCT d.connection_id FROM memory_git_snapshot_sources d JOIN work_episodes e ON e.installation_id=d.installation_id AND e.episode_id=d.episode_id
      WHERE e.installation_id=i AND e.session_id=s
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN knowledge_evidence e ON e.installation_id=d.installation_id AND e.evidence_id=d.evidence_id
        LEFT JOIN source_events se ON se.installation_id=e.installation_id AND se.source_event_id=e.source_event_id
        LEFT JOIN source_artifacts a ON a.installation_id=e.installation_id AND a.artifact_id=e.artifact_id
        WHERE d.installation_id=i AND (se.session_id=s OR a.session_id=s)
      UNION SELECT a.connection_id FROM memory_git_snapshot_assets a JOIN memory_skill_replay_runs r ON r.installation_id=a.installation_id AND r.version_id=a.skill_version_id
        JOIN memory_skill_replay_cases k ON k.installation_id=r.installation_id AND k.run_id=r.run_id
        WHERE a.installation_id=i AND k.kind='historical_session' AND k.reference_id=s
      LOOP PERFORM memory_git_invalidate_connection(i,c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`,
  `CREATE TRIGGER memory_git_session_withdrawn BEFORE INSERT ON memory_session_tombstones FOR EACH ROW EXECUTE FUNCTION memory_git_session_withdrawn()`,
  `CREATE TRIGGER memory_git_session_deleted BEFORE UPDATE OF deleted_at ON source_sessions FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION memory_git_session_withdrawn()`,
  `CREATE TRIGGER memory_git_session_removed BEFORE DELETE ON source_sessions FOR EACH ROW EXECUTE FUNCTION memory_git_session_withdrawn()`,
  `CREATE FUNCTION memory_git_snapshot_tombstoned() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    FOR c IN SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN memory_source_snapshots s
      ON s.installation_id=d.installation_id AND s.snapshot_id=d.source_snapshot_id
      WHERE d.installation_id=NEW.installation_id AND (s.snapshot_id=NEW.snapshot_id OR (s.repository_id=NEW.repository_id AND s.commit_sha=NEW.commit_sha))
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN repo_snapshots s
        ON s.installation_id=d.installation_id AND s.repo_snapshot_id=d.repo_snapshot_id
        WHERE d.installation_id=NEW.installation_id AND s.repository_id=NEW.repository_id AND s.commit_sha=NEW.commit_sha
      LOOP PERFORM memory_git_invalidate_connection(NEW.installation_id,c); END LOOP; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_snapshot_tombstoned BEFORE INSERT ON memory_source_snapshot_tombstones FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_tombstoned()`,
  `CREATE FUNCTION memory_git_key_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r RECORD; BEGIN
    FOR r IN SELECT DISTINCT installation_id,connection_id FROM memory_git_snapshot_keys WHERE key_id=NEW.key_id ORDER BY installation_id,connection_id LOOP
      PERFORM memory_git_invalidate_connection(r.installation_id,r.connection_id); END LOOP; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_key_withdrawn AFTER UPDATE OF state ON memory_git_attestation_keys FOR EACH ROW WHEN (NEW.state='revoked' AND OLD.state<>'revoked') EXECUTE FUNCTION memory_git_key_withdrawn()`,
  `CREATE FUNCTION memory_git_connection_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' THEN
      -- The identity is going away; reserve its terminal epoch without an
      -- UPDATE of the row already owned by this DELETE command.
      INSERT INTO memory_git_lifecycle_epochs VALUES(OLD.installation_id,OLD.connection_id,txid_current(),OLD.generation+1) ON CONFLICT DO NOTHING;
      PERFORM memory_git_invalidate_connection(OLD.installation_id,OLD.connection_id); RETURN OLD;
    END IF;
    IF NEW.generation<>OLD.generation OR NEW.state IS DISTINCT FROM OLD.state OR (NEW.sync_mode='off' AND NEW.sync_mode IS DISTINCT FROM OLD.sync_mode) THEN
      INSERT INTO memory_git_lifecycle_epochs VALUES(NEW.installation_id,NEW.connection_id,txid_current(),NEW.generation) ON CONFLICT DO NOTHING;
      -- A snapshot-triggered bump already owns deletion. No recursive DELETE of
      -- its still-visible parent row; the caller invalidates the complete set.
      IF pg_trigger_depth()=1 THEN PERFORM memory_git_invalidate_connection(NEW.installation_id,NEW.connection_id); END IF;
    END IF;RETURN NEW;END $$`,
  `CREATE TRIGGER memory_git_connection_withdrawn AFTER UPDATE OF generation,state,sync_mode ON memory_git_connections FOR EACH ROW EXECUTE FUNCTION memory_git_connection_withdrawn()`,
  `CREATE TRIGGER memory_git_connection_deleted BEFORE DELETE ON memory_git_connections FOR EACH ROW EXECUTE FUNCTION memory_git_connection_withdrawn()`,
  `CREATE FUNCTION memory_git_connection_identity_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE g BIGINT; BEGIN
    IF (NEW.installation_id,NEW.connection_id,NEW.repository_id,NEW.owner_scope_kind,NEW.owner_scope_id)
      IS DISTINCT FROM (OLD.installation_id,OLD.connection_id,OLD.repository_id,OLD.owner_scope_kind,OLD.owner_scope_id)
      THEN RAISE EXCEPTION 'git_connection_identity_immutable'; END IF;
    IF (NEW.provider,NEW.provider_repository_id,NEW.target_id,NEW.target_branch,NEW.root_path,NEW.credential_ref)
      IS DISTINCT FROM (OLD.provider,OLD.provider_repository_id,OLD.target_id,OLD.target_branch,OLD.root_path,OLD.credential_ref)
      OR NEW.state IS DISTINCT FROM OLD.state OR (NEW.sync_mode='off' AND NEW.sync_mode IS DISTINCT FROM OLD.sync_mode) THEN
      -- Reserve the increment before deletion hooks. The outer row update owns
      -- generation; no trigger attempts to UPDATE this same connection row.
      INSERT INTO memory_git_lifecycle_epochs VALUES(OLD.installation_id,OLD.connection_id,txid_current(),GREATEST(NEW.generation,OLD.generation+1)) ON CONFLICT DO NOTHING;
      SELECT generation INTO g FROM memory_git_lifecycle_epochs WHERE installation_id=OLD.installation_id AND connection_id=OLD.connection_id AND transaction_id=txid_current();
      NEW.generation=GREATEST(NEW.generation,g);
      -- Retain original remote target while OLD is still the visible row.
      PERFORM memory_git_invalidate_connection(OLD.installation_id,OLD.connection_id);
    END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_connection_identity_changed BEFORE UPDATE OF installation_id,connection_id,repository_id,owner_scope_kind,owner_scope_id,
    provider,provider_repository_id,target_id,target_branch,root_path,credential_ref,state,sync_mode ON memory_git_connections FOR EACH ROW EXECUTE FUNCTION memory_git_connection_identity_changed()`,
  `CREATE FUNCTION memory_git_no_resurrection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF EXISTS(SELECT 1 FROM memory_git_tombstones WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id
      AND (identity_id=NEW.export_id OR (TG_TABLE_NAME='memory_git_snapshot_assets' AND identity_id=COALESCE(to_jsonb(NEW)->>'claim_id',to_jsonb(NEW)->>'wiki_id',to_jsonb(NEW)->>'skill_id')::uuid))) THEN RAISE EXCEPTION 'git_tombstoned'; END IF;
    RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_no_resurrection BEFORE INSERT ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION memory_git_no_resurrection()`,
  `CREATE TRIGGER memory_git_no_resurrection BEFORE INSERT ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_no_resurrection()`,
  `ALTER TABLE memory_wikis ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','revoked'))`,
  `ALTER TABLE memory_wiki_versions DROP CONSTRAINT memory_wiki_versions_state_check`,
  `ALTER TABLE memory_wiki_versions ADD CHECK(state IN('active','superseded','purged','revoked'))`,
  `ALTER TABLE memory_wiki_heads ALTER COLUMN active_version_id DROP NOT NULL`,
  `CREATE TRIGGER memory_git_wiki_withdrawn BEFORE UPDATE OF state ON memory_wikis FOR EACH ROW WHEN (NEW.state='revoked' AND OLD.state<>'revoked') EXECUTE FUNCTION memory_git_asset_withdrawn('wiki_id','terminal')`,
  `CREATE FUNCTION memory_wiki_revoke_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF EXISTS(SELECT 1 FROM memory_wikis WHERE installation_id=NEW.installation_id AND wiki_id=NEW.wiki_id AND state='revoked')
      AND ((TG_TABLE_NAME='memory_wiki_versions' AND to_jsonb(NEW)->>'state'='active') OR (TG_TABLE_NAME='memory_wiki_build_runs' AND to_jsonb(NEW)->>'state' IN('queued','running','validating','candidate','published'))
        OR (TG_TABLE_NAME='memory_wiki_heads' AND (to_jsonb(NEW)->>'active_version_id') IS NOT NULL)) THEN RAISE EXCEPTION 'wiki_revoked'; END IF;
    RETURN NEW; END $$`,
  ...['memory_wiki_versions','memory_wiki_heads','memory_wiki_build_runs'].map(t=>`CREATE TRIGGER memory_wiki_revoke_fence BEFORE INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION memory_wiki_revoke_fence()`),
  `CREATE FUNCTION memory_wiki_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.state='revoked' AND NEW.state<>'revoked' THEN RAISE EXCEPTION 'wiki_revoked'; END IF;RETURN NEW;END $$`,
  `CREATE TRIGGER memory_wiki_terminal BEFORE UPDATE OF state ON memory_wikis FOR EACH ROW EXECUTE FUNCTION memory_wiki_terminal()`,
  // Includes valid legacy bases: source/member/key withdrawal may have happened
  // before hooks existed. Current authority must explicitly re-export/enroll.
  // No domain asset or existing typed publication authority is revoked here.
  `DO $$ DECLARE c RECORD; BEGIN
    FOR c IN SELECT DISTINCT installation_id,connection_id FROM memory_git_snapshots ORDER BY installation_id,connection_id LOOP
      PERFORM memory_git_invalidate_connection(c.installation_id,c.connection_id);
    END LOOP; END $$`,
] } as const
