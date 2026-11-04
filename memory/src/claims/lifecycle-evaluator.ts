import {LIFECYCLE_DAY_MS,LIFECYCLE_REVIEW_DAYS,LIFECYCLE_COLD_DAYS,type LifecycleFacts,type LifecycleDecision} from './lifecycle-policy.js'

/** Time grants eligibility, never proof of low value. Unknown telemetry,
 * human authority, stable constraints and explicit protections fail closed. */
export function evaluateClaimLifecycle(f:LifecycleFacts):LifecycleDecision {
 const now=f.now.getTime(), next=new Date(now+LIFECYCLE_DAY_MS)
 const result=(action:LifecycleDecision['action'],reason:string,nextEvaluateAt=next)=>({action,reason,nextEvaluateAt})
 if(!f.sourceAvailable)return result('revoke','source_unavailable')
 if(f.validUntil&&f.validUntil.getTime()<=now)return result('expire','validity_elapsed')
 if(f.state!=='active')return result('retain','not_active')
 if(f.bodyState==='reclaimed')return result('retain','body_unavailable')
 if(f.protection!=='none')return result('retain','protected')
 if(!['machine_concluded','automation_accepted'].includes(f.authority))return result('retain','human_authority')
 if(!['method','fact'].includes(f.kind))return result('retain','stable_or_event_knowledge')
 if(f.valueAssessment!=='low')return result('retain','value_not_low')
 if(f.observationState!=='observed'||!f.observationStartedAt)return result('retain','usage_unknown')
 const reference=Math.max(f.createdAt.getTime(),f.observationStartedAt.getTime(),f.lastConfirmedAt?.getTime()??0,
  f.lastDeliveredAt?.getTime()??0,f.lastConfirmedUseAt?.getTime()??0)
 const due=reference+LIFECYCLE_REVIEW_DAYS*LIFECYCLE_DAY_MS
 if(now<due)return result('retain','review_not_due',new Date(due))
 if(f.storageTier==='hot')return result(f.coldMode==='enabled'?'cool':'retain',f.coldMode==='enabled'?'low_value_observed':`cold_${f.coldMode}`)
 if(!f.coldSince||now<f.coldSince.getTime()+LIFECYCLE_COLD_DAYS*LIFECYCLE_DAY_MS)
  return result('retain','cold_grace',new Date((f.coldSince?.getTime()??now)+LIFECYCLE_COLD_DAYS*LIFECYCLE_DAY_MS))
 return result(f.reclaimMode==='enabled'?'reclaim_eligible':'retain',f.reclaimMode==='enabled'?'cold_grace_complete':`reclaim_${f.reclaimMode}`)
}
