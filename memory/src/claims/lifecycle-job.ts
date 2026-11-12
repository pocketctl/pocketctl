import type {JobRepository} from '../jobs/repository.js'
import type {JobHandler} from '../jobs/worker.js'
import type {createLifecycleAssessmentService} from './lifecycle-assessment.js'
import type {LifecycleService} from './lifecycle-service.js'

export function createLifecycleJobHandler(input:{
 shared:boolean
 jobs:Pick<JobRepository,'enqueueJob'>
 lifecycle:Pick<LifecycleService,'listDueInstallations'|'evaluateDueClaims'>
 assessment:ReturnType<typeof createLifecycleAssessmentService>
}):JobHandler{
 return async (job,signal)=>{
  const installationId=job.installation_id??undefined
  if(input.shared&&!installationId){
   // Existing global jobs discover work. The dispatched installation job
   // captures its own source generation and lease before the provider path.
   for(const id of await input.lifecycle.listDueInstallations()){
    if(signal.aborted)return
    await input.jobs.enqueueJob({installationId:id,jobType:'evaluate_claim_lifecycle',idempotencyKey:`lifecycle-installation:${job.job_id}`})
   }
   return
  }
  await input.assessment.assessDueClaims({installationId,limit:1,signal})
  if(!signal.aborted)await input.lifecycle.evaluateDueClaims({installationId,limit:100})
 }
}
