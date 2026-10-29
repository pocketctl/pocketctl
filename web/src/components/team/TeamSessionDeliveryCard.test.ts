import { mount } from '@vue/test-utils'
import { expect,test } from 'vitest'
import TeamSessionDeliveryCard from './TeamSessionDeliveryCard.vue'
import type { SessionDeliveryCard } from '../../types/teamDelivery'
const item:SessionDeliveryCard={task_id:'task',title:'修复重连',task_state:'in_progress',revision:2,spec_revision:1,reviewer_user_id:2,event_id:'event',source_call_id:'call',latest_submission_id:'submission',submission_spec_revision:1,version:1,summary:'只读文件快照',published_at:'2026-10-23T00:00:00Z',decision:null,decision_reason:null,execution_pending:false,files:[{id:'file',name:'proof.md',byte_size:12}],revoked_artifact_ids:[]}
test('card opens its durable task identity and never presents task completion as delivery acceptance',async()=>{
 const w=mount(TeamSessionDeliveryCard,{props:{item:{...item,decision:'accepted'},cached:false,reviewer:'Lin'}});expect(w.text()).toContain('任务状态以任务详情为准');await w.get('button').trigger('click');expect(w.emitted('open')).toEqual([['task']]);w.unmount()
})
test('offline and outdated spec states are explicit; revoked filenames do not expose a download',()=>{
 const w=mount(TeamSessionDeliveryCard,{props:{item:{...item,spec_revision:2,revoked_artifact_ids:['file']},cached:true,reviewer:'Lin'}});expect(w.text()).toContain('历史规格');expect(w.text()).toContain('上次同步的只读内容');expect(w.text()).toContain('proof.md · 已撤销');expect(w.find('a').exists()).toBe(false);w.unmount()
})
