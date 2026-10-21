import { mount, flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, expect, test, vi } from 'vitest'
import SystemNotificationDetail from '../SystemNotificationDetail.vue'
import type { LifecycleNotificationSubject, SystemNotification } from '../../../types/attentionInbox'
import { useLocale } from '../../../composables/useLocale'
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
test.each(['zh', 'en'] as const)('shows activity, rule and processing before opening a session (%s)', async locale => {
  const { setLocale, t } = useLocale(); setLocale(locale)
  api.listNotificationSubjects.mockResolvedValue({ subjects: [subject], subject_count: 1, next_cursor: null })
  const { wrapper } = await render()
  const text = wrapper.find('.subject-list').text()
  expect(text).toContain(new Date(subject.last_activity_at).toLocaleString())
  expect(text).toContain(t('attention.notification.reason.archive'))
  expect(text).toContain(t('attention.notification.processing.cool'))
  expect(api.getNotificationSubject).not.toHaveBeenCalled()
})
test.each([
  ['user_requested_zombie_cleanup', 'zombie'],
  ['unknown_manual_cleanup', 'unknown'],
  ['cloud_cleanup_completed', 'purge'],
])('uses the recorded reason for %s rather than guessing from purge', async (reason_code, label) => {
  api.listNotificationSubjects.mockResolvedValue({ subjects: [{ ...subject, action: 'purge', reason_code }], subject_count: 1, next_cursor: null })
  const { wrapper } = await render()
  expect(wrapper.find('.subject-list').text()).toContain(useLocale().t(`attention.notification.reason.${label}`))
  if (label !== 'purge') expect(wrapper.find('.subject-list').text()).not.toContain(useLocale().t('attention.notification.reason.purge'))
})
test('does not claim a running purge has already deleted the session', async () => {
  const pending: LifecycleNotificationSubject = { ...subject, action: 'purge', result: 'running', reason_code: 'inactivity_90_days', navigation: { type: 'lifecycle_detail', id: 'subject1' } }
  api.listNotificationSubjects.mockResolvedValue({ subjects: [pending], subject_count: 1, next_cursor: null })
  api.getNotificationSubject.mockResolvedValue({ subject: pending })
  const { wrapper } = await render()
  await wrapper.find('.subject-list button').trigger('click'); await flushPromises()
  expect(wrapper.find('.operation-summary').text()).not.toContain(useLocale().t('attention.notification.deleted'))
  expect(wrapper.find('.operation-summary').text()).toContain(useLocale().t('attention.notification.processing.purge'))
})
