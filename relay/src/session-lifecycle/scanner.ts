import type pg from 'pg'
import { inspectLifecycleEligibility } from './eligibility.js'
import type { LifecycleAction,LifecycleEvaluation,SessionLifecycleConfig } from './types.js'
interface Candidate {
  rowId:number;sessionId:string;userId:number|null;activityEpoch:string;dependencyCount:number
  eventCount:string;logicalPayloadBytes:string;countsScope:'dependency_component'
  projectedAction:LifecycleAction|null;prediction:LifecycleEvaluation
}
export interface LifecycleObservePage {
  mode:'off'|'observe';policyVersion:string;evaluatedAt:string|null;candidates:Candidate[]
  nextRowId:number|null;eligibleCount:number;readiness:string[]
}
/** Same factual eligibility as execution; observe never enqueues or mutates.
 * Stable keyset pages count a dependency component at its lowest row ID. */
export class SessionLifecycleScanner {
  constructor(private readonly db:Pick<pg.Pool,'query'>,private readonly config:SessionLifecycleConfig){}
  async scanPage(input:{afterRowId?:number;limit:number;now?:string}):Promise<LifecycleObservePage>{
    const report:LifecycleObservePage={mode:'off',policyVersion:this.config.policyVersion,evaluatedAt:null,candidates:[],nextRowId:null,eligibleCount:0,readiness:[]}
    if(this.config.mode==='off')return report
    if(this.config.mode!=='observe')throw new Error('observe scanner does not execute lifecycle actions')
    if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100||!Number.isSafeInteger(input.afterRowId??0)||(input.afterRowId??0)<0)throw new Error('invalid lifecycle scan page')
    report.mode='observe'
    const clock=(await this.db.query(`SELECT to_char(COALESCE($1::timestamptz,NOW()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`,[input.now??null])).rows[0].time
    report.evaluatedAt=clock
    if(!this.config.effectiveAt)report.readiness.push('policy_unpublished')
    if(!this.config.objectBucket||!this.config.objectRegion)report.readiness.push('object_store_unconfigured')
    const rows=(await this.db.query(`SELECT id,session_id FROM sessions WHERE id>$1 AND (last_activity_at IS NULL
      OR last_activity_at<$2::timestamptz-($3::int*interval '1 day')) ORDER BY id LIMIT $4`,[input.afterRowId??0,clock,this.config.archiveDays,input.limit+1])).rows
    for(const row of rows.slice(0,input.limit)){
      const inspection=await inspectLifecycleEligibility(this.db,row.session_id,this.config,{now:clock}),root=inspection.root
      if(root&&inspection.members.every(member=>Number(member.id)>=row.id)){
        report.candidates.push({rowId:row.id,sessionId:row.session_id,userId:root.user_id,activityEpoch:root.epoch,
          dependencyCount:inspection.members.length,eventCount:inspection.eventCount,
          logicalPayloadBytes:(BigInt(inspection.hotEventBytes)+BigInt(inspection.hotDocumentBytes)).toString(),countsScope:'dependency_component',
          projectedAction:inspection.prediction.action,prediction:inspection.prediction})
      }
    }
    report.nextRowId=rows.length>input.limit?rows[input.limit-1].id:null
    report.eligibleCount=report.candidates.filter(candidate=>candidate.prediction.action).length
    return report
  }
}
