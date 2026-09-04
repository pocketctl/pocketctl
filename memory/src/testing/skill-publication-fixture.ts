import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {createSkillGovernanceFixture,skillFixtureDocument} from './skill-fixture.js'
import {loadSkillConfig} from '../skills/config.js'
import {createSkillReviewService} from '../skills/review-service.js'
import {createSkillReplayService} from '../skills/replay-service.js'
import {createSkillPublicationService} from '../skills/publication-service.js'
import {createSkillRollbackService} from '../skills/rollback-service.js'
import {createSkillFixtureCapability} from '../skills/testing-capability.js'
import {replayTextHash,type ReplayCase} from '../skills/replay-runner.js'
import type {SkillCandidateDocument} from '../skills/types.js'

export const skillPublicationFixtureContext={globalMode:'enabled' as const,sharedMode:'shadow' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
/** Isolated synthetic governance fixture; it is never natural Product Effect evidence. */
export async function createSkillPublicationFixture(pool:pg.Pool,options:{high?:boolean;publish?:boolean;naturalSourceSessionKeys?:string[]}={}){
  const context=skillPublicationFixtureContext,f=await createSkillGovernanceFixture(pool,context,'team',options.high,options)
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,compiler_version,repository_id,repo_snapshot_id)
    VALUES($1,$2,$3,$2::uuid::text,'ready','completed','fixture',$4,$5)`,[f.installationId,randomUUID(),f.sessionId,f.repositoryId,f.snapshotId])
  const reviewer=await f.actor(['reviewer'],['read','review']),publisher=await f.actor(['publisher'],['read','publish']),reader=await f.actor(['reader'],['read'])
  const policyAdmin=await f.actor(['scope_administrator'],['read','policy_admin'])
  const caseRecords=new Map<string,ReplayCase[]>()
  const cases={loadCases:async(input:{versionId:string;caseIds:string[]})=>(caseRecords.get(input.versionId)??[]).filter(c=>input.caseIds.includes(c.case_id))}
  const fixtureCapability=createSkillFixtureCapability(),deps={pool,context,cases,fixtureCapability}
  const review=createSkillReviewService({pool,context}),replay=createSkillReplayService(deps),publication=createSkillPublicationService(deps),rollback=createSkillRollbackService(deps)
  async function prepareVersion(previous?:{skillId:string;revision:number},document?:unknown,candidateId?:string){
    const draft=await review.execute(f.author,candidateId?{action:'draft',candidateId,expectedRevision:previous?.revision??0}:previous?{action:'edit',skillId:previous.skillId,expectedRevision:previous.revision,document:document??skillFixtureDocument(options.high)}:{action:'draft',candidateId:f.candidateId,expectedRevision:0})
    const approved=await review.execute(reviewer,{action:'approve',skillId:draft.skillId,expectedRevision:draft.revision})
    const v=(await pool.query(`SELECT document,document_hash,policy_hash FROM memory_skill_versions WHERE version_id=$1`,[draft.versionId])).rows[0]
    const doc=v.document as SkillCandidateDocument
    const records:ReplayCase[]=(['historical_session','golden_task'] as const).map((kind,i)=>({
      schema_version:'skill-replay-case.v1',case_id:`case-${i}`,kind,provenance:'fixture',installation_id:f.installationId,repository_id:f.repositoryId,repo_snapshot_id:f.snapshotId,
      version_id:draft.versionId,document_hash:v.document_hash,policy_hash:v.policy_hash,reference_id:i===0?f.sessionId:'golden-method',
      steps:doc.steps.map((step,index)=>({step_index:index,tool:step.tool,operation:step.operation,instruction_hash:replayTextHash(step.instruction),response:{matches:2}})),
      assertions:doc.validation.map((validation,index)=>({assertion_id:`assertion-${index}`,validation_index:index,validation_hash:replayTextHash(validation),step_index:0,path:['matches'],operator:'equals',expected:2})),
    }))
    caseRecords.set(draft.versionId,records)
    const subject={skillId:approved.skillId,versionId:approved.versionId,expectedRevision:approved.revision}
    const evidence=await replay.execute(reviewer,{...subject,caseIds:records.map(c=>c.case_id),idempotencyKey:`replay-${approved.versionId}`})
    return {...approved,subject,evidence,records}
  }
  const reviewed=await prepareVersion()
  const publishRequest={...reviewed.subject,expectedPublicationRevision:0,mode:'manual' as const}
  const published=options.publish===false?null:await publication.execute(publisher,publishRequest)
  return {...f,context,cases,caseRecords,fixtureCapability,deps,review,replay,publication,rollback,reviewer,publisher,reader,policyAdmin,reviewed,publishRequest,published,prepareVersion}
}
