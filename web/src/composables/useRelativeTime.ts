import { ref, computed } from 'vue'
import { useLocale } from './useLocale'

/**
 * Convert an ISO timestamp to a relative time string.
 * Locale-aware: zh → "X分钟前", en → "Xm ago".
 */
export function formatRelativeTime(isoOrDate: string | Date | undefined | null): string {
  if (!isoOrDate) return ''
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate)
  if (isNaN(date.getTime())) return ''

  const { locale } = useLocale()
  const zh = locale.value === 'zh'

  const now = Date.now()
  const diff = now - date.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (minutes < 1) return zh ? '刚刚' : 'just now'
  if (minutes < 60) return zh ? `${minutes}分钟前` : `${minutes}m ago`
  if (hours < 24) return zh ? `${hours}小时前` : `${hours}h ago`

  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

/**
 * Reactive relative time that auto-updates.
 */
export function useRelativeTime(isoTimestamp: () => string | Date | undefined | null) {
  const tick = ref(0)
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => { tick.value++ }, 60000)

  const display = computed(() => {
    tick.value
    return formatRelativeTime(isoTimestamp())
  })

  const stop = () => { if (timer) { clearInterval(timer); timer = null } }

  return { display, stop }
}
