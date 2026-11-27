// The call identity survives replacing a search document, but follows version
// erasure. No claim text or vector is copied into the accounting checkpoint.
export const INDEX_CALL_MIGRATION={version:115,statements:[
  `CREATE TABLE memory_index_calls(
     installation_id UUID NOT NULL,version_id UUID NOT NULL,input_digest BYTEA NOT NULL,
     call_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, state TEXT NOT NULL
       CHECK(state IN('intended','possible','published','unconfirmed','invalid_result')),
     budget_reservation_id UUID, occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),finished_at TIMESTAMPTZ,
     PRIMARY KEY(installation_id,version_id,input_digest),
     FOREIGN KEY(installation_id,version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE)`,
  `CREATE INDEX memory_unresolved_index_calls ON memory_index_calls(installation_id,occurred_at)
    WHERE state IN('possible','unconfirmed','invalid_result')`,
]} as const
