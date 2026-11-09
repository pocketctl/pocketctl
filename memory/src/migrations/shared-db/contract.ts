import {SHARED_SESSION_CONSUMER_FUNCTIONS} from './session-consumer-contract.js'
import {SHARED_SESSION_TRANSPORT_RETIREMENT_FUNCTIONS} from './session-transport-contract.js'
import {SHARED_NATIVE_WITHDRAWAL_FUNCTIONS} from './withdrawal-contract.js'
import {SHARED_NATIVE_INVENTORY_FUNCTIONS} from './inventory-contract.js'
import {assertTeamSemanticLegacySchema} from '../../sources/team-semantic-migration.js'
import {SHARED_TEAM_SEMANTIC_FUNCTIONS,assertTeamSemanticLegacyFunction} from './team-semantic-contract.js'
import {SHARED_INPUT_START_FUNCTIONS,assertNativeInputStartCompatible} from './input-start-contract.js'
import {SHARED_SOURCE_PROCESSING_PIN_FUNCTIONS} from './processing-pin-contract.js'
import {SHARED_SOURCE_PROJECTION_COMPLETION_FUNCTIONS} from './projection-completion-contract.js'
import {SHARED_DELIVERY_FENCE_FUNCTIONS} from './delivery-fence-contract.js'
import {sharedSourceTargetFunctions,assertPersonalRelayTargetProfile,normalizeTargetInstallations,type SharedSourceTargetProfile} from './target-contract.js'
import {SHARED_SOURCE_DISTRIBUTION_FUNCTIONS} from './distribution-contract.js'
import {SHARED_SOURCE_BOOTSTRAP_FUNCTIONS} from './bootstrap-contract.js'
import {SHARED_SOURCE_SHADOW_FUNCTIONS} from './shadow-contract.js'
import {SHARED_SOURCE_CONTROL_FUNCTIONS} from './control-contract.js'
import {SHARED_SOURCE_COMMIT_FENCE_FUNCTIONS} from './commit-fence-contract.js'
import {SHARED_LOCAL_RIGHTS_FUNCTIONS} from './local-rights-contract.js'
import {SHARED_LEGACY_ARCHIVE_FUNCTIONS} from './legacy-archive-contract.js'
import {SHARED_SOURCE_HEALTH_FUNCTIONS} from './health-contract.js'
import {SHARED_GRANT_FUNCTIONS} from './grant-contract.js'
import {SHARED_SOURCE_REF_FUNCTIONS} from './ref-context-contract.js'
import {SHARED_SOURCE_READER_FUNCTIONS} from './reader-contract.js'
import {SHARED_TEAM_READER_FUNCTIONS} from './team-reader-contract.js'
import {SHARED_SOURCE_MODE_FUNCTIONS} from './mode-contract.js'
import {SHARED_SOURCE_EXECUTION_FUNCTIONS} from './execution-contract.js'
import {SHARED_SOURCE_WORK_FUNCTIONS} from './work-contract.js'
import type pg from 'pg'
export const SHARED_SOURCE_CONTRACT_VERSION=1
const statements=[
 `CREATE TABLE IF NOT EXISTS shared.memory_source_contract(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),version INTEGER NOT NULL,
   installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
 `INSERT INTO shared.memory_source_contract(singleton,version) VALUES(TRUE,1) ON CONFLICT(singleton) DO NOTHING`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS legacy_transport_retired BOOLEAN NOT NULL DEFAULT FALSE`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS consumer_version INT NOT NULL DEFAULT 0`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS commit_fence_version INT NOT NULL DEFAULT 0`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS execution_version INT NOT NULL DEFAULT 0`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS target_profile TEXT NOT NULL DEFAULT 'full' CHECK(target_profile IN('full','personal-relay-only'))`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS target_installations UUID[]`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_session_barriers(
   owner_user_id INT NOT NULL CHECK(owner_user_id>0),session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 512),
   canonical_session_id TEXT,reason TEXT NOT NULL CHECK(reason IN('renamed','owner_changed','removed')),
   revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_user_id,session_id))`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_work(
   source_kind TEXT NOT NULL CHECK(source_kind IN('relay_event','team_collaboration','team_delivery','legacy_archive')),
   root_key TEXT NOT NULL CHECK(length(root_key) BETWEEN 1 AND 1024),revision BIGINT NOT NULL CHECK(revision>0),
   processed_revision BIGINT NOT NULL DEFAULT 0 CHECK(processed_revision>=0 AND processed_revision<=revision),
   lease_owner TEXT,lease_token UUID,lease_until TIMESTAMPTZ,claimed_revision BIGINT,
   available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 32),
   last_error_code TEXT CHECK(last_error_code ~ '^[a-z][a-z0-9_]{0,95}$'),dead_at TIMESTAMPTZ,
   updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(source_kind,root_key),
   CHECK((lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL AND claimed_revision IS NULL)
     OR (lease_token IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 128 AND lease_until IS NOT NULL AND claimed_revision BETWEEN 1 AND revision)))`,
 `CREATE INDEX IF NOT EXISTS memory_source_work_claim ON shared.memory_source_work(available_at,updated_at,source_kind,root_key)
   WHERE dead_at IS NULL AND processed_revision<revision`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_modes(
   installation_id UUID PRIMARY KEY,mode TEXT NOT NULL DEFAULT 'legacy-feed' CHECK(mode IN('legacy-feed','shared-shadow','shared-active','paused')),
   generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_progress(
   installation_id UUID NOT NULL,source_kind TEXT NOT NULL,root_key TEXT NOT NULL,mode_generation BIGINT NOT NULL CHECK(mode_generation>0),
   binding_revision BIGINT NOT NULL CHECK(binding_revision>0),authorization_revision BIGINT NOT NULL CHECK(authorization_revision>0),
   dispatched_revision BIGINT NOT NULL DEFAULT 0 CHECK(dispatched_revision>=0),processed_revision BIGINT NOT NULL DEFAULT 0 CHECK(processed_revision>=0 AND processed_revision<=dispatched_revision),
   bootstrap_state TEXT NOT NULL DEFAULT 'pending' CHECK(bootstrap_state IN('pending','scanning','ready','blocked')),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(installation_id,source_kind,root_key),
   FOREIGN KEY(source_kind,root_key) REFERENCES shared.memory_source_work(source_kind,root_key))`,
 `CREATE INDEX IF NOT EXISTS memory_source_progress_pending ON shared.memory_source_progress(installation_id,mode_generation,updated_at)
   WHERE bootstrap_state<>'ready' OR processed_revision<dispatched_revision`,
]
/** Additive migrator entry only; no Relay event or application-mode mutation. */
export async function applySharedSourceContract(pool:pg.Pool,options:{targetProfile?:SharedSourceTargetProfile;preservedInstallations?:readonly string[];fencedMemoryRuntimeRole?:string}={}):Promise<void>{
 if(options.targetProfile!==undefined&&!['full','personal-relay-only'].includes(options.targetProfile))throw Error('unsupported_shared_source_target_profile')
 const c=await pool.connect()
 try{
  await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-source-contract-v1',0))")
  await assertNativeInputStartCompatible(c as unknown as Pick<pg.Pool,'query'>)
  await assertTeamSemanticLegacySchema(c);await assertTeamSemanticLegacyFunction(c,options.fencedMemoryRuntimeRole)
  await c.query('CREATE SCHEMA IF NOT EXISTS shared')
  await c.query(statements[0])
  const versions=(await c.query("SELECT version,COALESCE(to_jsonb(contract)->>'input_start_version','0') AS input_start_version,COALESCE(to_jsonb(contract)->>'consumer_version','0') AS consumer_version,COALESCE(to_jsonb(contract)->>'commit_fence_version','0') AS commit_fence_version,COALESCE(to_jsonb(contract)->>'execution_version','0') AS execution_version,COALESCE(to_jsonb(contract)->>'control_version','0') AS control_version,COALESCE(to_jsonb(contract)->>'distribution_version','0') AS distribution_version,COALESCE(to_jsonb(contract)->>'shadow_version','0') AS shadow_version,COALESCE(to_jsonb(contract)->>'processing_pin_version','0') AS processing_pin_version,COALESCE(to_jsonb(contract)->>'mode_version','0') AS mode_version,COALESCE(to_jsonb(contract)->>'delivery_source_set_capture_version','0') AS delivery_source_set_capture_version FROM shared.memory_source_contract contract")).rows
  if(versions.some(r=>!['0','1'].includes(r.input_start_version)))throw new Error('unsupported_shared_input_start_contract')
  if(versions.some(r=>r.version!==SHARED_SOURCE_CONTRACT_VERSION))throw new Error('unsupported_shared_source_contract')
  if(versions.some(r=>!['0','1'].includes(r.consumer_version)))throw new Error('unsupported_shared_consumer_contract')
  if(versions.some(r=>!['0','1'].includes(r.commit_fence_version)))throw new Error('unsupported_shared_commit_fence_contract')
  if(versions.some(r=>!['0','1'].includes(r.execution_version)))throw new Error('unsupported_shared_execution_contract')
  if(versions.some(r=>!['0','1'].includes(r.control_version)))throw new Error('unsupported_shared_control_contract')
  if(versions.some(r=>!['0','1'].includes(r.distribution_version)))throw new Error('unsupported_shared_distribution_contract')
  if(versions.some(r=>!['0','1'].includes(r.shadow_version)))throw new Error('unsupported_shared_shadow_contract')
  if(versions.some(r=>!['0','1'].includes(r.processing_pin_version)))throw new Error('unsupported_shared_processing_pin_contract')
  if(versions.some(r=>!['0','1'].includes(r.mode_version)))throw new Error('unsupported_shared_mode_contract')
  if(versions.some(r=>!['0','1'].includes(r.delivery_source_set_capture_version)))throw new Error('unsupported_delivery_source_set_capture_contract')
  const profileRows=(await c.query("SELECT COALESCE(to_jsonb(c)->>'target_profile','full') AS profile,to_jsonb(c)->'target_installations' AS installations FROM shared.memory_source_contract c")).rows
  const installedProfile=profileRows[0]?.profile??'full'
  if(!['full','personal-relay-only'].includes(installedProfile))throw Error('unsupported_shared_source_target_profile')
  const installedIds=profileRows[0]?.installations
  if(installedProfile==='personal-relay-only')await assertPersonalRelayTargetProfile(c,installedIds)
  const targetProfile=options.targetProfile??installedProfile
  const targetIds=targetProfile==='personal-relay-only'?normalizeTargetInstallations(options.preservedInstallations??installedIds):null
  if((targetProfile!==installedProfile||JSON.stringify(targetIds)!==JSON.stringify(installedIds??null))&&(await c.query("SELECT to_regclass('shared.memory_source_modes') IS NOT NULL AS present")).rows[0].present
   &&(await c.query("SELECT 1 FROM shared.memory_source_modes WHERE mode IN('shared-active','shared-shadow') LIMIT 1")).rowCount)
   throw Error('shared_source_profile_change_requires_drain')
  for(const sql of [...statements.slice(1),...SHARED_SOURCE_CONTROL_FUNCTIONS,...SHARED_NATIVE_WITHDRAWAL_FUNCTIONS,...SHARED_NATIVE_INVENTORY_FUNCTIONS,...SHARED_SOURCE_WORK_FUNCTIONS,...SHARED_SOURCE_EXECUTION_FUNCTIONS,...SHARED_SOURCE_MODE_FUNCTIONS,...SHARED_LOCAL_RIGHTS_FUNCTIONS,...SHARED_INPUT_START_FUNCTIONS,...SHARED_SOURCE_READER_FUNCTIONS,...SHARED_LEGACY_ARCHIVE_FUNCTIONS,...SHARED_TEAM_READER_FUNCTIONS,...SHARED_SOURCE_REF_FUNCTIONS,...SHARED_GRANT_FUNCTIONS,...SHARED_SOURCE_HEALTH_FUNCTIONS,...SHARED_SOURCE_COMMIT_FENCE_FUNCTIONS,...SHARED_DELIVERY_FENCE_FUNCTIONS])await c.query(sql)
  for(const sql of sharedSourceTargetFunctions(targetProfile,targetIds??undefined))await c.query(sql)
  await c.query('UPDATE shared.memory_source_contract SET target_profile=$1,target_installations=$2::uuid[] WHERE singleton',[targetProfile,targetIds])
  for(const sql of SHARED_SOURCE_DISTRIBUTION_FUNCTIONS)await c.query(sql)
  for(const sql of SHARED_SOURCE_BOOTSTRAP_FUNCTIONS)await c.query(sql)
  for(const sql of SHARED_SOURCE_SHADOW_FUNCTIONS)await c.query(sql)
  for(const sql of SHARED_SOURCE_PROCESSING_PIN_FUNCTIONS)await c.query(sql)
  for(const sql of SHARED_SOURCE_PROJECTION_COMPLETION_FUNCTIONS)await c.query(sql)
  for(const sql of SHARED_TEAM_SEMANTIC_FUNCTIONS)await c.query(sql)
  for(const sql of SHARED_SESSION_TRANSPORT_RETIREMENT_FUNCTIONS)await c.query(sql)
  for(const sql of SHARED_SESSION_CONSUMER_FUNCTIONS)await c.query(sql)
  await c.query('UPDATE shared.memory_source_contract SET consumer_version=1,commit_fence_version=1,execution_version=1 WHERE singleton')
  await c.query('COMMIT')
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
