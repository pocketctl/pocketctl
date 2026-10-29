import {expect,test} from 'vitest'
import {validTaskPlanDraft} from './teamPlan'
const step={step_id:'one',title:'One',instruction:'Do',acceptance:'Check',required:true,depends_on:[] as string[],review_policy:{reviewer_user_id:2,primary_offer_id:'offer',required_checks:['unit']}}
const draft={request_id:'key',expected_revision:0,team_session_id:'session',context_version:1,spec_revision:1,steps:[step,{...step,step_id:'two',depends_on:['one']}]}
test('draft requires a bounded local DAG and at least one required step',()=>{
 expect(validTaskPlanDraft(draft)).toBe(true)
 for(const steps of [[],[step,step],[{...step,depends_on:['missing']}],[{...step,depends_on:['one']}],[{...step,required:false}],[{...step,depends_on:['two']},draft.steps[1]],[{...step,instruction:'x'.repeat(16001)}]])expect(validTaskPlanDraft({...draft,steps})).toBe(false)
})
