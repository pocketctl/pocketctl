import { expect, test } from 'vitest'
import { deliveryFailureCode } from '../team/delivery-diagnostics.js'

test('projects only recognized failure codes, never arbitrary daemon output',()=>{
 expect(deliveryFailureCode('failed','delivery_http_503:source_busy')).toBe('delivery_http_503:source_busy')
 expect(deliveryFailureCode('failed','delivery_http_503:step_input_unavailable')).toBe('delivery_http_503:step_input_unavailable')
 expect(deliveryFailureCode('failed','step_input_artifact_integrity')).toBe('step_input_artifact_integrity')
 for(const reason of ['private /home/file token=secret','delivery_http_503:secret_token','step_input_secret',null])expect(deliveryFailureCode('failed',reason)).toBe('execution_failed')
 expect(deliveryFailureCode('completed','delivery_http_503:source_busy')).toBeNull()
})

test('preserves safe context diagnostics without guessing old failure reasons',()=>{
 expect(deliveryFailureCode('blocked','context_budget_exceeded')).toBe('context_budget_exceeded')
 expect(deliveryFailureCode('blocked','context_snapshot_unavailable')).toBe('context_snapshot_unavailable')
})
