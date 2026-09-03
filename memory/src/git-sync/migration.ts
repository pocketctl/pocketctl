/** Storage identity constraints only; portable content is validated by the codec. */
const typedAsset = `
  kind TEXT NOT NULL CHECK(kind IN('claim','rule','wiki','skill')),
  claim_id UUID, wiki_id UUID, skill_id UUID,
  asset_id UUID GENERATED ALWAYS AS (COALESCE(claim_id,wiki_id,skill_id)) STORED,
  CHECK(num_nonnulls(claim_id,wiki_id,skill_id)=1),
  CHECK((kind IN('claim','rule') AND claim_id IS NOT NULL) OR (kind='wiki' AND wiki_id IS NOT NULL) OR (kind='skill' AND skill_id IS NOT NULL)),
  FOREIGN KEY(installation_id,claim_id) REFERENCES knowledge_claims(installation_id,claim_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,wiki_id) REFERENCES memory_wikis(installation_id,wiki_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE`
const typedVersion = `
  claim_version_id UUID, wiki_version_id UUID, skill_version_id UUID,
  version_id UUID GENERATED ALWAYS AS (COALESCE(claim_version_id,wiki_version_id,skill_version_id)) STORED,
  CHECK(num_nonnulls(claim_version_id,wiki_version_id,skill_version_id)=1),
  CHECK((claim_id IS NOT NULL)=(claim_version_id IS NOT NULL) AND (wiki_id IS NOT NULL)=(wiki_version_id IS NOT NULL)
    AND (skill_id IS NOT NULL)=(skill_version_id IS NOT NULL)),
  FOREIGN KEY(installation_id,claim_id,claim_version_id) REFERENCES knowledge_versions(installation_id,claim_id,version_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,wiki_id,wiki_version_id) REFERENCES memory_wiki_versions(installation_id,wiki_id,wiki_version_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,skill_id,skill_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE`
const pathColumn = `path TEXT NOT NULL CHECK(char_length(path) BETWEEN 1 AND 512
  AND path LIKE '.pocketctl/knowledge/%' AND path !~ '(^|/)\\.\\.?(/|$)' AND strpos(path,chr(92))=0)`
const hash = `TEXT NOT NULL CHECK(VALUE ~ '^[0-9a-f]{64}$')`
const digest = (column: string) => `${column} ${hash.replace('VALUE', column)}`
const connectionRef = `FOREIGN KEY(installation_id,connection_id) REFERENCES memory_git_connections(installation_id,connection_id) ON DELETE CASCADE`

export const GIT_CONNECTION_MIGRATION = {
  version: 39,
  statements: [
    `ALTER TABLE memory_owner_scopes ADD CONSTRAINT memory_git_owner_identity UNIQUE(installation_id,owner_scope_kind,owner_scope_id)`,
    `ALTER TABLE knowledge_versions ADD CONSTRAINT memory_git_claim_version_identity UNIQUE(installation_id,claim_id,version_id)`,
    `ALTER TABLE memory_wiki_versions ADD CONSTRAINT memory_git_wiki_version_identity UNIQUE(installation_id,wiki_id,wiki_version_id)`,
    `CREATE TABLE memory_git_connections (
      connection_id UUID PRIMARY KEY, installation_id UUID NOT NULL, repository_id UUID NOT NULL,
      owner_scope_kind TEXT NOT NULL CHECK(owner_scope_kind IN('team','organization')), owner_scope_id UUID NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN('github','gitlab','gitee')),
      provider_repository_id TEXT NOT NULL CHECK(char_length(provider_repository_id) BETWEEN 1 AND 256),
      target_id TEXT NOT NULL CHECK(char_length(target_id) BETWEEN 1 AND 256),
      target_branch TEXT NOT NULL CHECK(char_length(target_branch) BETWEEN 1 AND 255),
      root_path TEXT NOT NULL DEFAULT '.pocketctl/knowledge/' CHECK(root_path='.pocketctl/knowledge/'),
      credential_ref TEXT NOT NULL CHECK(char_length(credential_ref) BETWEEN 1 AND 512),
      sync_mode TEXT NOT NULL DEFAULT 'off' CHECK(sync_mode IN('off','shadow','enabled')),
      write_mode TEXT NOT NULL DEFAULT 'off' CHECK(write_mode IN('off','shadow')),
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','disabled')),
      generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0), cursor TEXT CHECK(char_length(cursor)<=1024),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id), UNIQUE(installation_id,connection_id,repository_id),
      FOREIGN KEY(installation_id,repository_id) REFERENCES repositories(installation_id,repository_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,owner_scope_kind,owner_scope_id)
        REFERENCES memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) ON DELETE CASCADE
    )`,
    `CREATE UNIQUE INDEX memory_git_one_active_connection ON memory_git_connections(installation_id,repository_id) WHERE state='active'`,
    `CREATE TABLE memory_git_actor_mappings (
      installation_id UUID NOT NULL, connection_id UUID NOT NULL,
      provider_actor_id TEXT NOT NULL CHECK(char_length(provider_actor_id) BETWEEN 1 AND 256),
      membership_id UUID NOT NULL, membership_revision BIGINT NOT NULL CHECK(membership_revision>0),
      authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(installation_id,connection_id,provider_actor_id), ${connectionRef},
      FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_git_asset_bindings (
      binding_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, repository_id UUID NOT NULL,
      ${typedAsset}, ${pathColumn}, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id,binding_id,kind,asset_id),
      UNIQUE(installation_id,connection_id,asset_id), UNIQUE(installation_id,connection_id,path),
      FOREIGN KEY(installation_id,connection_id,repository_id)
        REFERENCES memory_git_connections(installation_id,connection_id,repository_id) ON DELETE CASCADE
    )`,
    // The binding's real repository is checked under source row locks, including
    // shared publications that express their repository in Claim.scope_key.
    `CREATE FUNCTION memory_git_binding_repository() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF num_nonnulls(NEW.claim_id,NEW.wiki_id,NEW.skill_id)<>1 OR
          NOT ((NEW.kind IN('claim','rule') AND NEW.claim_id IS NOT NULL) OR
            (NEW.kind='wiki' AND NEW.wiki_id IS NOT NULL) OR (NEW.kind='skill' AND NEW.skill_id IS NOT NULL)) THEN RETURN NEW; END IF;
        IF NEW.claim_id IS NOT NULL THEN
          PERFORM 1 FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id=c.current_version_id
            JOIN repositories r ON r.installation_id=c.installation_id AND r.repository_id=NEW.repository_id
            WHERE c.installation_id=NEW.installation_id AND c.claim_id=NEW.claim_id
              AND (v.repository_id=r.repository_id OR (v.repository_id IS NULL AND c.scope_kind='repository' AND c.scope_key IN(r.repository_id::text,r.repository_key)))
              AND (NEW.kind<>'rule' OR c.claim_type IN('repository_convention','test_invariant')) FOR SHARE OF c,v,r;
        ELSIF NEW.wiki_id IS NOT NULL THEN
          PERFORM 1 FROM memory_wikis WHERE installation_id=NEW.installation_id AND wiki_id=NEW.wiki_id AND repository_id=NEW.repository_id FOR SHARE;
        ELSE
          PERFORM 1 FROM memory_skills s JOIN memory_skill_tasks t USING(installation_id,task_id)
            WHERE s.installation_id=NEW.installation_id AND s.skill_id=NEW.skill_id AND t.repository_id=NEW.repository_id FOR SHARE OF s,t;
        END IF;
        IF NOT FOUND THEN RAISE EXCEPTION 'git_asset_repository_mismatch'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_git_binding_repository BEFORE INSERT OR UPDATE ON memory_git_asset_bindings FOR EACH ROW EXECUTE FUNCTION memory_git_binding_repository()`,
    `CREATE UNIQUE INDEX memory_git_binding_normalized_path ON memory_git_asset_bindings(installation_id,connection_id,lower(normalize(path,NFC)))`,
    `CREATE TABLE memory_git_snapshots (
      export_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL,
      generation BIGINT NOT NULL CHECK(generation>0), schema_version TEXT NOT NULL DEFAULT 'memory-git.v1' CHECK(schema_version='memory-git.v1'),
      base_commit TEXT NOT NULL CHECK(base_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      ${digest('source_digest')}, ${digest('manifest_hash')},
      attestation BYTEA NOT NULL CHECK(octet_length(attestation) BETWEEN 1 AND 1048576),
      asset_count INTEGER NOT NULL CHECK(asset_count BETWEEN 1 AND 256),
      created_transaction BIGINT NOT NULL DEFAULT txid_current(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      UNIQUE(installation_id,connection_id,export_id), ${connectionRef}
    )`,
    `CREATE TABLE memory_git_snapshot_assets (
      installation_id UUID NOT NULL, connection_id UUID NOT NULL, export_id UUID NOT NULL, binding_id UUID NOT NULL,
      ${typedAsset}, ${typedVersion}, ${pathColumn}, base_revision BIGINT NOT NULL CHECK(base_revision>0),
      ${digest('source_digest')}, ${digest('content_hash')}, ${digest('file_hash')},
      base_document JSONB NOT NULL CHECK(jsonb_typeof(base_document)='object' AND octet_length(base_document::text)<=2097152),
      field_map JSONB NOT NULL CHECK(jsonb_typeof(field_map)='object' AND octet_length(field_map::text)<=262144),
      PRIMARY KEY(installation_id,export_id,binding_id), UNIQUE(installation_id,export_id,path),
      UNIQUE(installation_id,connection_id,export_id,binding_id,kind,asset_id,version_id,path),
      FOREIGN KEY(installation_id,connection_id,binding_id,kind,asset_id)
        REFERENCES memory_git_asset_bindings(installation_id,connection_id,binding_id,kind,asset_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE
    )`,
    `CREATE FUNCTION memory_git_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'git_snapshot_immutable'; END $$`,
    ...['memory_git_snapshots','memory_git_snapshot_assets'].map(table =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable()`),
    `CREATE FUNCTION memory_git_snapshot_asset_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE created BIGINT;
      BEGIN
        SELECT created_transaction INTO created FROM memory_git_snapshots
          WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id AND export_id=NEW.export_id;
        IF created IS NOT NULL AND created<>txid_current() THEN RAISE EXCEPTION 'git_snapshot_immutable'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_git_snapshot_asset_insert BEFORE INSERT ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_asset_insert()`,
    `CREATE FUNCTION memory_git_snapshot_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM memory_git_snapshots s WHERE s.export_id=NEW.export_id
          AND s.asset_count<>(SELECT COUNT(*) FROM memory_git_snapshot_assets a WHERE a.installation_id=s.installation_id AND a.export_id=s.export_id))
          THEN RAISE EXCEPTION 'git_snapshot_incomplete'; END IF;
        RETURN NULL;
      END $$`,
    `CREATE CONSTRAINT TRIGGER memory_git_snapshot_complete AFTER INSERT ON memory_git_snapshots DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_complete()`,
    `CREATE FUNCTION memory_git_snapshot_remove_incomplete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM memory_git_snapshots WHERE installation_id=OLD.installation_id AND export_id=OLD.export_id; RETURN OLD; END $$`,
    `CREATE TRIGGER memory_git_snapshot_remove_incomplete AFTER DELETE ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_remove_incomplete()`,
    `CREATE TABLE memory_git_revision_links (
      link_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, binding_id UUID NOT NULL,
      ${typedAsset}, ${typedVersion}, ${pathColumn},
      commit_sha TEXT NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      tree_sha TEXT NOT NULL CHECK(tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      direction TEXT NOT NULL CHECK(direction IN('export','import')), export_id UUID, proposal_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((direction='export' AND export_id IS NOT NULL AND proposal_id IS NULL) OR (direction='import' AND proposal_id IS NOT NULL AND export_id IS NULL)),
      UNIQUE(installation_id,connection_id,commit_sha,path,direction),
      FOREIGN KEY(installation_id,connection_id,binding_id,kind,asset_id)
        REFERENCES memory_git_asset_bindings(installation_id,connection_id,binding_id,kind,asset_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id,binding_id,kind,asset_id,version_id,path)
        REFERENCES memory_git_snapshot_assets(installation_id,connection_id,export_id,binding_id,kind,asset_id,version_id,path) ON DELETE CASCADE
    )`,
  ],
} as const

export const GIT_LEDGER_MIGRATION = {
  version: 40,
  statements: [
    `CREATE TABLE memory_git_runs (
      run_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, generation BIGINT NOT NULL CHECK(generation>0),
      direction TEXT NOT NULL CHECK(direction IN('export','import')), mode TEXT NOT NULL CHECK(mode IN('shadow','enabled')),
      outcome_kind TEXT NOT NULL CHECK(outcome_kind IN('fixture','shadow','consented_mpc','natural')),
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','preview','snapshot_ready','awaiting_approval','dispatching','pr_open','merged','closed',
        'received','verified','planned','awaiting_review','conflicted','awaiting_identity','applied','authorization_stale','reconciling','cancelled','invalidated','dead')),
      membership_id UUID NOT NULL, membership_revision BIGINT NOT NULL CHECK(membership_revision>0),
      authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0), config_version BIGINT NOT NULL CHECK(config_version>0),
      ${digest('request_hash')}, export_id UUID, job_id UUID,
      http_attempts INTEGER NOT NULL DEFAULT 0 CHECK(http_attempts BETWEEN 0 AND 128),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5),
      byte_count BIGINT NOT NULL DEFAULT 0 CHECK(byte_count>=0), next_attempt_at TIMESTAMPTZ,
      error_code TEXT CHECK(error_code ~ '^[a-z_]{1,64}$'), dry_run_result JSONB, result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '24 hours', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(mode<>'shadow' OR state NOT IN('dispatching','pr_open','merged','applied')),
      UNIQUE(installation_id,connection_id,run_id), UNIQUE(installation_id,connection_id,generation,request_hash), ${connectionRef},
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,job_id) REFERENCES memory_jobs(installation_id,job_id) ON DELETE SET NULL (job_id)
    )`,
    `CREATE UNIQUE INDEX memory_git_one_dispatch ON memory_git_runs(installation_id,connection_id) WHERE state IN('dispatching','reconciling')`,
    `CREATE TABLE memory_git_inbox (
      inbox_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL,
      event_id TEXT NOT NULL CHECK(char_length(event_id) BETWEEN 1 AND 256), ${digest('payload_hash')},
      state TEXT NOT NULL DEFAULT 'received' CHECK(state IN('received','verified','duplicate','rejected','processed','invalidated','dead')),
      run_id UUID, job_id UUID, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id,event_id), ${connectionRef},
      FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_runs(installation_id,connection_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,job_id) REFERENCES memory_jobs(installation_id,job_id) ON DELETE SET NULL (job_id)
    )`,
    `CREATE TABLE memory_git_outbox (
      outbox_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, run_id UUID NOT NULL, export_id UUID NOT NULL,
      generation BIGINT NOT NULL CHECK(generation>0), operation TEXT NOT NULL CHECK(operation IN('commit','branch','pull_request','reconcile')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','dispatching','reconciling','completed','cancelled','invalidated','dead')),
      expected_head TEXT CHECK(expected_head ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      expected_tree TEXT CHECK(expected_tree ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      remote_commit TEXT, remote_branch TEXT, remote_pr_id TEXT, next_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id,export_id,operation),
      FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_runs(installation_id,connection_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_git_import_proposals (
      proposal_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, export_id UUID NOT NULL, run_id UUID,
      generation BIGINT NOT NULL CHECK(generation>0), revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
      state TEXT NOT NULL DEFAULT 'received' CHECK(state IN('received','verified','planned','awaiting_review','conflicted','awaiting_identity','applied','authorization_stale','cancelled','invalidated','dead','noop')),
      base_revision BIGINT NOT NULL CHECK(base_revision>0), ${digest('base_hash')}, ${digest('local_hash')}, ${digest('proposed_hash')}, ${digest('policy_hash')},
      proposed_document JSONB NOT NULL CHECK(jsonb_typeof(proposed_document)='object' AND octet_length(proposed_document::text)<=2097152),
      provider_actor_id TEXT CHECK(char_length(provider_actor_id) BETWEEN 1 AND 256), membership_id UUID, membership_revision BIGINT CHECK(membership_revision>0),
      authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0), head_commit TEXT NOT NULL CHECK(head_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id,proposal_id), UNIQUE(installation_id,proposal_id),
      UNIQUE(installation_id,proposal_id,revision,base_revision,proposed_hash,policy_hash),
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_runs(installation_id,connection_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_git_conflicts (
      conflict_id UUID PRIMARY KEY, installation_id UUID NOT NULL, proposal_id UUID NOT NULL, proposal_revision BIGINT NOT NULL CHECK(proposal_revision>0),
      field TEXT NOT NULL CHECK(char_length(field) BETWEEN 1 AND 512),
      reason TEXT NOT NULL CHECK(reason IN('both_modified','delete_edit','rename_collision','locked')),
      resolution JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(installation_id,proposal_id,proposal_revision,field),
      FOREIGN KEY(installation_id,proposal_id) REFERENCES memory_git_import_proposals(installation_id,proposal_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_git_review_decisions (
      decision_id UUID PRIMARY KEY, installation_id UUID NOT NULL, proposal_id UUID NOT NULL,
      proposal_revision BIGINT NOT NULL CHECK(proposal_revision>0), base_revision BIGINT NOT NULL CHECK(base_revision>0),
      ${digest('proposed_hash')}, ${digest('policy_hash')},
      membership_id UUID NOT NULL, membership_revision BIGINT NOT NULL CHECK(membership_revision>0), authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      decision TEXT NOT NULL CHECK(decision IN('approve','request_changes','reject')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,proposal_id,proposal_revision,membership_id),
      FOREIGN KEY(installation_id,proposal_id,proposal_revision,base_revision,proposed_hash,policy_hash)
        REFERENCES memory_git_import_proposals(installation_id,proposal_id,revision,base_revision,proposed_hash,policy_hash) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE
    )`,
    `CREATE FUNCTION memory_git_proposal_edit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.proposed_document,NEW.proposed_hash,NEW.base_revision,NEW.base_hash,NEW.local_hash,NEW.policy_hash,NEW.head_commit)
          IS DISTINCT FROM (OLD.proposed_document,OLD.proposed_hash,OLD.base_revision,OLD.base_hash,OLD.local_hash,OLD.policy_hash,OLD.head_commit)
          AND NEW.revision<=OLD.revision THEN RAISE EXCEPTION 'git_proposal_revision_required'; END IF;
        IF NEW.revision<>OLD.revision THEN
          IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'git_proposal_revision_required'; END IF;
          DELETE FROM memory_git_review_decisions WHERE installation_id=OLD.installation_id AND proposal_id=OLD.proposal_id;
          DELETE FROM memory_git_conflicts WHERE installation_id=OLD.installation_id AND proposal_id=OLD.proposal_id;
          IF NEW.state='applied' THEN RAISE EXCEPTION 'git_proposal_review_required'; END IF;
        END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_git_proposal_edit BEFORE UPDATE ON memory_git_import_proposals FOR EACH ROW EXECUTE FUNCTION memory_git_proposal_edit()`,
    `ALTER TABLE memory_git_revision_links ADD CONSTRAINT memory_git_revision_proposal_fk FOREIGN KEY(installation_id,connection_id,proposal_id)
      REFERENCES memory_git_import_proposals(installation_id,connection_id,proposal_id) ON DELETE CASCADE`,
    // No content or unbounded metadata slot. IDs intentionally survive content
    // deletion; installation retention/purge is a separate lifecycle policy.
    `CREATE TABLE memory_git_audit_events (
      event_id UUID PRIMARY KEY, installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      connection_id UUID, export_id UUID, proposal_id UUID, run_id UUID, membership_id UUID,
      membership_revision BIGINT CHECK(membership_revision>0), authorization_epoch BIGINT CHECK(authorization_epoch>0),
      old_version_id UUID, new_version_id UUID, content_hash TEXT CHECK(content_hash ~ '^[0-9a-f]{64}$'),
      action TEXT NOT NULL CHECK(action IN('connection','mapping','snapshot','import','review','apply','dispatch','reconcile','invalidate','purge')),
      outcome TEXT NOT NULL CHECK(outcome IN('allowed','denied','noop','invalidated','pending')),
      reason_code TEXT NOT NULL CHECK(reason_code IN('ok','forbidden','invalid_request','not_found','generation_conflict','authorization_stale',
        'source_invalid','identity_unknown','revision_conflict','policy_changed','self_review_denied','feature_disabled','remote_cleanup_pending','purged')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX memory_git_audit_scope_time ON memory_git_audit_events(installation_id,created_at,event_id)`,
    ...['memory_git_revision_links','memory_git_review_decisions','memory_git_audit_events'].map(table =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable()`),
  ],
} as const
