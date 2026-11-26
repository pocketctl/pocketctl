// These event types do not write accounting facts when the usage key is absent.
// A new or malformed event remains a blocker until its contract is known.
export const nonAccountingDeadLetter = `(i.event_type = 'subagent_usage' OR (
  jsonb_typeof(i.payload) = 'object' AND NOT (i.payload ? 'usage') AND i.event_type IN (
    'agent_text', 'tool_call', 'tool_result', 'user_text', 'turn_status',
    'session_meta', 'session_model_changed', 'subagent_discovered', 'session_discovered',
    'session_document_begin', 'session_document_chunk', 'session_document_commit',
    'agent_plan', 'agent_reasoning', 'session_status', 'error', 'agent_file_change'
  )))`

// Use the same stable event hash as eventHashInput, then verify the full ID
// against the stored event/header. A hash collision must not settle a dead letter.
export const sameStableEvent = `e.session_id=i.session_id AND e.user_id=i.user_id
  AND e.event_type=i.event_type AND NOT e.owner_retired AND e.effect_status IN ('none','completed')
  AND i.payload->>'type'=i.event_type AND i.payload->>'session_id'=i.session_id
  AND jsonb_typeof(i.payload->'event_id')='string' AND i.payload->>'event_id'<>''
  AND e.event_hash=left(md5(i.session_id||':'||i.event_type||':event:'||(i.payload->>'event_id')),16)
  AND (CASE e.body_storage WHEN 'hot' THEN e.payload WHEN 'cold' THEN e.body_header END)->'event_id'=i.payload->'event_id'`

const components = {
  input_tokens: 'input', output_tokens: 'output', cache_read_tokens: 'cache_read',
  cache_create_tokens: 'cache_create', reasoning_tokens: 'reasoning', total_tokens: 'reported_total',
}
const usage = "(i.payload->'usage')"

// This proves only that accounting is settled. It does not resolve conflicts
// in the event body or its provenance, or authorize deleting either event.
export const accountedDeadLetter = `i.event_type='agent_text'
  AND i.last_error IN ('materialization_failed','replay_payload_conflict','replay_provenance_conflict')
  AND jsonb_typeof(${usage})='object' AND ${usage}<>'{}'::jsonb
  AND CASE WHEN jsonb_typeof(${usage})='object' THEN
    (${usage} - ARRAY[${Object.keys(components).map(key => `'${key}'`).join(',')}])='{}'::jsonb
    ELSE false END
  AND EXISTS (SELECT 1 FROM events e JOIN token_usage_facts f ON f.source_event_id=e.id
    WHERE ${sameStableEvent} AND f.user_id=i.user_id AND f.daemon_id=i.daemon_id
      AND f.session_id=i.session_id AND NOT f.session_attribution_revoked AND f.requests=1
      AND ${Object.entries(components).map(([key,column]) =>
        `COALESCE(${usage}->'${key}','0'::jsonb)=to_jsonb(f.${column})`).join(' AND ')})`
