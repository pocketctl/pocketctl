import {SHARED_GRANT_FUNCTIONS} from '../migrations/shared-db/grant-contract.js'
import {personalLifecycleAuthorityStampSql,personalLifecycleAuthorityStateSql,personalLifecycleDeliveryStampSql} from '../sources/current-grant.js'

const relayStamp=personalLifecycleAuthorityStampSql('current.state')
const currentReceiptStampSql=`SELECT ${relayStamp},
 ${personalLifecycleDeliveryStampSql('NEW.installation_id',relayStamp)} INTO stamp,delivery_stamp
 FROM shared.memory_current_grant_states(ARRAY[NEW.installation_id],ARRAY[]::uuid[]) current
 WHERE ${personalLifecycleAuthorityStateSql('current.state')}
  AND EXISTS(SELECT 1 FROM memory_installations i WHERE i.installation_id=NEW.installation_id AND i.local_status='ready');`

const recordDeliveryUsageSql=(occurredAt:string)=>`INSERT INTO memory_claim_usage(installation_id,claim_id,signal_key,signal,occurred_at)
 SELECT NEW.installation_id,i.claim_id,NEW.injection_id::text||':'||i.item_id::text,'delivered',${occurredAt}
 FROM memory_context_pack_items i WHERE i.installation_id=NEW.installation_id AND i.pack_id=NEW.pack_id AND i.claim_id IS NOT NULL
 ON CONFLICT DO NOTHING;`

const deliveryUsageDefinition=`CREATE OR REPLACE FUNCTION memory_record_delivery_usage()
 RETURNS trigger LANGUAGE plpgsql SET search_path=%s AS $context_usage$
 BEGIN
  IF NEW.state<>'delivered' OR OLD.state IS NOT DISTINCT FROM 'delivered' THEN RETURN NULL;END IF;
  -- Personal shared delivery usage is projected by the authority-bound
  -- receipt trigger. Other current shared owners retain their usage path.
  IF TG_TABLE_SCHEMA='memory' THEN
   IF NOT EXISTS(SELECT 1 FROM shared.memory_current_grant_states(ARRAY[NEW.installation_id],ARRAY[]::uuid[]) current
    WHERE current.state->>'owner_scope_kind' IN('team','organization')) THEN RETURN NULL;END IF;
  END IF;
  ${recordDeliveryUsageSql('COALESCE(NEW.delivered_at,clock_timestamp())')}
  RETURN NULL;
 END $context_usage$`

const usageClockDefinition=`CREATE OR REPLACE FUNCTION memory_update_usage_clock()
 RETURNS trigger LANGUAGE plpgsql SET search_path=%s AS $context_usage_clock$
 BEGIN
  IF NEW.signal='delivered' THEN
   UPDATE memory_claim_lifecycle SET last_delivered_at=NEW.occurred_at
   WHERE installation_id=NEW.installation_id AND claim_id=NEW.claim_id
    AND (last_delivered_at IS NULL OR last_delivered_at<NEW.occurred_at);
  ELSIF NEW.signal IN('user_confirmed','outcome_verified') THEN
   UPDATE memory_claim_lifecycle SET last_confirmed_use_at=NEW.occurred_at
   WHERE installation_id=NEW.installation_id AND claim_id=NEW.claim_id
    AND (last_confirmed_use_at IS NULL OR last_confirmed_use_at<NEW.occurred_at);
  END IF;
  RETURN NULL;
 END $context_usage_clock$`

export const NATIVE_RECEIPT_OBSERVATION_DEFINITION=`CREATE OR REPLACE FUNCTION memory_context_observation_outcome()
 RETURNS trigger LANGUAGE plpgsql SET search_path=%s AS $context_observation$
 DECLARE stamp TEXT; delivery_stamp TEXT; delivery_time TIMESTAMPTZ; prior memory_lifecycle_observation_windows%%ROWTYPE; next_hash TEXT:=''; qualifies BOOLEAN; needs_reset BOOLEAN;
 BEGIN
  IF TG_TABLE_NAME='memory_context_injections' THEN
   IF TG_OP='UPDATE' AND OLD.state=NEW.state THEN RETURN NULL;END IF;
   IF TG_TABLE_SCHEMA='memory' AND NEW.state IN('delivered','delivery_failed') THEN
    -- Acknowledgements remain historical facts. Only the original physical
    -- text read under the still-current authority can extend observation.
    -- A real daemon receipt uses the same Context grant, capped at 300 s.
    IF TG_OP<>'UPDATE' OR OLD.state<>'prepared' OR NEW.native_delivery_authority_sha256 IS NULL
     OR NEW.native_delivery_prepared_at IS NULL OR NEW.native_delivery_prepared_at>clock_timestamp()
     OR NEW.native_delivery_prepared_at<clock_timestamp()-interval '5 minutes' THEN RETURN NULL;END IF;
    ${currentReceiptStampSql}
    IF delivery_stamp IS DISTINCT FROM NEW.native_delivery_authority_sha256 THEN RETURN NULL;END IF;
    IF NOT shared.lock_memory_grant_authority(ARRAY[NEW.installation_id],ARRAY[]::uuid[]) THEN
     RAISE EXCEPTION 'context_receipt_authority_busy' USING ERRCODE='55P03';
    END IF;
    -- Keep settings and policy stable through the coverage write. The
    -- installation lock also fences new setting rows through their FK.
    -- This trigger already owns the injection row, so never wait here.
    PERFORM 1 FROM memory_installations i WHERE i.installation_id=NEW.installation_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RETURN NULL;END IF;
    PERFORM 1 FROM memory_curation_policies p WHERE p.installation_id=NEW.installation_id FOR SHARE NOWAIT;
    PERFORM 1 FROM memory_context_settings s WHERE s.installation_id=NEW.installation_id ORDER BY s.setting_id FOR SHARE NOWAIT;
    SELECT * INTO prior FROM memory_lifecycle_observation_windows WHERE installation_id=NEW.installation_id FOR UPDATE NOWAIT;
    IF prior.last_limitation_at>NEW.native_delivery_prepared_at THEN RETURN NULL;END IF;
    ${currentReceiptStampSql}
    IF delivery_stamp IS DISTINCT FROM NEW.native_delivery_authority_sha256 THEN RETURN NULL;END IF;
   END IF;
   qualifies:=NEW.state='delivered' AND NEW.delivered_at IS NOT NULL AND NEW.adapter IN('codex-app-server','opencode-server','claude-print-resume') AND EXISTS(
    SELECT 1 FROM memory_context_packs p JOIN memory_curation_policies policy ON policy.installation_id=p.installation_id
    LEFT JOIN memory_retrieval_trajectories t ON t.trajectory_id=p.trajectory_id
    WHERE p.installation_id=NEW.installation_id AND p.pack_id=NEW.pack_id AND p.mode='enabled' AND p.state='ready' AND p.error_code IS NULL
     AND policy.consume_mode='enabled' AND(t.trajectory_id IS NULL OR(t.result_state IN('completed','empty') AND cardinality(t.degraded_components)=0)));
   IF qualifies THEN
    delivery_time:=NEW.delivered_at;
    IF TG_TABLE_SCHEMA<>'memory' THEN
     SELECT * INTO prior FROM memory_lifecycle_observation_windows WHERE installation_id=NEW.installation_id FOR UPDATE;
    END IF;
    IF stamp IS NOT NULL THEN
     next_hash:=CASE WHEN starts_with(prior.settings_hash,stamp||':') THEN prior.settings_hash ELSE stamp||':' END;
    END IF;
    needs_reset:=prior.installation_id IS NOT NULL AND (prior.last_native_delivery_at IS NULL
      OR prior.last_native_delivery_at<delivery_time-interval '24 hours'
      OR (prior.last_heartbeat_at IS NOT NULL AND prior.last_heartbeat_at<delivery_time-(prior.max_gap_ms*interval '1 millisecond'))
      OR (stamp IS NOT NULL AND NOT starts_with(prior.settings_hash,stamp||':')));
   ELSE
    needs_reset:=NEW.state IN('delivered','skipped','delivery_failed','expired');
   END IF;
   IF stamp IS NOT NULL AND (needs_reset OR NEW.state='delivered') THEN
    -- Invalidation and the usage clock both write lifecycle rows. Take only
    -- the relevant row locks without waiting while holding the installation.
    PERFORM 1 FROM memory_claim_lifecycle l WHERE l.installation_id=NEW.installation_id AND (
      needs_reset AND (l.observation_state<>'unknown' OR l.observation_started_at IS NOT NULL)
      OR NEW.state='delivered' AND EXISTS(SELECT 1 FROM memory_context_pack_items i
        WHERE i.installation_id=l.installation_id AND i.pack_id=NEW.pack_id AND i.claim_id=l.claim_id))
     ORDER BY l.claim_id FOR UPDATE NOWAIT;
   END IF;
   IF needs_reset THEN PERFORM memory_invalidate_lifecycle_observation(NEW.installation_id);END IF;
   IF stamp IS NOT NULL AND NEW.state='delivered' THEN
    ${recordDeliveryUsageSql('NEW.delivered_at')}
   END IF;
   IF qualifies THEN
    INSERT INTO memory_lifecycle_observation_windows(installation_id,state,settings_hash,capability_since_at,last_native_delivery_at)
    VALUES(NEW.installation_id,'unknown',next_hash,clock_timestamp(),delivery_time)
    ON CONFLICT(installation_id) DO UPDATE SET
     settings_hash=CASE WHEN stamp IS NULL THEN memory_lifecycle_observation_windows.settings_hash ELSE EXCLUDED.settings_hash END,
     capability_since_at=COALESCE(memory_lifecycle_observation_windows.capability_since_at,EXCLUDED.capability_since_at),
     last_native_delivery_at=GREATEST(memory_lifecycle_observation_windows.last_native_delivery_at,EXCLUDED.last_native_delivery_at);
   END IF;
  ELSIF TG_TABLE_NAME='memory_context_packs' THEN
   IF NEW.mode='shadow' OR NEW.state IN('shadow','failed') OR NEW.error_code IS NOT NULL THEN PERFORM memory_invalidate_lifecycle_observation(NEW.installation_id);END IF;
  ELSIF NEW.result_state IN('degraded','retrieval_failed') OR cardinality(NEW.degraded_components)>0 THEN
   PERFORM memory_invalidate_lifecycle_observation(NEW.installation_id);
  END IF;RETURN NULL;END $context_observation$`

export const CONTEXT_NATIVE_RECEIPT_MIGRATION={version:103,statements:[
 `ALTER TABLE memory_context_injections ADD COLUMN native_delivery_authority_sha256 TEXT
  CHECK(native_delivery_authority_sha256 IS NULL OR native_delivery_authority_sha256~'^[a-f0-9]{64}$'),
  ADD COLUMN native_delivery_prepared_at TIMESTAMPTZ,
  ADD CONSTRAINT memory_context_native_handoff_pair CHECK(
   (native_delivery_authority_sha256 IS NULL)=(native_delivery_prepared_at IS NULL))`,
 `DO $context_receipt_migration$
 DECLARE function_path text:=CASE WHEN current_schema()='memory' THEN 'pg_catalog, memory, shared' ELSE 'pg_catalog, public' END;
 BEGIN
  IF current_schema()='memory' AND to_regprocedure('shared.memory_current_grant_states(uuid[],uuid[])') IS NOT NULL THEN
   EXECUTE $receipt_grants$${SHARED_GRANT_FUNCTIONS[0]}$receipt_grants$;
  END IF;
  EXECUTE format($receipt_clock$${usageClockDefinition}$receipt_clock$,function_path);
  EXECUTE format($receipt_usage$${deliveryUsageDefinition}$receipt_usage$,function_path);
  EXECUTE format($receipt_observation$${NATIVE_RECEIPT_OBSERVATION_DEFINITION}$receipt_observation$,function_path);
 END $context_receipt_migration$`,
]}
