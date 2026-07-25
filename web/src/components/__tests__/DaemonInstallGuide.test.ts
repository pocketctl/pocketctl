import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import DaemonInstallGuide from '../DaemonInstallGuide.vue'

describe('DaemonInstallGuide', () => {
  test('copies the complete two-step daemon setup command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(DaemonInstallGuide, {
      props: { installCommand: 'curl -fsSL https://example.com/install.sh | bash' },
    })

    expect(wrapper.text()).toContain('安装 Daemon')
    expect(wrapper.text()).toContain('启动服务')
    await wrapper.get('[data-action="copy-setup"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith(
      'curl -fsSL https://example.com/install.sh | bash\npocketctl daemon start',
    )
    expect(wrapper.text()).toContain('已复制')
  })
})
