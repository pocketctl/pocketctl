/** Durable, content-free attribution. Proposals may be planned before a worker
 * binds a verified merge; once bound, revisions can never move that identity. */
export const GIT_METRICS_MIGRATION={version:45,statements:[
  `CREATE TABLE memory_git_proposal_runs(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,run_id UUID NOT NULL,
    PRIMARY KEY(installation_id,connection_id,proposal_id),
    FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_proposal_identities(installation_id,connection_id,proposal_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_run_receipts(installation_id,connection_id,run_id) ON DELETE CASCADE)`,
  `INSERT INTO memory_git_proposal_runs SELECT p.installation_id,p.connection_id,p.proposal_id,m.run_id
    FROM memory_git_import_proposals p JOIN memory_git_merge_receipts m
      ON m.installation_id=p.installation_id AND m.connection_id=p.connection_id AND m.generation=p.generation AND m.commit_sha=p.head_commit AND m.run_id=p.run_id`,
  `INSERT INTO memory_git_proposal_runs SELECT o.installation_id,o.connection_id,o.proposal_id,m.run_id
    FROM memory_git_retained_outcomes o JOIN memory_git_merge_receipts m
      ON m.installation_id=o.installation_id AND m.connection_id=o.connection_id AND m.generation=o.generation AND m.commit_sha=o.commit_sha
    ON CONFLICT DO NOTHING`,
  `CREATE FUNCTION memory_git_validate_proposal_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'git_proposal_run_immutable'; END IF;
    IF NOT EXISTS(SELECT 1 FROM memory_git_import_proposals p JOIN memory_git_merge_receipts m
      ON m.installation_id=p.installation_id AND m.connection_id=p.connection_id AND m.generation=p.generation AND m.commit_sha=p.head_commit AND m.run_id=p.run_id
      WHERE p.installation_id=NEW.installation_id AND p.connection_id=NEW.connection_id AND p.proposal_id=NEW.proposal_id AND m.run_id=NEW.run_id)
    AND NOT EXISTS(SELECT 1 FROM memory_git_retained_outcomes o JOIN memory_git_merge_receipts m
      ON m.installation_id=o.installation_id AND m.connection_id=o.connection_id AND m.generation=o.generation AND m.commit_sha=o.commit_sha
      WHERE o.installation_id=NEW.installation_id AND o.connection_id=NEW.connection_id AND o.proposal_id=NEW.proposal_id AND m.run_id=NEW.run_id)
    THEN RAISE EXCEPTION 'git_proposal_run_invalid'; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_validate_proposal_run BEFORE INSERT OR UPDATE ON memory_git_proposal_runs FOR EACH ROW EXECUTE FUNCTION memory_git_validate_proposal_run()`,
  `CREATE FUNCTION memory_git_bind_proposal_run() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE saved UUID; BEGIN
    SELECT run_id INTO saved FROM memory_git_proposal_runs WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id AND proposal_id=NEW.proposal_id;
    IF saved IS NOT NULL AND saved IS DISTINCT FROM NEW.run_id THEN RAISE EXCEPTION 'git_proposal_run_immutable'; END IF;
    IF NEW.run_id IS NOT NULL AND saved IS NULL THEN
      INSERT INTO memory_git_proposal_runs VALUES(NEW.installation_id,NEW.connection_id,NEW.proposal_id,NEW.run_id);
    END IF; RETURN NEW; END $$`,
  // Trigger ordering places identity creation first on INSERT. The normal worker
  // attaches run_id in its finalizer; this binding rolls back with that finalizer.
  `CREATE TRIGGER memory_git_z_bind_proposal_run AFTER INSERT OR UPDATE OF run_id ON memory_git_import_proposals FOR EACH ROW EXECUTE FUNCTION memory_git_bind_proposal_run()`,
]} as const
