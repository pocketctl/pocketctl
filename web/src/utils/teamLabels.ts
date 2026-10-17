import { useLocale } from '../composables/useLocale'

function label(value: string | null | undefined, labels: Record<string, [string, string]>): string {
  if (!value) return '—'
  return labels[value]?.[useLocale().locale.value === 'en' ? 1 : 0] ?? value
}
export const teamAvailabilityLabel = (value?: string | null) => label(value, {
  online:['在线','Online'], offline:['离线','Offline'], occupied:['使用中','In use'],
  access_disabled:['访问已关闭','Access disabled'], unsupported:['暂不支持','Unsupported'],
})
export const teamPermissionLabel = (value?: string | null) => label(value, {
  manual:['逐次审批','Ask for approval'], request_approval:['按需审批','Request approval'],
  plan:['计划模式','Plan mode'],
  read_only:['只读','Read only'], acceptEdits:['允许编辑，其他操作需审批','Allow edits; approve other actions'],
  full_access:['完全访问','Full access'], bypassPermissions:['跳过审批','Bypass approval'],
})
export const teamEffortLabel = (value?: string | null) => label(value, {
  low:['低','Low'], medium:['中','Medium'], high:['高','High'], xhigh:['极高','Extra high'],
  minimal:['最低','Minimal'], none:['不使用','None'],
})
export const teamConfigSourceLabel = (value?: string | null) => label(value, {
  'daemon-local-settings':['主机本地设置','Host settings'],
  'provider-default':['Agent 默认设置','Agent defaults'],
})
export const teamRunModeLabel = (value?: string | null) => label(value, {
  discussion:['方案讨论（只读）','Discussion (read only)'], review:['交叉评审（只读）','Review (read only)'],
  execute:['协作执行','Collaborative execution'],
})
