/** Additive only: no legacy Claim identity or permissions are rewritten. */
export const SCENE_MIGRATION={version:76,statements:[
 `CREATE TABLE memory_spaces (
  installation_id UUID NOT NULL REFERENCES memory_installations ON DELETE CASCADE,
  space_id UUID NOT NULL DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK(domain IN('personal_project','work','life','profile')),
  name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200),
  destinations TEXT[] NOT NULL CHECK(cardinality(destinations)>0 AND destinations <@ ARRAY['personal','work','shared']::text[]),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','archived')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(installation_id,space_id))`,
 `CREATE TABLE memory_space_bindings (
  installation_id UUID NOT NULL,space_id UUID NOT NULL,repository_id UUID NOT NULL,
  PRIMARY KEY(installation_id,space_id,repository_id),
  FOREIGN KEY(installation_id,space_id) REFERENCES memory_spaces ON DELETE CASCADE,
  FOREIGN KEY(installation_id,repository_id) REFERENCES repositories(installation_id,repository_id) ON DELETE CASCADE)`,
 `CREATE TABLE memory_entities (
  installation_id UUID NOT NULL,space_id UUID NOT NULL,entity_id UUID NOT NULL DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK(kind IN('person','project','service','issue','trip','event','self','other')),
  name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200),
  PRIMARY KEY(installation_id,space_id,entity_id),
  FOREIGN KEY(installation_id,space_id) REFERENCES memory_spaces ON DELETE CASCADE)`,
 `CREATE TABLE memory_entity_aliases (
  installation_id UUID NOT NULL,space_id UUID NOT NULL,entity_id UUID NOT NULL,
  alias TEXT NOT NULL CHECK(char_length(alias) BETWEEN 1 AND 200),
  PRIMARY KEY(installation_id,space_id,entity_id,alias),
  FOREIGN KEY(installation_id,space_id,entity_id) REFERENCES memory_entities ON DELETE CASCADE)`,
 // Aliases need not be unique: ambiguous names must be resolved, not merged.
 `CREATE INDEX memory_entity_alias_lookup ON memory_entity_aliases(installation_id,space_id,alias)`,
 `CREATE TABLE memory_logical_claims (
  installation_id UUID NOT NULL,space_id UUID NOT NULL,subject_entity_id UUID NOT NULL,
  logical_key TEXT NOT NULL CHECK(logical_key ~ '^[a-f0-9]{64}$'),
  predicate_id TEXT NOT NULL CHECK(predicate_id ~ '^[a-z][a-z0-9_.]{0,119}$'),
  variant JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(variant)='object'),
  cardinality TEXT NOT NULL CHECK(cardinality IN('single','set','event')),
  member_key TEXT,
  claim_id UUID NOT NULL,
  CHECK((cardinality='single' AND member_key IS NULL) OR(cardinality IN('set','event') AND char_length(member_key)>0 AND member_key IS NOT NULL)),
  PRIMARY KEY(installation_id,logical_key), UNIQUE(installation_id,claim_id),
  FOREIGN KEY(installation_id,space_id,subject_entity_id) REFERENCES memory_entities(installation_id,space_id,entity_id),
  FOREIGN KEY(installation_id,claim_id) REFERENCES knowledge_claims(installation_id,claim_id) ON DELETE CASCADE)`,
]}
