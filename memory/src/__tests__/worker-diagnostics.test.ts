import { describe, expect, test } from 'vitest'
import { workerErrorFields, workerErrorCode } from '../jobs/worker-diagnostics.js'
import { JobTerminalError } from '../jobs/types.js'

describe('safe worker diagnostics', () => {
  test('retains known projector and PostgreSQL failures without copying private fields', () => {
    expect(workerErrorCode(new Error('projection_source_changed'))).toBe('projection_source_changed')
    expect(workerErrorFields(Object.assign(new Error('private body'), {code:'40P01',detail:'secret'}))).toEqual({code:'postgres_error',sqlstate:'40P01'})
    const privateError=Object.assign(new Error('private body'),{code:'private/path',name:'secret name'})
    expect(workerErrorFields(privateError)).toEqual({code:'handler_failed_Error'})
  })
  test('distinguishes mapping and lock failures in canonical projection without exposing arbitrary details', () => {
    const categories = [
      'canonical_reference_mapping_required', 'canonical_reference_busy', 'canonical_reference_changed',
      'canonical_reference_conflict', 'canonical_reference_cursor_changed',
    ]
    for (const message of categories) {
      const error = Object.assign(new Error(message), { code: 'P0001', detail: 'private source metadata' })
      expect(workerErrorFields(error)).toEqual({ code: message })
    }
    expect(workerErrorFields(Object.assign(new Error('canonical_reference_mapping_required private'), {
      code: 'P0001', detail: 'private source metadata',
    }))).toEqual({ code: 'handler_failed_Error' })
  })
  test('bounds terminal codes and includes only validated job fence diagnostics', () => {
    expect(workerErrorCode(new JobTerminalError('codegraph_parse_timeout'))).toBe('handler_failed_codegraph_parse_timeout')
    expect(workerErrorCode(new JobTerminalError('private/path'))).toBe('handler_failed_terminal_error')
    const fields=workerErrorFields(new Error('private'),{job_id:'11111111-1111-4111-8111-111111111111',job_type:'project_feed',attempts:3,claim_epoch:5,payload:{text:'secret'}} as never)
    expect(fields).toEqual({code:'handler_failed_Error',job_id:'11111111-1111-4111-8111-111111111111',job_type:'project_feed',attempt:3,claim_epoch:5})
  })
})
