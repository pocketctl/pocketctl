import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import McpElicitationCard from '../McpElicitationCard.vue'

describe('McpElicitationCard', () => {
  test('renders and submits typed form values in schema order', async () => {
    const wrapper = mount(McpElicitationCard, { props: { message: {
      type: 'mcp_elicitation_request', request_id: 'mcp_1', status: 'pending', mcpServer: 'github',
      elicitationMode: 'form', message: 'Configure request',
      elicitationSchema: { type: 'object', required: ['repo', 'retries'], properties: {
        repo: { type: 'string', title: 'Repository', minLength: 2 },
        retries: { type: 'integer', title: 'Retries', minimum: 1, maximum: 5 },
        dryRun: { type: 'boolean', title: 'Dry run' },
        regions: { type: 'array', title: 'Regions', items: { type: 'string', enum: ['us', 'eu'] }, minItems: 1 },
      } },
    }, disabled: false } })
    const inputs = wrapper.findAll('input')
    await inputs.find(input => input.attributes('data-field') === 'repo')!.setValue('pocketctl')
    await inputs.find(input => input.attributes('data-field') === 'retries')!.setValue('2')
    await inputs.find(input => input.attributes('data-field') === 'dryRun')!.setValue(true)
    await inputs.find(input => input.attributes('data-option') === 'us')!.setValue(true)
    await wrapper.get('button.submit').trigger('click')
    expect(wrapper.emitted('respond')?.[0]).toEqual([
      expect.objectContaining({ request_id: 'mcp_1' }), 'accept',
      { repo: 'pocketctl', retries: 2, dryRun: true, regions: ['us'] },
    ])
  })

  test('renders URL mode and decline/cancel actions', async () => {
    const message = { type: 'mcp_elicitation_request', request_id: 'mcp_url', status: 'pending', elicitationMode: 'url', url: 'https://example.test/auth' }
    const wrapper = mount(McpElicitationCard, { props: { message, disabled: false } })
    expect(wrapper.get('a').attributes('href')).toBe(message.url)
    await wrapper.get('button.decline').trigger('click')
    expect(wrapper.emitted('respond')?.[0]).toEqual([message, 'decline', undefined])
  })

  test('normalizes date-time and enforces upper form bounds before sending', async () => {
    const wrapper = mount(McpElicitationCard, { props: { message: {
      type: 'mcp_elicitation_request', request_id: 'mcp_bounds', status: 'pending', elicitationMode: 'form',
      elicitationSchema: { type: 'object', properties: {
        label: { type: 'string', maxLength: 3 },
        score: { type: 'number', maximum: 10 },
        when: { type: 'string', format: 'date-time' },
      } },
    } } })
    const inputs = wrapper.findAll('input')
    await inputs.find(input => input.attributes('data-field') === 'label')!.setValue('long')
    await inputs.find(input => input.attributes('data-field') === 'score')!.setValue('11')
    await inputs.find(input => input.attributes('data-field') === 'when')!.setValue('2026-07-18T08:00')
    await wrapper.get('button.submit').trigger('click')
    expect(wrapper.emitted('respond')).toBeUndefined()

    await inputs.find(input => input.attributes('data-field') === 'label')!.setValue('ok')
    await inputs.find(input => input.attributes('data-field') === 'score')!.setValue('10')
    await wrapper.get('button.submit').trigger('click')
    expect(wrapper.emitted('respond')?.[0]?.[2]).toEqual({
      label: 'ok', score: 10, when: new Date('2026-07-18T08:00').toISOString(),
    })
  })
})
