import {automationHash} from '../governance/automation-policy.js'
/** Complete candidate content/scope/selected-evidence hash; revision and packet digest are independently checked by acceptance. */
export function candidateReviewHash(row:Record<string,unknown>):string{
 return automationHash(Object.fromEntries(['statement','structured_content','claim_type','scope_kind','scope_key','repository_id','repo_snapshot_id','branch','evidence_handles'].map(k=>[k,row[k]??null])))
}
