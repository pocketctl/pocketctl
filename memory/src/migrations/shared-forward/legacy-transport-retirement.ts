import type pg from 'pg'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {assertInboxRetirementScope,assertRetirementIdleConnection,type InboxRetirementInput} from './inbox-payload-retirement.js'
import {assertTargetMemoryWritersFenced} from './source-maintenance-capabilities.js'
import {assertPersonalRelayTargetProfile} from '../shared-db/target-contract.js'
import {qi} from './source-maintenance-common.js'
import {assertTransportMetadataContract} from '../../sources/transport-state.js'
import {DELIVERY_FACT_COLUMNS,DELIVERY_FACT_REQUIRED,SNAPSHOT_FACT_COLUMNS,SNAPSHOT_FACT_REQUIRED} from '../../sources/transport-metadata-migration.js'
export interface LegacyTransportRetirementInput extends Omit<InboxRetirementInput,'feedIds'> {
 migratorRole:string;preservedInstallationIds:readonly string[];expected:{deliveryRows:string;minFeedId:string;maxFeedId:string;lastAckFeedId:string}
 bodyProofManifestHash:string;sourceCommit:string
}
const topics=['session.event.v1','session.lifecycle.v1','turn.lifecycle.v1','session.deleted.v1','session.access.revoked.v1']
/** Explicit, target-only operator. This never proves/clears a raw body: every
 * body must already have passed the independent per-page retirement protocol.
 * Content-free facts retain delivery identity and normal privacy semantics. */
export async function retireLegacyTransport(db:pg.Client,value:LegacyTransportRetirementInput,options:{transactionTimeoutMs?:number;signal?:AbortSignal}={}){
 assertRetirementIdleConnection(db)
 const input=structuredClone(value),scope={...input,feedIds:[]} satisfies InboxRetirementInput
 if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.installationId)
  ||![input.modeGeneration,input.configVersion,input.principalUserId,input.expectedDatabase?.oid,input.expectedDatabase?.systemIdentifier,...Object.values(input.expected??{})].every(x=>typeof x==='string'&&/^[1-9][0-9]*$/.test(x))
  ||Object.keys(input.expected??{}).sort().join(',')!=='deliveryRows,lastAckFeedId,maxFeedId,minFeedId'
  ||![input.runtimeRole,input.migratorRole].every(x=>typeof x==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(x))||input.runtimeRole===input.migratorRole
  ||!Array.isArray(input.preservedInstallationIds)||!input.preservedInstallationIds.includes(input.installationId)||input.preservedInstallationIds.length>16||new Set(input.preservedInstallationIds).size!==input.preservedInstallationIds.length||input.preservedInstallationIds.some(x=>!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x))
  ||!/^[a-f0-9]{64}$/.test(input.bodyProofManifestHash)||!/^[a-f0-9]{40}$/.test(input.sourceCommit))throw Error('legacy_transport_retirement_input_invalid')
 const timeoutMs=options.transactionTimeoutMs??10000
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('legacy_transport_retirement_window_invalid')
 if(options.signal?.aborted)throw Error('legacy_transport_retirement_aborted')
 let expired=false,aborted=false
 const cancel=()=>{aborted=true;void db.end().catch(()=>{})},timer=setTimeout(()=>{expired=true;void db.end().catch(()=>{})},timeoutMs)
 options.signal?.addEventListener('abort',cancel,{once:true})
 try{
  await db.query("BEGIN;SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await assertInboxRetirementScope(db,scope,true)
  // SHARE table locks fence insert/config/mode phantoms as well as existing
  // consumers. A global marker must never silently disable an unseen peer.
  await db.query('LOCK TABLE public.extension_installations,shared.memory_source_modes,memory.memory_installations,memory.memory_native_control_observations IN SHARE MODE NOWAIT')
  const consumers=(await db.query(`SELECT i.installation_id::text,i.owner_scope_kind,i.subscriptions,m.mode,
   local.local_status,local.relay_status,observed.installation_id IS NOT NULL AS native_observed
   FROM public.extension_installations i LEFT JOIN shared.memory_source_modes m USING(installation_id)
   LEFT JOIN memory.memory_installations local USING(installation_id)
   LEFT JOIN memory.memory_native_control_observations observed USING(installation_id)
   WHERE i.provider_id='pocketctl-memory' ORDER BY i.installation_id`)).rows
  const allowed=[...input.preservedInstallationIds].sort(),controlTopics=['scope.lifecycle.v2','scope.membership.v2','scope.installation.v2']
  const localIds=(await db.query('SELECT installation_id::text FROM memory.memory_installations ORDER BY installation_id')).rows.map(r=>r.installation_id)
  if(JSON.stringify(consumers.map(r=>r.installation_id))!==JSON.stringify(allowed)||JSON.stringify(localIds)!==JSON.stringify(allowed)
   ||consumers.some(r=>r.local_status!=='ready'||r.relay_status!=='active'||(r.installation_id===input.installationId?r.subscriptions.length!==0:
    r.owner_scope_kind!=='organization'||!r.native_observed||r.mode!==null&&r.mode!=='legacy-feed'||r.subscriptions.some((t:string)=>!controlTopics.includes(t)))))throw Error('legacy_transport_global_consumer_scope_changed')
  await assertPersonalRelayTargetProfile(db,input.preservedInstallationIds)
  const owner=(await db.query(`SELECT r.oid,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   (SELECT relowner FROM pg_class WHERE oid='memory.memory_schema_migrations'::regclass)=r.oid AS schema_owner
   FROM pg_roles r WHERE r.rolname=$1`,[input.migratorRole])).rows[0]
  if(!owner?.schema_owner||owner.rolcanlogin||owner.rolsuper||owner.rolcreatedb||owner.rolcreaterole||owner.rolreplication||owner.rolbypassrls)throw Error('legacy_transport_retirement_owner_invalid')
  const retirement=(await db.query(`SELECT r.mode_generation::text,r.retired_config_version::text,i.subscriptions
   FROM shared.memory_session_transport_retirements r JOIN public.extension_installations i USING(installation_id)
   WHERE r.installation_id=$1 FOR SHARE OF r NOWAIT`,[input.installationId])).rows[0]
  if(!retirement||retirement.mode_generation!==input.modeGeneration||BigInt(retirement.retired_config_version)>BigInt(input.configVersion)
   ||retirement.subscriptions.some((t:string)=>topics.includes(t)))throw Error('legacy_transport_input_not_retired')
  await db.query('LOCK TABLE memory.memory_feed_inbox,memory.memory_snapshot_events,memory.memory_snapshot_runs,memory.memory_inbox_checkpoints IN ACCESS EXCLUSIVE MODE NOWAIT')
  await assertTransportMetadataContract(db)
  if((await db.query("SELECT to_regclass('memory.memory_source_delivery_receipts') IS NOT NULL OR to_regclass('memory.memory_source_snapshot_receipts') IS NOT NULL AS present")).rows[0].present)throw Error('legacy_transport_receipt_storage_exists')
  const stats=(await db.query(`SELECT count(*)::text AS rows,min(feed_id)::text AS min,max(feed_id)::text AS max,
   count(*) FILTER(WHERE installation_id<>$1 OR projection_state<>'projected' OR error_code IS NOT NULL OR body_reclaimed_at IS NULL OR data<>'{}'::jsonb OR classification<>'{}'::jsonb)::text AS blocked
   FROM memory.memory_feed_inbox`,[input.installationId])).rows[0]
  if(stats.blocked!=='0')throw Error('legacy_transport_body_or_gap_remaining')
  const checkpoints=(await db.query('SELECT installation_id::text,last_ack_feed_id::text FROM memory.memory_inbox_checkpoints ORDER BY installation_id')).rows
  if(stats.rows!==input.expected.deliveryRows||stats.min!==input.expected.minFeedId||stats.max!==input.expected.maxFeedId||checkpoints.length!==1
   ||checkpoints[0].installation_id!==input.installationId||checkpoints[0].last_ack_feed_id!==input.expected.lastAckFeedId||BigInt(checkpoints[0].last_ack_feed_id)<BigInt(stats.max))throw Error('legacy_transport_frozen_set_changed')
  const snapshots=(await db.query('SELECT (SELECT count(*)::text FROM memory.memory_snapshot_events) AS events,(SELECT count(*)::text FROM memory.memory_snapshot_runs) AS runs')).rows[0]
  if(snapshots.events!=='0'||snapshots.runs!=='0')throw Error('legacy_transport_snapshot_storage_remaining')
  for(const [table,source,columns,required,pk] of [
   ['memory_source_delivery_receipts','memory_feed_inbox',DELIVERY_FACT_COLUMNS,DELIVERY_FACT_REQUIRED,'installation_id,feed_id'],
   ['memory_source_snapshot_receipts','memory_snapshot_runs',SNAPSHOT_FACT_COLUMNS,SNAPSHOT_FACT_REQUIRED,'run_id'],
  ] as const){
   await db.query(`CREATE TABLE memory.${table} AS SELECT ${columns} FROM memory.${source}`)
   await db.query(`ALTER TABLE memory.${table} ${required.map(c=>'ALTER COLUMN '+c+' SET NOT NULL').join(',')},ADD PRIMARY KEY(${pk}),ADD FOREIGN KEY(installation_id) REFERENCES memory.memory_installations(installation_id) ON DELETE CASCADE`)
   await db.query(`ALTER TABLE memory.${table} OWNER TO ${qi(input.migratorRole)};REVOKE ALL ON memory.${table} FROM PUBLIC;GRANT SELECT,UPDATE,DELETE ON memory.${table} TO ${qi(input.runtimeRole)}`)
  }
  await db.query('CREATE INDEX memory_source_delivery_receipts_session ON memory.memory_source_delivery_receipts(installation_id,session_id);CREATE INDEX memory_source_snapshot_receipts_installation ON memory.memory_source_snapshot_receipts(installation_id,generation)')
  await db.query(`CREATE OR REPLACE VIEW memory.memory_source_delivery_facts AS SELECT ${DELIVERY_FACT_COLUMNS} FROM memory.memory_source_delivery_receipts;
   CREATE OR REPLACE VIEW memory.memory_source_snapshot_facts AS SELECT ${SNAPSHOT_FACT_COLUMNS} FROM memory.memory_source_snapshot_receipts;
   ALTER VIEW memory.memory_source_delivery_facts OWNER TO ${qi(input.migratorRole)};ALTER VIEW memory.memory_source_snapshot_facts OWNER TO ${qi(input.migratorRole)};
   REVOKE ALL ON memory.memory_source_delivery_facts,memory.memory_source_snapshot_facts FROM PUBLIC;
   GRANT SELECT,UPDATE,DELETE ON memory.memory_source_delivery_facts,memory.memory_source_snapshot_facts TO ${qi(input.runtimeRole)}`)
  for(const name of ['memory_source_delivery_receipts','memory_source_snapshot_receipts','memory_source_delivery_facts','memory_source_snapshot_facts']){
   const relation='memory.'+name
   const grantees=(await db.query(`SELECT DISTINCT r.rolname FROM pg_roles r WHERE r.oid IN(
    SELECT acl.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl WHERE c.oid=to_regclass($1)
    UNION SELECT acl.grantee FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass($1))`,[relation])).rows.map(r=>r.rolname)
   const columns=(await db.query('SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum',[relation])).rows.map(r=>qi(r.attname)).join(',')
   for(const role of new Set(['PUBLIC',input.runtimeRole,...grantees])){
    const target=role==='PUBLIC'?'PUBLIC':qi(role)
    if(role!==input.migratorRole)await db.query(`REVOKE ALL ON TABLE memory.${name} FROM ${target}`)
    await db.query(`REVOKE ALL (${columns}) ON TABLE memory.${name} FROM ${target}`)
   }
   await db.query(`GRANT SELECT,UPDATE,DELETE ON memory.${name} TO ${qi(input.runtimeRole)}`)
   const unsafe=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
    WHERE c.oid=to_regclass($1) AND acl.grantee<>c.relowner AND(acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR acl.is_grantable OR acl.privilege_type NOT IN('SELECT','UPDATE','DELETE')))
    OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass($1)) AS unsafe`,[relation,input.runtimeRole])).rows[0].unsafe
   if(unsafe)throw Error('legacy_transport_receipt_acl_invalid')
  }
  const proofHash=canonicalPayloadHash({input,checkpoints,stats,snapshots}).toString('hex')
  await db.query('ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS legacy_transport_retirement JSONB')
  const marker=await db.query(`UPDATE shared.memory_source_contract SET legacy_transport_retired=TRUE,legacy_transport_retirement=jsonb_build_object(
   'proofHash',$1::text,'bodyProofManifestHash',$2::text,'sourceCommit',$3::text,'deliveryRows',$4::text,'snapshotRows','0','checkpointProofHash',$5::text,'completedAt',clock_timestamp())
   WHERE singleton AND NOT legacy_transport_retired`,[proofHash,input.bodyProofManifestHash,input.sourceCommit,stats.rows,canonicalPayloadHash(checkpoints).toString('hex')])
  if(marker.rowCount!==1)throw Error('legacy_transport_retirement_marker_changed')
  await db.query('DROP TABLE memory.memory_snapshot_events,memory.memory_snapshot_runs,memory.memory_feed_inbox,memory.memory_inbox_checkpoints RESTRICT')
  await assertTransportMetadataContract(db);await assertTargetMemoryWritersFenced(db)
  await db.query('COMMIT')
  return {kind:'physical-legacy-transport-retirement',proofHash,deliveryRows:stats.rows,snapshotRows:'0',oldPhysicalTablesRemoved:4,sourceIdsPreserved:true,rawBodiesSaved:false}
 }catch(error){await db.query('ROLLBACK').catch(()=>{});if(expired)throw Error('legacy_transport_retirement_window_expired');if(aborted)throw Error('legacy_transport_retirement_aborted');throw error}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel)}
}
