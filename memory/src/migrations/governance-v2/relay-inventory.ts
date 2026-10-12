import {createHash} from 'node:crypto'
import type pg from 'pg'
import type {ScopeObservation,TeamSourceObservation,MigrationInventoryItem} from './manifest.js'
const columns={extension_installations:['installation_id','provider_id','owner_scope_kind','owner_scope_id','status','authorization_epoch'],extension_teams:['team_id','state','authorization_epoch'],extension_organizations:['organization_id','state','authorization_epoch'],team_memory_bindings:['binding_id','team_id','installation_id','owner_scope_kind','owner_scope_id','state','revision'],collaboration_teams:['team_id','state'],collaboration_sessions:['team_session_id','team_id','state'],collaboration_session_participants:['team_session_id','user_id','state','revision'],collaboration_team_memberships:['team_id','user_id','state'],extension_source_outbox:['source_seq'],extension_scope_outbox:['outbox_id'],extension_feed:['feed_id']} as const
export async function openRelayInventory(pool:pg.Pool,onFindingBatch?:(items:MigrationInventoryItem[])=>Promise<void>){
 const client=await pool.connect()
 let closed=false
 const manifest={compatible:false,blockers:[] as string[],environmentFingerprint:'',schemaFingerprint:'',counts:{} as Record<string,number>,tableBytes:{} as Record<string,number>,watermarks:{snapshotAt:'',feedId:'0',scopeOutboxId:'0',sourceSequence:'0'}}
 const reconciliation={snapshotsAreAtomic:false,counts:{scopeMatched:0,sourceMatched:0} as Record<string,number>,items:[] as MigrationInventoryItem[],itemsTruncated:false,limitations:['Two independent read-only snapshots are not an atomic cross-database authority fence. Recheck under the migration write barrier before actions.','Current scope/source mismatches do not establish illegal historical approval. Matched registry generations are not Grant proofs or permission to restore deleted data.']}
 const finish=async(commit=true)=>{if(closed)return;closed=true;try{await client.query(commit?'COMMIT':'ROLLBACK')}finally{client.release()}}
 const finding=async(kind:string,id:string,installationId:string,reason:string)=>{
  reconciliation.counts[reason]=(reconciliation.counts[reason]??0)+1
  const item:MigrationInventoryItem={kind,id,installationId,reason,action:'review',certainty:'unproven'}
  if(reconciliation.items.length<100)reconciliation.items.push(item);else reconciliation.itemsTruncated=true
  await onFindingBatch?.([item])
 }
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await client.query("SET LOCAL statement_timeout='5s'")
  const identity=(await client.query('SELECT current_database() AS db,current_user AS role,version() AS version,inet_server_addr()::text AS server,pg_postmaster_start_time()::text AS started,CURRENT_TIMESTAMP::text AS snapshot_at')).rows[0]
  const {snapshot_at,...environment}=identity
  manifest.watermarks.snapshotAt=snapshot_at;manifest.environmentFingerprint=createHash('sha256').update(JSON.stringify(environment)).digest('hex')
  const schema=(await client.query('SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position',[Object.keys(columns)])).rows
  manifest.schemaFingerprint=createHash('sha256').update(JSON.stringify(schema)).digest('hex')
  for(const [table,names] of Object.entries(columns)){
   for(const name of names)if(!schema.some(row=>row.table_name===table&&row.column_name===name))manifest.blockers.push('missing_column:'+table+'.'+name)
  }
  if(!manifest.blockers.length){
   for(const table of Object.keys(columns)){
    manifest.counts[table]=Number((await client.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`)).rows[0].n)
    manifest.tableBytes[table]=Number((await client.query('SELECT pg_total_relation_size($1::regclass)::bigint AS n',[table])).rows[0].n)
   }
   for(const [key,table,column] of [['feedId','extension_feed','feed_id'],['scopeOutboxId','extension_scope_outbox','outbox_id'],['sourceSequence','extension_source_outbox','source_seq']] as const)manifest.watermarks[key]=(await client.query(`SELECT COALESCE(MAX(${column}),0)::text AS n FROM ${table}`)).rows[0].n
   manifest.compatible=true
  }
  return {manifest,reconciliation,finish,
   async scopes(rows:ScopeObservation[]){
    for(const source of rows){
     if(!manifest.compatible){await finding('scope',source.installationId,source.installationId,'relay_schema_unavailable');continue}
     const current=(await client.query(`SELECT i.owner_scope_kind,i.owner_scope_id::text,i.status,
       CASE WHEN i.owner_scope_kind='team' THEN team.authorization_epoch WHEN i.owner_scope_kind='organization' THEN org.authorization_epoch ELSE i.authorization_epoch END::text AS epoch,
       CASE WHEN i.owner_scope_kind='team' THEN team.state WHEN i.owner_scope_kind='organization' THEN org.state ELSE 'active' END AS state
       FROM extension_installations i LEFT JOIN extension_teams team ON i.owner_scope_kind='team' AND team.team_id=i.owner_scope_id LEFT JOIN extension_organizations org ON i.owner_scope_kind='organization' AND org.organization_id=i.owner_scope_id
       WHERE i.installation_id=$1 AND i.provider_id='pocketctl-memory'`,[source.installationId])).rows[0]
     const reason=!current?'scope_installation_missing':current.owner_scope_kind!==source.ownerKind||current.owner_scope_id!==source.ownerId?'scope_ownership_mismatch':current.status!=='active'||current.state!==source.state?'scope_state_mismatch':current.epoch!==source.epoch?'scope_epoch_mismatch':null
     if(reason)await finding('scope',source.installationId,source.installationId,reason);else reconciliation.counts.scopeMatched++
    }
   },
   async sources(rows:TeamSourceObservation[]){
    const identifier=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)
    const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    const positive=(value:unknown)=>typeof value==='string'&&/^[1-9][0-9]{0,15}$/.test(value)&&Number.isSafeInteger(Number(value))
    for(const source of rows){
     if(!manifest.compatible){await finding('team_source',source.id,source.installationId,'relay_schema_unavailable');continue}
     if(![source.bindingId,source.teamId,source.sessionId].every(identifier)||![source.bindingRevision,source.participantId,source.participantRevision].every(positive)||Number(source.participantId)>2147483647||!uuid(source.targetInstallationId)||!uuid(source.targetOwnerId)||!['personal','team','organization'].includes(source.targetOwnerKind)){
      await finding('team_source',source.id,source.installationId,'invalid_source_provenance');continue
     }
     const current=(await client.query(`SELECT b.team_id,b.installation_id::text,b.owner_scope_kind,b.owner_scope_id::text,b.state AS binding_state,b.revision::text AS binding_revision,team.state AS team_state,session.state AS session_state,member.state AS member_state,participant.state AS participant_state,participant.revision::text AS participant_revision
      FROM team_memory_bindings b JOIN collaboration_teams team ON team.team_id=b.team_id
      LEFT JOIN collaboration_sessions session ON session.team_session_id=$2 AND session.team_id=b.team_id
      LEFT JOIN collaboration_team_memberships member ON member.team_id=b.team_id AND member.user_id=$3
      LEFT JOIN collaboration_session_participants participant ON participant.team_session_id=session.team_session_id AND participant.user_id=$3
      WHERE b.binding_id=$1`,[source.bindingId,source.sessionId,Number(source.participantId)])).rows[0]
     const reason=!current?'binding_missing':current.team_id!==source.teamId||current.installation_id!==source.targetInstallationId||current.owner_scope_kind!==source.targetOwnerKind||current.owner_scope_id!==source.targetOwnerId?'binding_ownership_mismatch':current.binding_revision!==source.bindingRevision?'binding_generation_mismatch':current.participant_revision!==source.participantRevision?'participant_generation_mismatch':current.binding_state!=='active'||current.team_state!=='active'||current.session_state!=='active'||current.member_state!=='active'||current.participant_state!=='active'?'source_authorization_inactive':null
     if(reason)await finding('team_source',source.id,source.installationId,reason);else reconciliation.counts.sourceMatched++
    }
   },
  }
 }catch(error){await finish(false).catch(()=>undefined);throw error}
}
