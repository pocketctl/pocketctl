import { replayContentTypes } from '../materialization/replay-batch-policy.js'
import { nonAccountingDeadLetter, sameStableEvent } from '../token-usage/dead-letter-policy.js'
import { INBOX_MAX_ATTEMPTS } from './types.js'

// A live activity gap is itself evidence for the platform statistics watermark.
// Keep a conservative superset of those inputs regardless of the reporting window.
const statisticsInput = `i.user_id IS NOT NULL AND COALESCE(i.payload->>'resync','false')<>'true'
  AND (i.event_type IN ('session_created','session_status','user_message_receipt','agent_text')
    OR (i.event_type='user_text' AND (i.payload ? 'local_submit_id' OR i.payload->>'event_id' LIKE 'native-input:%')))`

const exhausted = `i.last_error='materialization_failed' AND i.attempts>=${INBOX_MAX_ATTEMPTS}`
const deletedSession = `EXISTS (SELECT 1 FROM deleted_sessions d WHERE d.session_id=i.session_id)
  AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=i.session_id)
  AND NOT EXISTS (SELECT 1 FROM session_aliases a WHERE a.old_session_id=i.session_id)`

// Only historical content with no remaining business effect. Include provenance
// in the byte comparison; transport sequence and the resync flag alone may differ.
const duplicateReplay = `i.event_type IN (${replayContentTypes.map(type => `'${type}'`).join(',')})
  AND i.payload->'resync'='true'::jsonb AND NOT (i.payload ? 'request_id')
  AND i.payload->'is_subagent' IS DISTINCT FROM 'true'::jsonb
  AND CASE WHEN jsonb_typeof(i.materialization_context)='object' THEN
    (i.materialization_context - ARRAY['agentType','cwd','hostname','reservationId'])='{}'::jsonb ELSE false END
  AND i.materialization_context->>'reservationId' IS NULL
  AND EXISTS (SELECT 1 FROM events e JOIN sessions s ON s.session_id=e.session_id
    WHERE ${sameStableEvent} AND s.user_id=i.user_id AND s.daemon_id=i.daemon_id
      AND e.body_storage='hot' AND CASE WHEN jsonb_typeof(e.payload)='object' AND jsonb_typeof(i.payload)='object'
        THEN (e.payload - ARRAY['seq','resync'])=(i.payload - ARRAY['seq','resync']) ELSE false END)`

// These fields are mandatory before the document handler can perform any write.
// Retrying the original immutable packet cannot supply an absent field.
const malformedDocument = `i.last_error='document_integrity'
  AND i.event_type IN ('session_document_begin','session_document_chunk','session_document_commit')
  AND (i.user_id IS NULL OR i.session_id IS NULL OR EXISTS (
    SELECT 1 FROM unnest(CASE WHEN i.event_type='session_document_begin'
      THEN ARRAY['session_id','document_id','event_id']
      ELSE ARRAY['session_id','document_id','event_id','version_id'] END) AS required(key)
    WHERE jsonb_typeof(i.payload->key) IS DISTINCT FROM 'string' OR btrim(i.payload->>key)=''))`

// Never decode untrusted base64. Compare the stored range's encoding and digest,
// and validate the numeric offset before casting, so malformed packets stay held.
const savedDocument = `i.last_error='document_upload_expired'
  AND i.event_type IN ('session_document_chunk','session_document_commit')
  AND i.payload->>'type'=i.event_type AND i.payload->>'session_id'=i.session_id
  AND NOT EXISTS (SELECT 1 FROM session_document_uploads u WHERE u.version_id=i.payload->>'version_id')
  AND EXISTS (SELECT 1 FROM session_document_versions v
    WHERE v.version_id=i.payload->>'version_id' AND v.document_id=i.payload->>'document_id'
      AND v.user_id=i.user_id AND v.session_id=i.session_id AND v.body_storage='hot'
      AND EXISTS (SELECT 1 FROM session_documents d WHERE d.document_id=v.document_id AND NOT d.owner_retired)
      AND CASE i.event_type
        WHEN 'session_document_commit' THEN to_jsonb(v.byte_size)=i.payload->'total_bytes'
          AND v.sha256=i.payload->>'content_hash' AND encode(sha256(v.content_bytes),'hex')=v.sha256
        WHEN 'session_document_chunk' THEN CASE WHEN jsonb_typeof(i.payload->'byte_offset')='number' AND i.payload->>'byte_offset' ~ '^[0-9]{1,9}$'
          AND jsonb_typeof(i.payload->'chunk_data')='string' AND length(i.payload->>'chunk_data')>0
          THEN EXISTS (SELECT 1 FROM (SELECT substring(v.content_bytes
            FROM (i.payload->>'byte_offset')::int+1 FOR
              (length(rtrim(i.payload->>'chunk_data','='))::bigint*3/4)::int) AS bytes) part
            WHERE replace(encode(bytes,'base64'),chr(10),'')=i.payload->>'chunk_data'
              AND encode(sha256(bytes),'hex')=i.payload->>'chunk_hash')
          ELSE false END END)`

export const disposableFailedInbox = `i.status=3 AND i.materialized_event_id IS NULL
  AND i.claimed_by IS NULL AND i.claimed_at IS NULL
  AND ${nonAccountingDeadLetter} AND NOT (i.payload ? 'usage') AND NOT (${statisticsInput})
  AND (((i.last_error='unknown_daemon_session' OR (${exhausted})) AND ${deletedSession})
    OR ((${exhausted}) AND ${duplicateReplay}) OR (${savedDocument}) OR (${malformedDocument}))`
