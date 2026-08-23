import { ref } from 'vue'

export function useCountdown(initialSeconds: number = 60) {
  const countdown = ref(0)
  const isCounting = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null

  function start() {
    if (isCounting.value) return
    isCounting.value = true
    countdown.value = initialSeconds

    timer = setInterval(() => {
      countdown.value--
      if (countdown.value <= 0) {
        stop()
      }
    }, 1000)
  }

  function stop() {
    isCounting.value = false
    countdown.value = 0
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const buttonText = computed(() => {
    if (isCounting.value) return `${countdown.value}s 后重发`
    return '获取验证码'
  })

  return { countdown, isCounting, buttonText, start, stop }
}

// Need this import for buttonText computed
import { computed } from 'vue'
