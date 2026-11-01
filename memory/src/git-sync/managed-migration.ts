export const GIT_MANAGED_SETUP_MIGRATION = {
  version: 73,
  statements: [
    `CREATE TABLE memory_git_managed_signer (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), key_id TEXT NOT NULL UNIQUE,
      private_key_cipher BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE memory_git_project_targets (
      installation_id UUID NOT NULL, project_id UUID NOT NULL, connection_id UUID NOT NULL,
      target JSONB NOT NULL, token_cipher BYTEA, consent_until TIMESTAMPTZ NOT NULL,
      authorized_membership_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(installation_id,project_id), UNIQUE(installation_id,connection_id),
      FOREIGN KEY(installation_id,connection_id) REFERENCES memory_git_connections(installation_id,connection_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_git_project_setup_requests (
      installation_id UUID NOT NULL, project_id UUID NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(installation_id,project_id,request_key),
      FOREIGN KEY(installation_id,project_id) REFERENCES memory_git_project_targets(installation_id,project_id) ON DELETE CASCADE
    )`,
  ],
}
