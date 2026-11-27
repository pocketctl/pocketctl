import {createHash} from 'node:crypto'
import type pg from 'pg'

export type LegacyDialogueKey={installationId:string;jobId:string}
export type LegacyDialogueManifest=LegacyDialogueKey & {claimEpoch:string;deadAt:string;payloadHash:string;attempts:number;errorCode:string}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Each selected job is handled separately under its current queue lock. Never
// discover a cohort by error code or approximate session/turn matching.
export async function recoverLegacyDialogueJobs(pool:pg.Pool,keys:readonly (LegacyDialogueKey|LegacyDialogueManifest)[],apply=false){
  if(!Array.isArray(keys)||keys.length<1||keys.length>100||new Set(keys.map(k=>k.jobId)).size!==keys.length||
    keys.some(k=>!uuid.test(k.jobId)||!uuid.test(k.installationId)))throw Error('invalid_dialogue_repair_keys')
  const result=[]
  for(const key of keys){
    const resultIndex=result.length
    const c=await pool.connect()
    try{
      await c.query(apply?'BEGIN':'BEGIN READ ONLY')
      await c.query("SET LOCAL lock_timeout='250ms';SET LOCAL statement_timeout='3s'")
      const args=[key.installationId,key.jobId]
      const linked=await c.query(`SELECT claim_epoch::text AS "claimEpoch",dead_at::text AS "deadAt",encode(payload_hash,'hex') AS "payloadHash",
        attempts,error_code AS "errorCode" FROM memory_dialogue_legacy_failures WHERE installation_id=$1 AND job_id=$2`,args)
      const row=(await c.query(`SELECT j.payload,j.claim_epoch::text AS "claimEpoch",d.attempts,d.error_code AS "errorCode",d.dead_at::text AS "deadAt",
         encode(d.payload_hash,'hex') AS "payloadHash" FROM memory_jobs j JOIN memory_dead_letters d USING(installation_id,job_id,job_type)
        WHERE j.installation_id=$1 AND j.job_id=$2 AND j.job_type='compile_episode' AND j.state='dead' AND j.completed_at=d.dead_at
         AND NOT (j.payload ? 'dialogue_generation') AND j.attempts=d.attempts AND j.last_error_code=d.error_code
         AND length(j.payload->>'turn')>0 AND length(j.payload->>'dialogue_session')>0
         AND j.idempotency_key='dialogue:'||encode(sha256(convert_to(jsonb_build_array(j.payload->>'dialogue_session',j.payload->>'turn')::text,'UTF8')),'hex')
         AND shared.memory_dialogue_context(j.installation_id,j.payload->>'dialogue_session') IS NOT NULL
         ${apply?'FOR UPDATE OF j,d':''}`,args)).rows[0]
      const same=(r:LegacyDialogueManifest)=>['claimEpoch','deadAt','payloadHash','attempts','errorCode'].every(k=>
        r[k as keyof LegacyDialogueManifest]===key[k as keyof typeof key])
      if(apply&&linked.rows.some(same)){
        result.push({jobId:key.jobId,state:'already_enrolled'})
      }else if(!row||createHash('sha256').update(JSON.stringify(row.payload)).digest('hex')!==row.payloadHash||apply&&!same(row)){
        result.push({jobId:key.jobId,state:'unverified'})
      }else{
        const {payload,...identity}=row
        if(apply){
          const {dialogue_session:session,turn}=payload
          const scoped=[key.installationId,session,turn]
          const locked=await c.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('turn-dialogue:'||$1::text||':'||$2||':'||$3,0)) AS ok`,scoped)
          if(!locked.rows[0]?.ok)throw Error('dialogue_repair_busy')
          await c.query(`INSERT INTO memory_dialogue_turns(installation_id,session_id,turn_id,requested_generation)
            VALUES($1,$2,$3,nextval('memory.memory_dialogue_generation_seq')) ON CONFLICT(installation_id,session_id,turn_id)
            DO UPDATE SET requested_generation=nextval('memory.memory_dialogue_generation_seq'),requested_at=clock_timestamp()`,scoped)
          const g=(await c.query(`SELECT requested_generation FROM memory_dialogue_turns
            WHERE (installation_id,session_id,turn_id)=($1,$2,$3) FOR UPDATE`,scoped)).rows[0].requested_generation
          await c.query(`INSERT INTO memory_dialogue_legacy_failures(job_id,claim_epoch,installation_id,session_id,turn_id,generation,
            dead_at,payload_hash,attempts,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,decode($8,'hex'),$9,$10)`,
            [key.jobId,row.claimEpoch,...scoped,g,row.deadAt,row.payloadHash,row.attempts,row.errorCode])
          await c.query(`UPDATE memory_jobs SET state='pending',payload=jsonb_build_object('dialogue_session',$2::text,'turn',$3::text,
           'dialogue_generation',$4::text,'failure_recovery',true),priority=81,available_at=clock_timestamp(),attempts=0,
           claim_expires_at=NULL,claimed_by=NULL,completed_at=NULL,last_error_code=NULL WHERE job_id=$1`,[key.jobId,session,turn,g])
          result.push({jobId:key.jobId,state:'enrolled',generation:g})
        }else result.push({jobId:key.jobId,state:'verified',manifest:{installationId:key.installationId,jobId:key.jobId,...identity}})
      }
      await c.query('COMMIT')
    }catch(error){
      await c.query('ROLLBACK').catch(()=>undefined)
      result.length=resultIndex
      const code=error&&typeof error==='object'&&'code' in error?String(error.code):''
      if(error instanceof Error&&error.message==='dialogue_repair_busy'||['55P03','40P01','57014'].includes(code)){
        result.push({jobId:key.jobId,state:'busy'})
      }else throw error
    }finally{c.release()}
  }
  return result
}
