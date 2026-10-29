import type pg from 'pg'
import { readNativeTaskContext } from './task-context-service.js'
import { requireTeamAccess } from './access.js'
import { artifactDigest, boundedText, stableDigest, stableJSON } from './delivery-contract.js'
import { freezeAcceptedPlanInputs, type FrozenPlanInput } from './plan-inputs.js'
import { TeamRepositoryError } from './repository.js'

// Wire JSON includes both the readable array and an escaped canonical string.
// Its separate limit accommodates that envelope without truncating inputs.
export const STEP_INPUT_LIMITS = Object.freeze({ files: 128, bytes: 64 * 1024 * 1024, canonicalBytes: 128 * 1024, wireBytes: 512 * 1024 })
export function requireBoundedStepInputs(inputs: FrozenPlanInput[]): void {
  const artifacts = inputs.flatMap(input => input.artifacts)
  if (artifacts.length > STEP_INPUT_LIMITS.files || artifacts.reduce((sum,a) => sum+a.byte_size,0) > STEP_INPUT_LIMITS.bytes
    || Buffer.byteLength(stableJSON(inputs),'utf8') > STEP_INPUT_LIMITS.canonicalBytes) throw new TeamRepositoryError('input_limit_exceeded', 'step inputs exceed the bounded materialization limit')
}
export interface StepInputManifest {
  schema_version: 1
  call_id: string
  task_id: string
  attempt_id: string
  spec_revision: number
  input_hash: string
  inputs_json: string
  task_context_json: string
  inputs: FrozenPlanInput[]
}

/** Daemon read channel bound to its exact dispatched Call. Team membership by
 * itself is insufficient. Every read rechecks the frozen accepted sources and
 * current revocation; it cannot resolve a newer submission or create work. */
export class TeamStepInputService {
  constructor(private readonly pool: pg.Pool) {}

  getManifest(callId: string, daemonId: string, actor: number): Promise<StepInputManifest> {
    return this.withInputs(callId, daemonId, actor, async (_client, manifest) => manifest)
  }

  readArtifact(callId: string, daemonId: string, actor: number, attemptId: string, submissionId: string, artifactId: string) {
    for (const value of [attemptId,submissionId]) if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw new TeamRepositoryError('invalid_request','invalid frozen input identity')
    boundedText(artifactId,'artifact_id',128)
    return this.withInputs(callId, daemonId, actor, async (client, manifest) => {
      const input = manifest.inputs.find(i=>i.attempt_id===attemptId && i.submission_id===submissionId)
      const artifact = input?.artifacts.find(a=>a.id===artifactId)
      if (!artifact) throw new TeamRepositoryError('team_not_found','artifact is not in this Call input snapshot')
      const row = (await client.query('SELECT content_bytes FROM team_submission_artifacts WHERE submission_id=$1 AND artifact_id=$2',[submissionId,artifactId])).rows[0]
      if (!row || row.content_bytes.length!==artifact.byte_size || artifactDigest(row.content_bytes)!==artifact.sha256) throw new TeamRepositoryError('artifact_unavailable','frozen input bytes unavailable')
      return { bytes: Buffer.from(row.content_bytes), manifest: artifact }
    })
  }

  private async withInputs<T>(callId: string, daemonId: string, actor: number, read: (client: pg.PoolClient, manifest: StepInputManifest)=>Promise<T>): Promise<T> {
    boundedText(callId,'call_id',128);boundedText(daemonId,'daemon_id',128)
    const client=await this.pool.connect()
    try {
      await client.query('BEGIN')
      await requireTeamAccess(client,actor,true)
      const identity=(await client.query(`SELECT t.team_id,c.task_id,c.team_session_id FROM collaboration_calls c
        JOIN team_tasks t ON t.task_id=c.task_id JOIN team_task_step_attempts a ON a.call_id=c.call_id WHERE c.call_id=$1`,[callId])).rows[0]
      if(!identity) throw new TeamRepositoryError('team_not_found','step Call not found')
      const team=(await client.query("SELECT 1 FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE",[identity.team_id])).rows[0]
      const member=(await client.query("SELECT 1 FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' AND role<>'viewer' FOR SHARE",[identity.team_id,actor])).rows[0]
      const session=(await client.query("SELECT 1 FROM collaboration_sessions WHERE team_session_id=$1 AND state='active' FOR SHARE NOWAIT",[identity.team_session_id])).rows[0]
      const participant=(await client.query("SELECT 1 FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2 AND state='active' FOR SHARE",[identity.team_session_id,actor])).rows[0]
      const task=(await client.query("SELECT 1 FROM team_tasks WHERE task_id=$1 AND state<>'deleted' FOR SHARE",[identity.task_id])).rows[0]
      if(!team||!member||!session||!participant||!task) throw new TeamRepositoryError('team_not_found','step Call not found')
      const call=(await client.query(`SELECT c.call_id,a.attempt_id,a.plan_revision,a.step_id,a.frozen_inputs,a.input_hash,cs.spec_revision
        FROM collaboration_calls c JOIN team_task_step_attempts a ON a.call_id=c.call_id AND a.task_id=c.task_id
        JOIN team_call_delivery_specs cs ON cs.call_id=c.call_id AND cs.task_id=c.task_id
        JOIN collaboration_session_agent_bindings b ON b.binding_id=c.binding_id AND b.state='active'
        JOIN team_agent_offers o ON o.offer_id=c.offer_id AND o.state='active'
        JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id
        WHERE c.call_id=$1 AND c.state IN ('dispatched','accepted') AND a.state IN ('reserved','dispatched','running')
          AND o.owner_user_id=$2 AND b.owner_user_id=$2 AND d.daemon_id=$3
          AND b.revision=c.binding_revision AND o.revision=c.offer_revision
        FOR SHARE OF c,b,o,d NOWAIT`,[callId,actor,daemonId])).rows[0]
      if(!call) throw new TeamRepositoryError('team_not_found','step Call is not authorized for this daemon')
      const frozen=call.frozen_inputs as FrozenPlanInput[]
      requireBoundedStepInputs(frozen)
      if(stableDigest(frozen)!==call.input_hash) throw new TeamRepositoryError('artifact_integrity','step input snapshot hash mismatch')
      const current=await freezeAcceptedPlanInputs(client,identity.task_id,Number(call.plan_revision),call.step_id,frozen.map(i=>({step_id:i.step_id,attempt_id:i.attempt_id,submission_id:i.submission_id})))
      if(stableDigest(current)!==call.input_hash) throw new TeamRepositoryError('artifact_unavailable','frozen accepted input changed')
      // The exact canonical JSON bytes let non-JS consumers verify the hash
      // without depending on locale sorting or language-specific escaping.
      const taskContext=stableJSON(await readNativeTaskContext(client,identity.task_id,callId,call.attempt_id))
      if(Buffer.byteLength(taskContext,'utf8')>128*1024) throw new TeamRepositoryError('input_limit_exceeded','task context exceeds snapshot limit')
      const manifest: StepInputManifest={schema_version:1,call_id:callId,task_id:identity.task_id,attempt_id:call.attempt_id,spec_revision:Number(call.spec_revision),input_hash:call.input_hash,inputs_json:stableJSON(frozen),inputs:frozen,task_context_json:taskContext}
      if(Buffer.byteLength(JSON.stringify(manifest),'utf8')>STEP_INPUT_LIMITS.wireBytes) throw new TeamRepositoryError('input_limit_exceeded','step input response exceeds wire limit')
      const result=await read(client,manifest)
      await client.query('COMMIT');return result
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{})
      if((error as {code?:string}).code==='55P03') throw new TeamRepositoryError('source_busy','step input source is busy')
      throw error
    } finally {client.release()}
  }
}
