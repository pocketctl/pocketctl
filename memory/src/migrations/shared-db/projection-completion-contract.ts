/** Per-context checkpoints and complete per-installation progress have
 * different meanings. Only a sealed, wholly ready set may advance the latter. */
export const SHARED_SOURCE_PROJECTION_COMPLETION_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_source_scope_key(p_scope JSONB) RETURNS TEXT
  LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$ BEGIN
   IF jsonb_typeof(p_scope)<>'object' OR octet_length(p_scope::text)>32768 THEN RAISE EXCEPTION 'invalid_source_scope';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_each(p_scope) WHERE jsonb_typeof(value)<>'string') THEN RAISE EXCEPTION 'invalid_source_scope';END IF;
   -- SourceScope is a flat string record. Match canonicalJsonString exactly;
   -- jsonb::text itself has whitespace and a different key order.
   RETURN encode(sha256(convert_to('{'||(SELECT COALESCE(string_agg(to_jsonb(key)::text||':'||value::text,',' ORDER BY key COLLATE "C"),'') FROM jsonb_each(p_scope))||'}','UTF8')),'hex');
  END $$`,
 `DROP FUNCTION IF EXISTS shared.complete_memory_source_projection(UUID,JSONB,TEXT,TEXT,JSONB) RESTRICT`,
 `REVOKE ALL ON FUNCTION shared.memory_source_scope_key(JSONB) FROM PUBLIC`,
] as const
