import { mount, flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, expect, test, vi } from 'vitest'
import SystemNotificationDetail from '../SystemNotificationDetail.vue'
import type { LifecycleNotificationSubject, SystemNotification } from '../../../types/attentionInbox'
const api = vi.hoisted(() => ({ listNotificationSubjects: vi.fn(), getNotificationSubject: vi.fn() }))
vi.mock('../../../services/attentionInboxClient', async original => ({ ...(await original<any>()), ...api }))
const subject: LifecycleNotificationSubject = { subject_id: 'subject1', session_id: 'session1', daemon_id: 'host1', title: '<script>long title</script>', daemon_name: 'Host', action: 'cool', result: 'succeeded', last_activity_at: '2026-07-01T00:00:00Z', executed_at: null, effective_purge_at: null, reason_code: 'inactivity_60_days', navigation: { type: 'session', id: 'session1' } }
const notice: SystemNotification = { notification_id: 'notice1', revision: 1, kind: 'system', topic: 'session_lifecycle', created_at: '2026-10-12T00:00:00Z', read_at: null, expires_at: '2027-01-01T00:00:00Z', subject_count: 2, subject_preview: [subject], subjects_next_cursor: 'preview', requires_approval: false }
beforeEach(() => { vi.resetAllMocks() })
async function render() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: { template: '<div />' } }, { path: '/session/:id', component: { template: '<div />' } }] })
  await router.push('/inbox')
  const wrapper = mount(SystemNotificationDetail, { props: { item: notice, scope: { type: 'daemon', daemonId: 'host1' }, mobile: false }, global: { plugins: [router] } })
  await flushPromises(); return { wrapper, router }
}
test('loads every subject page and resolves current authorized navigation', async () => {
  api.listNotificationSubjects.mockResolvedValueOnce({ subjects: [subject], subject_count: 2, next_cursor: 'page2' }).mockResolvedValueOnce({ subjects: [{ ...subject, subject_id: 'subject2' }], subject_count: 2, next_cursor: null })
  api.getNotificationSubject.mockResolvedValue({ subject })
  const { wrapper, router } = await render()
  expect(wrapper.find('script').exists()).toBe(false)
  await wrapper.find('[data-testid="notification-subject-more"]').trigger('click'); await flushPromises()
  expect(api.listNotificationSubjects.mock.calls[1][2]).toBe('page2')
  expect(wrapper.findAll('.subject-list li')).toHaveLength(2)
  await wrapper.find('.subject-list button').trigger('click'); await flushPromises()
  expect(api.getNotificationSubject).toHaveBeenCalledWith('notice1', 'subject1', { type: 'daemon', daemonId: 'host1' })
  expect(router.currentRoute.value.path).toBe('/session/session1')
})
test('revoked detail clears all loaded subjects rather than navigating from preview', async () => {
  api.listNotificationSubjects.mockResolvedValue({ subjects: [subject], subject_count: 1, next_cursor: null })
  api.getNotificationSubject.mockRejectedValue(new Error('revoked'))
  const { wrapper, router } = await render()
  await wrapper.find('.subject-list button').trigger('click'); await flushPromises()
  expect(wrapper.find('.subject-list').exists()).toBe(false)
  expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  expect(router.currentRoute.value.path).toBe('/inbox')
})
