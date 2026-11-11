/** One body-free native observation used by the selected reader and physical
 * fence. Never add payload or whole-event JSON here. No database function or
 * persisted ledger is created; these are static, reviewed SQL expressions. */
export const metadataInputFingerprint=(scope='p_scope')=>`(SELECT encode(sha256(convert_to(jsonb_build_array('personal-input-v1',
 i.provider_id,i.owner_user_id,i.owner_scope_kind,i.owner_scope_id,i.start_policy,
 (SELECT to_jsonb(b) FROM public.native_installation_starts b WHERE b.installation_id=i.installation_id))::text,'UTF8')),'hex')
 FROM public.extension_installations i WHERE i.installation_id=(${scope}->>'installationId')::uuid)`
export const metadataUsageDenied=(e='e',r='r')=>`(${r}.body_reclaimed_at IS NOT NULL OR EXISTS(
 SELECT 1 FROM memory.memory_source_retention_receipts receipt WHERE receipt.installation_id=(p_scope->>'installationId')::uuid
 AND receipt.session_id=${e}.logical_source_session_id AND(receipt.turn_id=COALESCE(${r}.turn_id,${e}.source_classification->'memory_source'->>'turn_id')
 OR COALESCE(${r}.turn_id,${e}.source_classification->'memory_source'->>'turn_id') IS NULL)))`
/** Original native admission is evaluated once. Explicit retained entitlement
 * uses the same identity/provenance/hash/header/cold tuple facts as the ordinary
 * helper. Its hot headerless payload-equality branch has no body-free proof:
 * expose that limit, never skip the row or infer equality from a caller DTO. */
export const metadataInputAdmission=(e='e',r='r',explicit='TRUE',scope='p_scope')=>`(SELECT CASE
 WHEN boundary.state='eligible' THEN 'eligible' WHEN boundary.state='denied' THEN 'denied'
 WHEN ${explicit} AND ${r}.source_event_id IS NOT NULL AND ${r}.installation_id=(${scope}->>'installationId')::uuid
  AND ${r}.source_kind='relay_event' AND ${r}.mapping_state='verified' AND ${r}.canonical_key=${e}.id::text
  AND ${r}.canonical_session_key=${e}.logical_source_session_id AND ${r}.session_id=${e}.logical_source_session_id AND ${r}.event_type=${e}.event_type
  AND ${r}.hash_version='canonical-json-sha256-v1' AND ${r}.content_hash IS NOT NULL AND ${r}.source_provenance->'memory'->>'version'='1'
  AND ${r}.source_provenance->'memory'->>'session_id'=${e}.logical_source_session_id
  AND ${r}.classification->'memory_source'=${r}.source_provenance->'memory'
  AND (${e}.source_header_version IS DISTINCT FROM 1 OR ${e}.source_classification->'memory_source'=${r}.source_provenance->'memory') THEN
   CASE WHEN encode(${r}.content_hash,'hex')=${e}.canonical_payload_hash THEN 'eligible'
    WHEN ${e}.canonical_payload_hash IS NULL AND ${e}.body_storage='cold' AND ${e}.body_owner_user_id=${e}.user_id AND ${e}.body_session_id IS NOT NULL
     AND EXISTS(SELECT 1 FROM public.session_archive_manifests manifest JOIN public.session_archive_chunks chunk USING(manifest_id)
      WHERE manifest.manifest_id=${e}.body_manifest_id AND chunk.ordinal=${e}.body_chunk_ordinal AND manifest.state='published'
       AND manifest.user_id=${e}.user_id AND manifest.session_id=${e}.body_session_id AND manifest.activity_epoch=${e}.body_activity_epoch
       AND ${e}.id BETWEEN chunk.first_event_id AND chunk.last_event_id) THEN 'eligible'
    WHEN ${e}.canonical_payload_hash IS NULL AND ${e}.body_storage='hot' AND ${r}.content_hash=${r}.payload_hash THEN 'unsupported'
    ELSE CASE WHEN boundary.state='unproven' THEN 'unproven' ELSE 'denied' END END
 ELSE CASE WHEN boundary.state='unproven' THEN 'unproven' ELSE 'denied' END END
 FROM(WITH original AS MATERIALIZED(SELECT shared.memory_input_start_admission((${scope}->>'installationId')::uuid,'relay_event',${e}.id::text,${e}.user_id::text,${e}.logical_source_session_id) AS state)SELECT state FROM original)boundary)`
export const metadataNativeFingerprint=(e='e',rowVersion=`${e}.xmin::text`,native='native',input='input_fingerprint')=>`encode(sha256(convert_to(jsonb_build_array('personal-native-v2',
 ${e}.id::text,${rowVersion},${e}.source_body_change_revision::text,${e}.user_id::text,${e}.session_id,${e}.logical_source_session_id,
 ${e}.owner_retired,${e}.event_type,${e}.created_at::text,${e}.effect_status,${e}.source_header_version,${e}.source_sequence::text,
 ${e}.canonical_payload_hash,${e}.source_classification,${e}.body_storage,${e}.body_session_id,${e}.body_manifest_id,${e}.body_chunk_ordinal,
 ${e}.body_activity_epoch::text,${e}.body_owner_user_id::text,${native},public.native_event_authority(${e}.id,${e}.user_id),${input},
 (SELECT to_jsonb(publication) FROM public.native_source_publications publication WHERE publication.source_kind='relay_event' AND publication.source_key=${e}.id::text),
 -- A complete immutable publication is the native input boundary. Delivery
 -- journal GC cannot change that boundary. Historical/incomplete publications
 -- retain the original journal witness; no missing facts are inferred.
 (CASE WHEN EXISTS(SELECT 1 FROM public.native_source_publications durable_publication
   WHERE durable_publication.source_kind='relay_event' AND durable_publication.source_key=${e}.id::text
    AND NOT durable_publication.retired AND durable_publication.owner_key=${e}.user_id::text
    AND durable_publication.source_session_id=${e}.logical_source_session_id
    AND durable_publication.publication_xid>0 AND durable_publication.publication_order>0)
  THEN NULL::jsonb ELSE(SELECT jsonb_agg(j.source_seq::text ORDER BY j.source_seq) FROM public.extension_source_outbox j WHERE j.source_kind='canonical_event'
   AND j.source_id='event:'||${e}.id::text AND j.owner_user_id=${e}.user_id AND j.session_id=${e}.logical_source_session_id AND j.event_type=${e}.event_type)END)
 )::text,'UTF8')),'hex')`
export const metadataRefObservation=(r='r')=>`CASE WHEN ${r}.source_event_id IS NULL THEN NULL ELSE jsonb_build_object(
 'id',${r}.source_event_id::text,'rowVersion',${r}.xmin::text,'fingerprint',encode(sha256(convert_to(jsonb_build_array('personal-ref-v1',
 ${r}.source_event_id::text,${r}.installation_id::text,${r}.origin,${r}.origin_position,${r}.session_id,${r}.turn_id,${r}.event_type,
 ${r}.occurred_at::text,${r}.classification,${r}.source_provenance,${r}.body_reclaimed_at::text,${r}.source_kind,${r}.canonical_key,
 ${r}.canonical_session_key,${r}.source_version,${r}.source_sequence::text,encode(${r}.content_hash,'hex'),encode(${r}.payload_hash,'hex'),
 ${r}.mapping_state,${r}.hash_version,${r}.adapter_version,${r}.canonical_projected_at::text)::text,'UTF8')),'hex')) END`
export const metadataRowLocator=(e='e',r='r',rowVersion=`${e}.xmin::text`,native='native',input='input_fingerprint')=>`jsonb_build_object(
 'id',${e}.id::text,'rowVersion',${rowVersion},'bodyChangeRevision',${e}.source_body_change_revision::text,
 'contentHash',COALESCE(${e}.canonical_payload_hash,encode(${r}.content_hash,'hex')),
 'nativeFingerprint',${metadataNativeFingerprint(e,rowVersion,native,input)},'ref',${metadataRefObservation(r)})`
