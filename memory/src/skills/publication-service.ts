import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {z} from 'zod'
import type {GrantScopeBinding} from '../governance/authorization.js'
import {appendSkillAudit} from './audit-repository.js'
import {assessSkillRisk} from './risk-policy.js'
import {hasSkillFixtureCapability,type SkillFixtureCapability} from './testing-capability.js'
import {validateSkillPublicationTarget,publicationFailure,publicationDomainError,type SkillPublicationIdentity,type SkillPublicationValidationDeps} from './publication-validation.js'
export {SkillPublicationError} from './publication-validation.js'
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1)
export const SkillPublicationSubjectSchema=z.object({skillId:z.uuid(),versionId:z.uuid(),expectedRevision:revision}).strict()
export const SkillPublicationRequestSchema=SkillPublicationSubjectSchema.extend({expectedPublicationRevision:revision,mode:z.enum(['manual','auto'])}).strict()
export interface SkillPublicationDeps extends SkillPublicationValidationDeps {pool:pg.Pool;fixtureCapability?:SkillFixtureCapability}
export interface SkillPublicationResult {skillId:string;versionId:string;revision:number;publicationRevision:number;state:'active';provenance:'fixture'}
export interface SkillPublicationEligibility {eligible:boolean;manualEligible:boolean;reasonCodes:string[];independentSuccesses:number;requiredIndependentSuccesses:number;productGate:'closed';policyHash:string|null;replayRunId:string|null}

export async function changePublishedHead(client:pg.PoolClient,input:{identity:SkillPublicationIdentity;skillId:string;versionId:string;expectedPublicationRevision:number;mode:'manual'|'auto'|'rollback';actor:{actorKind:'personal'|'membership';actorId:string};binding:GrantScopeBinding;policyHash:string;replayRunId:string}) {
  const previous=(await client.query<{current_version_id:string|null;revision:string}>(`SELECT current_version_id,revision::text FROM memory_skill_publication_heads WHERE installation_id=$1 AND skill_id=$2 FOR UPDATE`,[input.identity.installationId,input.skillId])).rows[0]
  if(Number(previous?.revision??0)!==input.expectedPublicationRevision)publicationFailure('revision_conflict')
  if(previous?.current_version_id===input.versionId)publicationFailure('state_conflict')
  const eventId=randomUUID(),next=input.expectedPublicationRevision+1
  await client.query(`INSERT INTO memory_skill_publication_events(event_id,installation_id,skill_id,version_id,previous_version_id,revision,mode,provenance,actor_kind,actor_id,policy_hash,replay_run_id,membership_revision,authorization_epoch)
    VALUES($1,$2,$3,$4,$5,$6,$7,'fixture',$8,$9,$10,$11,$12,$13)`,[eventId,input.identity.installationId,input.skillId,input.versionId,previous?.current_version_id??null,next,input.mode,input.actor.actorKind,input.actor.actorId,input.policyHash,input.replayRunId,input.actor.actorKind==='membership'?input.binding.membership_revision:null,input.binding.authorization_epoch])
  if(previous){
    const result=await client.query(`UPDATE memory_skill_publication_heads SET current_version_id=$3,previous_version_id=current_version_id,revision=$4,state='active',publication_event_id=$5,updated_at=NOW()
      WHERE installation_id=$1 AND skill_id=$2 AND revision=$6`,[input.identity.installationId,input.skillId,input.versionId,next,eventId,input.expectedPublicationRevision])
    if(result.rowCount!==1)publicationFailure('revision_conflict')
  }else await client.query(`INSERT INTO memory_skill_publication_heads(installation_id,skill_id,current_version_id,revision,state,publication_event_id)VALUES($1,$2,$3,$4,'active',$5)`,[input.identity.installationId,input.skillId,input.versionId,next,eventId])
  return next
}
export function createSkillPublicationService(deps:SkillPublicationDeps){
  return {
    async execute(identity:SkillPublicationIdentity,rawRequest:unknown):Promise<SkillPublicationResult>{
      const client=await deps.pool.connect();const parsed=SkillPublicationRequestSchema.safeParse(rawRequest)
      try{
        await client.query('BEGIN');if(!parsed.success)publicationFailure('invalid_request');const r=parsed.data
        const facts=await validateSkillPublicationTarget(client,identity,r,deps)
        if(!hasSkillFixtureCapability(deps.fixtureCapability))publicationFailure('product_gate_closed')
        const publicationRevision=await changePublishedHead(client,{identity,...r,...facts})
        await appendSkillAudit(client,{installationId:identity.installationId,...facts.actor,action:'publish',outcome:'allowed',skillId:r.skillId,versionId:r.versionId,revision:publicationRevision,code:'ok'})
        await client.query('COMMIT');return {skillId:r.skillId,versionId:r.versionId,revision:r.expectedRevision,publicationRevision,state:'active',provenance:'fixture'}
      }catch(error){await client.query('ROLLBACK');const domain=publicationDomainError(error)
        await appendSkillAudit(client,{installationId:identity.installationId,actorKind:null,actorId:null,action:'publish',outcome:'denied',skillId:parsed.success?parsed.data.skillId:null,versionId:parsed.success?parsed.data.versionId:null,revision:null,code:domain.code});throw domain
      }finally{client.release()}
    },
    async getEligibility(identity:SkillPublicationIdentity,rawRequest:unknown):Promise<SkillPublicationEligibility>{
      const client=await deps.pool.connect(),parsed=SkillPublicationSubjectSchema.safeParse(rawRequest)
      try{
        await client.query('BEGIN');if(!parsed.success)publicationFailure('invalid_request')
        const facts=await validateSkillPublicationTarget(client,identity,{...parsed.data,mode:'manual'},deps)
        const reasons:string[]=[]
        if(assessSkillRisk(facts.version.document).risk!=='low')reasons.push('risk_denied')
        if(facts.independentSuccesses<facts.requiredIndependentSuccesses)reasons.push('independent_successes_required')
        await client.query('COMMIT')
        return {eligible:reasons.length===0,manualEligible:true,reasonCodes:reasons,independentSuccesses:facts.independentSuccesses,requiredIndependentSuccesses:facts.requiredIndependentSuccesses,productGate:'closed',policyHash:facts.policyHash,replayRunId:facts.replayRunId}
      }catch(error){await client.query('ROLLBACK');const domain=publicationDomainError(error)
        if(['invalid_request','forbidden','not_found','publication_failed'].includes(domain.code))throw domain
        return {eligible:false,manualEligible:false,reasonCodes:[domain.code],independentSuccesses:0,requiredIndependentSuccesses:2,productGate:'closed',policyHash:null,replayRunId:null}
      }finally{client.release()}
    },
  }
}
