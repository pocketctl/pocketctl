import { ref, computed } from 'vue'

/**
 * Convert an ISO timestamp to a relative time string in Chinese.
 * - < 1min → "刚刚"
 * - 1-59min → "X分钟前"
 * - 1-23h → "X小时前"
 * - > 24h → "MM-DD HH:mm"
 */
export function formatRelativeTime(isoOrDate: string | Date | undefined | null): string {
  if (!isoOrDate) return ''
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate)
  if (isNaN(date.getTime())) return ''

  const now = Date.now()
  const diff = now - date.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`

  // Format as MM-DD HH:mm
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

  // Update every 60 seconds
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => { tick.value++ }, 60000)

  const display = computed(() => {
    tick.value // dependency
    return formatRelativeTime(isoTimestamp())
  })

  const stop = () => { if (timer) { clearInterval(timer); timer = null } }

  return { display, stop }
}
