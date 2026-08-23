import { describe, expect, it, vi } from 'vitest'

import { createWelcomeEmailSender, getWelcomeTemplateId } from '../email.js'

describe('getWelcomeTemplateId', () => {
  it('returns the configured template for each locale', () => {
    expect(getWelcomeTemplateId('zh')).toBe(204007)
    expect(getWelcomeTemplateId('en')).toBe(204008)
  })
})

describe('createWelcomeEmailSender', () => {
  it('sends the Chinese welcome template', async () => {
    const SendEmail = vi.fn().mockResolvedValue({ MessageId: 'mid-1' })
    const sendWelcomeEmail = createWelcomeEmailSender({ SendEmail })

    await expect(sendWelcomeEmail('user@example.com', 'zh')).resolves.toBe('mid-1')
    expect(SendEmail).toHaveBeenCalledWith(expect.objectContaining({
      FromEmailAddress: 'welcome@mail.pocketctl.me',
      Destination: ['user@example.com'],
      Subject: '欢迎使用 pocketctl',
      Template: {
        TemplateID: 204007,
        TemplateData: JSON.stringify({
          app_url: 'https://www.pocketctl.me/app/login',
          user_name: 'user@example.com',
        }),
      },
    }))
  })

  it('sends the English welcome template', async () => {
    const SendEmail = vi.fn().mockResolvedValue({ MessageId: 'mid-1' })
    const sendWelcomeEmail = createWelcomeEmailSender({ SendEmail })

    await expect(sendWelcomeEmail('user@example.com', 'en')).resolves.toBe('mid-1')
    expect(SendEmail).toHaveBeenCalledWith(expect.objectContaining({
      FromEmailAddress: 'welcome@mail.pocketctl.me',
      Destination: ['user@example.com'],
      Subject: 'Welcome to pocketctl',
      Template: {
        TemplateID: 204008,
        TemplateData: JSON.stringify({
          app_url: 'https://www.pocketctl.me/app/login',
          user_name: 'user@example.com',
        }),
      },
    }))
  })

  it('includes the request ID when Tencent omits the message ID', async () => {
    const SendEmail = vi.fn().mockResolvedValue({ RequestId: 'rid-1' })
    const sendWelcomeEmail = createWelcomeEmailSender({ SendEmail })

    await expect(sendWelcomeEmail('user@example.com', 'en')).rejects.toThrow('rid-1')
  })
})
