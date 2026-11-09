import type pg from 'pg'
import type {SourceScope,SourceRoot} from '@pocketctl/session-source'
export interface SourceProcessingCustodyWitness {jobId:string;scanId:string;targetCursor:string}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)
export function validSourceProcessingCustodyWitness(value:unknown):value is SourceProcessingCustodyWitness{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='jobId,scanId,targetCursor')return false
 const w=value as SourceProcessingCustodyWitness
 return uuid(w.jobId)&&uuid(w.scanId)&&typeof w.targetCursor==='string'&&w.targetCursor.length>0&&w.targetCursor.length<=2048
}
/** Necessity only, never an authority or original-to-Relay identity proof.
 * The original durable job must match a complete trusted native target under
 * the current control/mode. A newer content revision may still need the same
 * old custody; actual body/version authority is checked separately by the
 * original reader and original physical commit barrier. */
export async function readSourceProcessingCustodyDependency(db:Pick<pg.Client,'query'>,input:{scope:SourceScope;root:SourceRoot;sessionId:string;sourceEventId:string;witness:SourceProcessingCustodyWitness}){
 const{scope,root,sessionId,sourceEventId,witness}=input
 if(!validSourceProcessingCustodyWitness(witness)||scope.ownerScopeKind!=='personal'||root.kind!=='relay_event'
  ||root.key!==scope.principalUserId+':'+sessionId||!uuid(sourceEventId))return []
 return(await db.query(`SELECT j.job_id::text,
  encode(sha256(convert_to(jsonb_build_object('job',j.job_id,'installation',j.installation_id,'root',j.payload->'root',
   'scope',t.source_scope,'scan',d.scan_id,'cursor',t.cursor_key,'mode',t.target_mode,
   'controlRevision',d.control_revision::text,'sealedWorkRevision',d.work_revision::text,'generation',m.generation::text,
   'originalSourceEventId',$4::text)::text,'UTF8')),'hex') AS facts_hash
  FROM memory.memory_jobs j JOIN shared.memory_source_distributions d
   ON d.source_kind=$2 AND d.root_key=$3 AND d.scan_id=$5::uuid
  JOIN shared.memory_source_work w ON(w.source_kind,w.root_key)=(d.source_kind,d.root_key)
  JOIN shared.memory_source_distribution_targets t ON t.scan_id=d.scan_id AND t.cursor_key=$6
  JOIN shared.memory_source_modes m ON m.installation_id=j.installation_id
  JOIN public.extension_installations i ON i.installation_id=j.installation_id
  WHERE j.job_id=$1::uuid AND j.job_type='project_shared_source' AND j.state IN('pending','running','dead')
   AND octet_length(j.payload::text)<=1048576 AND j.installation_id=(($7::jsonb)->>'installationId')::uuid
   AND j.payload->'scope'=$7::jsonb AND j.payload->'root'=jsonb_build_object('kind',$2::text,'key',$3::text)
   AND j.payload->>'distribution_scan'=d.scan_id::text AND j.payload->>'target_cursor'=t.cursor_key
   AND j.idempotency_key='shared-source:'||d.scan_id::text||':'||encode(sha256(convert_to(t.cursor_key,'UTF8')),'hex')
   AND d.state='sealed' AND d.control_revision=shared.memory_source_control_snapshot()::bigint AND w.revision>=d.work_revision
   AND t.installation_id=j.installation_id AND t.state='current' AND t.target_mode='shared-active' AND t.source_scope=$7::jsonb
   AND m.mode='shared-active' AND m.generation::text=($7::jsonb)->>'modeGeneration'
   AND i.provider_id='pocketctl-memory' AND i.owner_scope_kind='personal' AND i.status='active'
   AND i.owner_user_id::text=($7::jsonb)->>'principalUserId' AND i.config_version::text=($7::jsonb)->>'configVersion'
   AND i.start_policy='retained_history'
   AND EXISTS(SELECT 1 FROM memory.source_events s WHERE s.source_event_id=$4::uuid AND s.installation_id=j.installation_id
    AND s.session_id=$8 AND(s.mapping_state='unproven' OR(s.mapping_state='verified' AND s.source_kind='legacy_archive' AND s.adapter_version='legacy-archive-v1')))
  LIMIT 2`,[witness.jobId,root.kind,root.key,sourceEventId,witness.scanId,witness.targetCursor,JSON.stringify(scope),sessionId])).rows
}
