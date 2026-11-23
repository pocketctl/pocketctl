// Also loaded by the two standalone design baselines.
(() => {
  if (customElements.get('pt-execution-mark')) return
  // Dot centres from the six-row PT artwork, in the 24-unit view box.
  const columns = [2.7, 4.74, 6.76, 8.74, 10.74, 12.74, 14.82, 16.93, 19.07, 21.22]
  const rows = ['1111 11111', '1001 00100', '1001 00100', '1110 00100', '1000 00100', '1000 00100']
  const letterScale = 0.8
  const targets = rows.flatMap((row, y) => Array.from(row, (bit, x) =>
    bit === '1' ? { x: 12 + (columns[x] - 12) * letterScale, y: 12 + (y - 2.5) * 2.11 * letterScale } : null
  ).filter(Boolean))
  const dots = targets.map((target, index) => {
    const y = 1 - 2 * (index + 0.5) / targets.length
    const radius = Math.sqrt(1 - y * y)
    const angle = index * Math.PI * (3 - Math.sqrt(5))
    return { target, x: radius * Math.cos(angle), y, z: radius * Math.sin(angle) }
  })
  function smooth(value) {
    const t = Math.min(1, Math.max(0, value))
    return t * t * (3 - 2 * t)
  }

  class ExecutionMark extends HTMLElement {
    connectedCallback() {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.style.cssText = 'width:100%;height:100%;display:block;fill:currentColor'
      this.style.cssText = 'display:inline-block;flex:none;width:var(--pt-mark-size,24px);height:var(--pt-mark-size,24px);color:var(--accent,currentColor)'
      const circles = dots.map(() => svg.appendChild(document.createElementNS(ns, 'circle')))
      this.replaceChildren(svg)
      const preference = matchMedia('(prefers-reduced-motion: reduce)')
      const start = performance.now()
      let frame = 0
      let wake = 0
      let showingPT = false
      let visible = false
      const draw = (seconds, still) => {
        const phase = seconds % 6
        const mix = still ? 1 : smooth((phase - 1.6) / 1.1) - smooth((phase - 4.4) / 1.1)
        const angle = seconds * Math.PI / 1.5
        const cos = Math.cos(angle), sin = Math.sin(angle)
        dots.forEach((dot, i) => {
          const x = 12 + 9 * (dot.x * cos + dot.z * sin)
          const y = 12 - 9 * dot.y
          const depth = (1 + dot.z * cos - dot.x * sin) / 2
          const circle = circles[i]
          circle.setAttribute('cx', x + (dot.target.x - x) * mix)
          circle.setAttribute('cy', y + (dot.target.y - y) * mix)
          circle.setAttribute('r', (0.67 + 0.22 * depth) * (1 - mix) + letterScale * mix)
          circle.setAttribute('opacity', 0.3 + 0.7 * (depth + (1 - depth) * mix))
        })
      }
      const showPT = () => {
        if (!showingPT) draw(0, true)
        showingPT = true
      }
      const tick = now => {
        const seconds = (now - start) / 1000
        const phase = seconds % 6
        if (phase >= 2.7 && phase < 4.4) {
          showPT()
          wake = setTimeout(() => { frame = requestAnimationFrame(tick) }, Math.ceil((4.4 - phase) * 1000))
        } else {
          showingPT = false
          draw(seconds, false)
          frame = requestAnimationFrame(tick)
        }
      }
      const cancel = () => {
        cancelAnimationFrame(frame)
        clearTimeout(wake)
      }
      const sync = () => {
        cancel()
        if (!this.isConnected || document.hidden || !visible) return
        if (preference.matches) showPT()
        else tick(performance.now())
      }
      if (preference.matches) showPT()
      else draw(0, false)
      const observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting
        sync()
      })
      observer.observe(this)
      preference.addEventListener('change', sync)
      document.addEventListener('visibilitychange', sync)
      this.stop = () => {
        visible = false
        observer.disconnect()
        preference.removeEventListener('change', sync)
        document.removeEventListener('visibilitychange', sync)
        cancel()
      }
    }
    disconnectedCallback() { this.stop?.() }
  }
  customElements.define('pt-execution-mark', ExecutionMark)
})()
