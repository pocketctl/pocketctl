/** Explicit invalidation fences complement content foreign-key cascades. */
export const SKILL_LIFECYCLE_MIGRATION = {
  version:37,
  statements:[
    `ALTER TABLE memory_skill_review_decisions ADD COLUMN review_outcome TEXT CHECK(review_outcome IN('accepted_as_is','light_edit','major_edit'))`,
    `ALTER TABLE memory_skill_review_decisions ADD CONSTRAINT memory_skill_review_outcome_action CHECK(review_outcome IS NULL OR decision='approve')`,
    `CREATE FUNCTION memory_skill_publication_disabled() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state='disabled' THEN
          UPDATE memory_skill_rollouts SET state='disabled',revision=revision+1,updated_at=NOW()
            WHERE installation_id=NEW.installation_id AND skill_id=NEW.skill_id AND state<>'disabled';
          UPDATE memory_skill_executions SET state='cancelled',revision=revision+1,completed_at=NOW()
            WHERE installation_id=NEW.installation_id AND skill_id=NEW.skill_id AND state='started';
        END IF; RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_publication_disabled AFTER UPDATE OF state ON memory_skill_publication_heads
      FOR EACH ROW EXECUTE FUNCTION memory_skill_publication_disabled()`,
    `CREATE FUNCTION memory_skill_forget_tasks(target_installation UUID,target_tasks UUID[]) RETURNS VOID LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM memory_skill_tasks WHERE installation_id=target_installation AND task_id=ANY(target_tasks) ORDER BY task_id FOR UPDATE;
        UPDATE memory_generation_runs g SET state='cancelled',error_code='skill_source_invalidated',completed_at=NOW()
          FROM memory_skill_task_runs r WHERE r.installation_id=target_installation AND r.task_id=ANY(target_tasks)
            AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
        UPDATE memory_jobs SET state='completed',last_error_code='skill_source_invalidated',completed_at=NOW(),claim_expires_at=NULL
          WHERE installation_id=target_installation AND job_type='extract_skill_candidate' AND state IN('pending','running')
            AND payload->>'task_id'=ANY(ARRAY(SELECT unnest(target_tasks)::text));
        DELETE FROM memory_skill_archives WHERE installation_id=target_installation AND task_id=ANY(target_tasks);
        DELETE FROM memory_skill_tasks WHERE installation_id=target_installation AND task_id=ANY(target_tasks);
      END $$`,
    `CREATE FUNCTION memory_skill_scope_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ids UUID[];
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state<>'active'
          OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
          SELECT ARRAY_AGG(task_id ORDER BY task_id) INTO ids FROM memory_skill_tasks WHERE installation_id=NEW.installation_id;
          PERFORM memory_skill_forget_tasks(NEW.installation_id,COALESCE(ids,ARRAY[]::UUID[]));
        END IF;
        IF NEW.state='dissolved' THEN
          DELETE FROM memory_skill_publication_policy_heads WHERE installation_id=NEW.installation_id;
          DELETE FROM memory_skill_publication_policy_versions WHERE installation_id=NEW.installation_id;
        END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_scope_invalidated AFTER UPDATE OF state,authorization_epoch ON memory_owner_scopes
      FOR EACH ROW EXECUTE FUNCTION memory_skill_scope_invalidated()`,
    `CREATE FUNCTION memory_skill_member_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state OR NEW.membership_revision IS DISTINCT FROM OLD.membership_revision OR NEW.roles IS DISTINCT FROM OLD.roles THEN
          UPDATE memory_skill_publication_heads p SET state='disabled',revision=revision+1,updated_at=NOW()
            WHERE p.installation_id=NEW.installation_id AND p.state='active' AND (
              EXISTS(SELECT 1 FROM memory_skill_publication_events e WHERE e.installation_id=p.installation_id AND e.event_id=p.publication_event_id
                AND e.actor_kind='membership' AND e.actor_id=NEW.membership_id)
              OR EXISTS(SELECT 1 FROM memory_skill_review_decisions d WHERE d.installation_id=p.installation_id AND d.version_id=p.current_version_id
                AND d.actor_kind='membership' AND d.actor_id=NEW.membership_id));
          UPDATE memory_skill_executions e SET state='cancelled',revision=revision+1,completed_at=NOW()
            WHERE e.installation_id=NEW.installation_id AND e.state='started' AND
              ((e.actor_kind='membership' AND e.actor_id=NEW.membership_id) OR EXISTS(
                SELECT 1 FROM memory_skill_publication_heads p WHERE p.installation_id=e.installation_id AND p.skill_id=e.skill_id AND p.state='disabled'));
        END IF; RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_member_invalidated AFTER UPDATE OF state,membership_revision,roles ON memory_scope_memberships
      FOR EACH ROW EXECUTE FUNCTION memory_skill_member_invalidated()`,
    `CREATE FUNCTION memory_skill_installation_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ids UUID[];
      BEGIN
        IF NEW.relay_status IN('revoking','revoked') OR NEW.local_status IN('purging','purged','integrity_error') THEN
          SELECT ARRAY_AGG(task_id ORDER BY task_id) INTO ids FROM memory_skill_tasks WHERE installation_id=NEW.installation_id;
          PERFORM memory_skill_forget_tasks(NEW.installation_id,COALESCE(ids,ARRAY[]::UUID[]));
          DELETE FROM memory_skill_publication_policy_heads WHERE installation_id=NEW.installation_id;
          DELETE FROM memory_skill_publication_policy_versions WHERE installation_id=NEW.installation_id;
        END IF; RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_installation_invalidated AFTER UPDATE OF relay_status,local_status ON memory_installations
      FOR EACH ROW EXECUTE FUNCTION memory_skill_installation_invalidated()`,
    `CREATE FUNCTION memory_skill_snapshot_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ids UUID[];
      BEGIN
        SELECT ARRAY_AGG(DISTINCT r.task_id) INTO ids FROM memory_skill_task_runs r JOIN repo_snapshots s USING(installation_id,repo_snapshot_id)
          WHERE r.installation_id=NEW.installation_id AND s.repository_id=NEW.repository_id AND s.commit_sha=NEW.commit_sha;
        PERFORM memory_skill_forget_tasks(NEW.installation_id,COALESCE(ids,ARRAY[]::UUID[])); RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_snapshot_invalidated AFTER INSERT ON memory_source_snapshot_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_snapshot_invalidated()`,
    `CREATE FUNCTION memory_skill_archive_snapshot_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM repo_snapshots s JOIN memory_source_snapshot_tombstones t
          ON t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha
          WHERE s.installation_id=NEW.installation_id AND s.repo_snapshot_id=NEW.repo_snapshot_id)
        THEN RAISE EXCEPTION 'skill_source_snapshot_purged'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_skill_archive_snapshot_fence BEFORE INSERT ON memory_skill_archives
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_snapshot_fence()`,
  ],
} as const
