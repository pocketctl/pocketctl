import {mount} from '@vue/test-utils'
import {expect,test} from 'vitest'
import MaintenanceSummary from '../MaintenanceSummary.vue'
import SystemNotificationRow from '../SystemNotificationRow.vue'
import type {MaintenanceSummary as Summary,SystemNotification} from '../../../types/attentionInbox'
import {useLocale} from '../../../composables/useLocale'
const summary:Summary={scheduled_at:'2026-10-30T19:00:00Z',state:'partial',duration_seconds:7200,counts:{inbox_body:500,source_migration_protected:1,session_purge:2,unknown_secret:999},pending_installations:1,failed_installations:0}
test('daily summary renders allowed counters and protected/pending results',()=>{
 useLocale().locale.value='zh'
 const w=mount(MaintenanceSummary,{props:{summary}})
 expect(w.text()).toContain('500');expect(w.text()).toContain('未封存迁移');expect(w.text()).toContain('等待完成')
 expect(w.text()).not.toContain('999');expect(w.text()).not.toContain('unknown_secret')
})
test('Memory-only notification has a daily maintenance title and existing read state',()=>{
 const item:SystemNotification={notification_id:'daily',revision:1,kind:'system',topic:'session_lifecycle',created_at:'2026-10-31T00:00:00Z',read_at:'2026-10-31T01:00:00Z',expires_at:'2027-01-01T00:00:00Z',subject_count:0,subject_preview:[],subjects_next_cursor:null,requires_approval:false,maintenance:summary}
 const w=mount(SystemNotificationRow,{props:{item}})
 expect(w.text()).toContain('每日维护');expect(w.text()).toContain('部分完成');expect(w.text()).toContain('已读');expect(w.classes()).not.toContain('unread')
})
