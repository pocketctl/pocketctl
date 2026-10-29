/** Exact, content-free v2 Team delivery controls may bypass withdrawn capture
 * subscriptions. Keep this independent of live Team/installation rows: those
 * may already be gone by the time the personal privacy feed is consumed.
 * `f` is the internal extension_feed alias, never supplied by a request. */
export const TEAM_DELIVERY_REVOCATION_FILTER_SQL = `(
  f.topic='session.access.revoked.v1' AND f.source_kind='session_access_revoked'
  AND f.session_id ~ '^team_delivery_[0-9a-f]{32}$'
  AND f.payload=jsonb_build_object(
    'envelope_version',1,'topic','session.access.revoked.v1',
    'source',jsonb_build_object('kind',f.source_kind,'id',f.source_id,'recorded_at',f.payload #> '{source,recorded_at}'),
    'subject',jsonb_build_object('session_id',f.session_id,'event_type','session_access_revoked'),
    'classification','{}'::jsonb,'data',f.payload->'data')
  AND f.payload #>> '{source,recorded_at}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  AND CASE WHEN jsonb_typeof(f.payload->'data')='object' THEN (f.payload->'data') - ARRAY[
    'reason','team_delivery_source_revoked','submission_id','decision_id','team_id','team_session_id',
    'team_memory_binding_id','team_memory_binding_revision','participant_user_id','participant_revision']::text[]
    ELSE NULL END = '{}'::jsonb
  AND f.payload #> '{data,team_delivery_source_revoked}'='true'::jsonb
  AND f.payload #>> '{data,reason}' IN ('artifact_revoked','participant_removed','binding_removed','team_member_left','team_member_removed','team_dissolved')
  AND jsonb_typeof(f.payload #> '{data,team_id}')='string' AND length(btrim(f.payload #>> '{data,team_id}'))>0
  AND length(f.payload #>> '{data,team_id}')<=512
  AND jsonb_typeof(f.payload #> '{data,team_session_id}')='string' AND length(btrim(f.payload #>> '{data,team_session_id}'))>0
  AND length(f.payload #>> '{data,team_session_id}')<=512
  AND jsonb_typeof(f.payload #> '{data,team_memory_binding_id}')='string' AND length(btrim(f.payload #>> '{data,team_memory_binding_id}'))>0
  AND length(f.payload #>> '{data,team_memory_binding_id}')<=512
  AND jsonb_typeof(f.payload #> '{data,submission_id}')='string'
  AND f.payload #>> '{data,submission_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND jsonb_typeof(f.payload #> '{data,decision_id}')='string'
  AND f.payload #>> '{data,decision_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND jsonb_typeof(f.payload #> '{data,team_memory_binding_revision}')='number'
  AND f.payload #>> '{data,team_memory_binding_revision}' ~ '^[1-9][0-9]{0,15}$'
  AND (length(f.payload #>> '{data,team_memory_binding_revision}')<16 OR f.payload #>> '{data,team_memory_binding_revision}'<='9007199254740991')
  AND jsonb_typeof(f.payload #> '{data,participant_revision}')='number'
  AND f.payload #>> '{data,participant_revision}' ~ '^[1-9][0-9]{0,15}$'
  AND (length(f.payload #>> '{data,participant_revision}')<16 OR f.payload #>> '{data,participant_revision}'<='9007199254740991')
  AND jsonb_typeof(f.payload #> '{data,participant_user_id}')='number'
  AND f.payload #>> '{data,participant_user_id}'=f.owner_user_id::text
  AND f.source_id=(CASE WHEN f.payload #>> '{data,reason}'='artifact_revoked' THEN 'team-delivery-withdraw:' ELSE 'team-delivery-revoke:' END)||f.session_id
  AND f.session_id='team_delivery_'||left(encode(sha256(convert_to('['||concat_ws(',',
    '"team-accepted-delivery-v2"',
    (f.payload #> '{data,team_session_id}')::text,(f.payload #> '{data,submission_id}')::text,
    (f.payload #> '{data,decision_id}')::text,(f.payload #> '{data,team_memory_binding_id}')::text,
    (f.payload #> '{data,team_memory_binding_revision}')::text,(f.payload #> '{data,participant_user_id}')::text,
    (f.payload #> '{data,participant_revision}')::text)||']','UTF8')),'hex'),32)
)`
