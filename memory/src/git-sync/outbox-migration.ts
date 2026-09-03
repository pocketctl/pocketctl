/** Additive Task6 protocol steps and early key mutation discipline. */
export const GIT_OUTBOX_MIGRATION={version:42,statements:[
  `CREATE FUNCTION memory_git_key_statement_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('memory:git:attestation-keys',0)); RETURN NULL; END $$`,
  `CREATE TRIGGER memory_git_key_statement_gate BEFORE INSERT OR UPDATE OR DELETE ON memory_git_attestation_keys
    FOR EACH STATEMENT EXECUTE FUNCTION memory_git_key_statement_gate()`,
  `ALTER TABLE memory_git_request_reservations DROP CONSTRAINT memory_git_request_reservations_operation_check`,
  `ALTER TABLE memory_git_request_reservations ADD CONSTRAINT memory_git_request_reservations_operation_check
    CHECK(operation IN('repository','merge','commit','tree','poll','write_tree','write_commit','write_branch','write_file','write_pull_request','reconcile'))`,
  `ALTER TABLE memory_git_outbox ADD CONSTRAINT memory_git_outbox_tenant_id UNIQUE(installation_id,connection_id,outbox_id)`,
  `ALTER TABLE memory_git_outbox ADD COLUMN description_hash TEXT CHECK(description_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN expected_commit TEXT CHECK(expected_commit ~ '^[0-9a-f]{40}$')`,
  `CREATE TABLE memory_git_outbox_steps(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,outbox_id UUID NOT NULL,step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 511),
    operation TEXT NOT NULL CHECK(operation IN('tree','commit','branch','file','pull_request')),
    state TEXT NOT NULL CHECK(state IN('pending','dispatching','reconciling','completed','conflicted')),
    path TEXT CHECK(octet_length(path)<=512 AND path LIKE '.pocketctl/knowledge/%'),
    expected_head TEXT CHECK(expected_head ~ '^[0-9a-f]{40}$'),expected_blob TEXT CHECK(expected_blob ~ '^[0-9a-f]{40}$'),
    expected_tree TEXT CHECK(expected_tree ~ '^[0-9a-f]{40}$'),expected_commit TEXT CHECK(expected_commit ~ '^[0-9a-f]{40}$'),
    remote_sha TEXT CHECK(remote_sha ~ '^[0-9a-f]{40}$'),remote_tree TEXT CHECK(remote_tree ~ '^[0-9a-f]{40}$'),
    remote_number TEXT CHECK(remote_number ~ '^[1-9][0-9]{0,14}$'),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,connection_id,outbox_id,step),
    FOREIGN KEY(installation_id,connection_id,outbox_id) REFERENCES memory_git_outbox(installation_id,connection_id,outbox_id) ON DELETE CASCADE)`,
] } as const
