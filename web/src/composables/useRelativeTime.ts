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

/** Format how long a host has been offline for display in the host list. */
export function formatOfflineTime(isoOrDate: string | Date | undefined | null): string {
  if (!isoOrDate) return ''
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate)
  if (isNaN(date.getTime())) return ''

  const { locale } = useLocale()
  const zh = locale.value === 'zh'
  const diff = Math.max(0, Date.now() - date.getTime())
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (hours < 1) return zh ? `${minutes}分钟前` : `${minutes}m ago`
  if (days < 1) return zh ? `${hours}小时前` : `${hours}h ago`
  if (days < 3) return zh ? `${days}天前` : `${days}d ago`

  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  if (days < 365) return zh ? `离线${mm}月${dd}日` : `Offline ${mm}-${dd}`

  return zh ? `离线${date.getFullYear()}年${mm}月${dd}日` : `Offline ${date.getFullYear()}-${mm}-${dd}`
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
