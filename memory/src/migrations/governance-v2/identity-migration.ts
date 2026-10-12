import {GOVERNANCE_BRIDGE_MIGRATION} from './bridge-migration.js'
const bridgeFence=GOVERNANCE_BRIDGE_MIGRATION.statements.find(s=>s.includes('CREATE FUNCTION memory_governance_fence_writer()'))!.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
const capture=GOVERNANCE_BRIDGE_MIGRATION.statements.find(s=>s.includes('CREATE FUNCTION memory_governance_capture_change()'))!
/** Stage only. The global v1 index and all control generations stay unchanged;
 * Task26 alone validates/backfills and removes the legacy index at cutover. */
export const GOVERNANCE_IDENTITY_MIGRATION={version:54,statements:[
 capture.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION').replace("capability<>'bridge_v2'","capability NOT IN('bridge_v2','identity_v2')"),
 `ALTER TABLE knowledge_claims ADD COLUMN topic_key_v2 TEXT, ADD COLUMN duplicate_digest_v2 TEXT,
  ADD CONSTRAINT knowledge_claims_topic_v2_format CHECK(topic_key_v2 IS NULL OR topic_key_v2 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT knowledge_claims_duplicate_v2_format CHECK(duplicate_digest_v2 IS NULL OR duplicate_digest_v2 ~ '^[a-f0-9]{64}$')`,
 `CREATE UNIQUE INDEX knowledge_claims_active_identity_v1_idx ON knowledge_claims(installation_id,claim_type,scope_key,normalized_key,conflict_variant)
  WHERE state='active' AND identity_generation=1`,
 `CREATE UNIQUE INDEX knowledge_claims_active_identity_v2_idx ON knowledge_claims(installation_id,duplicate_digest_v2,conflict_variant)
  WHERE state='active' AND identity_generation=2`,
 `CREATE INDEX knowledge_claims_active_topic_v2_idx ON knowledge_claims(installation_id,topic_key_v2) WHERE state='active'`,
 bridgeFence.replace("control.writer_floor NOT IN('v1','bridge_v2') OR ((control.writer_floor='bridge_v2' OR control.phase IN('backfill','validate','active')) AND capability<>'bridge_v2')",
  "control.writer_floor NOT IN('v1','bridge_v2','identity_v2') OR (control.writer_floor='identity_v2' AND capability<>'identity_v2') OR ((control.writer_floor='bridge_v2' OR control.phase IN('backfill','validate','active')) AND capability NOT IN('bridge_v2','identity_v2'))")
 .replace("writer_generation<>'1' OR writer_generation<>control.identity_generation::text",
  "NOT ((writer_generation='1' AND control.identity_generation=1) OR (writer_generation='adaptive' AND capability='identity_v2' AND control.identity_generation IN(1,2))) OR (control.identity_generation=2 AND capability<>'identity_v2')")
 .replace('     END LOOP;',`       IF control.identity_generation=2 AND TG_TABLE_NAME='knowledge_claims' AND new_record->>'state'='active' AND new_record->>'consumption_hold_reason' IS NULL AND
          (new_record->>'identity_generation'<>'2' OR new_record->>'normalized_key_v2' IS NULL OR new_record->>'topic_key_v2' IS NULL OR new_record->>'duplicate_digest_v2' IS NULL) THEN
         RAISE EXCEPTION 'memory_writer_incompatible:identity_projection' USING ERRCODE='55000';
       END IF;
     END LOOP;`),
 ]} as const
