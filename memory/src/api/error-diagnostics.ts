import type { FastifyInstance } from 'fastify'
import { createMemoryLogger } from '../logging.js'
import { MemoryApiError } from './errors.js'

// Fixed classifications only: Error.message/name/stack and pg detail/query
// may contain credentials or source content and must never reach this log.
const DATABASE_CODES = new Set(['23502', '23503', '23505', '23514', '40001', '40P01', '55P03', '57014', '53300', '08006', '42P01', '42703'])

export function registerApiErrorDiagnostics(app: FastifyInstance, sink?: (line: string) => void): void {
  const logger = createMemoryLogger('error', sink)
  app.addHook('onError', async (request, _reply, error) => {
    if (error instanceof MemoryApiError || (typeof error.statusCode === 'number' && error.statusCode < 500)) return
    const rawCode = (error as Error & { code?: unknown }).code
    const databaseCode = typeof rawCode === 'string' && DATABASE_CODES.has(rawCode) ? rawCode : null
    const route = request.routeOptions.url ?? ''
    const surface = route.startsWith('/api/v1/memory/governance/') ? 'governance'
      : route.startsWith('/api/v1/memory/context/') ? 'context' : 'memory_api'
    logger.log('error', 'api_unexpected_error', {
      surface,
      error_class: databaseCode ? 'database_error' : error instanceof TypeError ? 'type_error'
        : error instanceof RangeError ? 'range_error' : error instanceof SyntaxError ? 'syntax_error'
          : error instanceof ReferenceError ? 'reference_error' : 'error',
      database_code: databaseCode,
    })
  })
}
