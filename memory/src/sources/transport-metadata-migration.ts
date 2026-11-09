/** Content-free delivery facts serve integrity/purge/health independently of
 * raw transport storage. The explicit retirement operation retargets these
 * views only after proving the fixed body set and fencing legacy writers. */
export const DELIVERY_FACT_COLUMNS='installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,payload_hash,projection_state,error_code,received_at,projected_at,body_reclaimed_at'
export const SNAPSHOT_FACT_COLUMNS='run_id,installation_id,generation,state,inventory_cursor,sessions_seen,events_seen,error_code,started_at,completed_at,relay_acked_at,source_mode_generation'
export const DELIVERY_FACT_TYPES=['uuid','bigint','integer','text','text','text','text','text','text','timestamp with time zone','bytea','text','text','timestamp with time zone','timestamp with time zone','timestamp with time zone'] as const
export const DELIVERY_FACT_REQUIRED=['installation_id','feed_id','envelope_version','topic','source_kind','source_id','event_type','recorded_at','payload_hash','projection_state','received_at'] as const
export const SNAPSHOT_FACT_TYPES=['uuid','uuid','bigint','text','text','bigint','bigint','text','timestamp with time zone','timestamp with time zone','timestamp with time zone','bigint'] as const
export const SNAPSHOT_FACT_REQUIRED=['run_id','installation_id','generation','state','sessions_seen','events_seen','started_at'] as const
export const TRANSPORT_METADATA_MIGRATION={version:98,statements:[
 `CREATE VIEW memory_source_delivery_facts AS SELECT ${DELIVERY_FACT_COLUMNS} FROM memory_feed_inbox`,
 `CREATE VIEW memory_source_snapshot_facts AS SELECT ${SNAPSHOT_FACT_COLUMNS} FROM memory_snapshot_runs`,
]} as const
