import type pg from 'pg'
import {canonicalJsonString, canonicalPayloadHash, SourceUnavailableError, type SourceRoot, type SourceScope, type SourceVersion} from '@pocketctl/session-source'
import {boundedSourceQuery} from './bounded-source-query.js'

interface Scan {
  keys: string[]
  through: string
  scannedThrough: string | null
  version: SourceVersion
}

const decimal = (value: unknown): value is string => typeof value === 'string'
  && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n

/** The v1 cursor still names a fully inspected prefix. Older workers can
 * resume it with the ordinary reader under the same exact source version. */
export async function scanRelayProjectionPage(pool: pg.Pool, scope: SourceScope, root: SourceRoot, cursor: string | undefined, limit: number) {
  const scopeHash = canonicalPayloadHash({scope, root}).toString('hex')
  let prior: {after: string; version: SourceVersion; through?: string} | undefined
  if (cursor !== undefined) {
    try {
      if (cursor.length > 8192) throw Error()
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (decoded.v !== 1 || decoded.scope !== scopeHash || !decimal(decoded.after)
        || !['content','authorization','storage'].every(k => decimal(decoded.version?.[k]))
        || (decoded.through !== undefined && (!decimal(decoded.through) || BigInt(decoded.after) > BigInt(decoded.through)))) throw Error()
      prior = decoded
    } catch { throw new SourceUnavailableError('cursor_scope_mismatch') }
  }
  let scan: Scan
  try {
    const result = await boundedSourceQuery(pool,
      'SELECT shared.scan_memory_relay_projection_page($1::jsonb,$2,$3::bigint,$4) AS scan',
      [scope, root.key, prior?.after ?? null, limit])
    scan = result.rows[0].scan
  } catch (error) {
    const code = (error as {code?: string}).code
    const message = (error as Error).message
    if (code === '57014' || message === 'source_query_deadline_exceeded') throw new SourceUnavailableError('source_store_timeout')
    if (['55P03','40001','40P01'].includes(code ?? '')) throw new SourceUnavailableError('source_store_busy')
    for (const state of ['revoked','deleted','changed']) if (message === 'source_' + state) throw new SourceUnavailableError(state)
    if (message === 'source_input_start_unproven') throw new SourceUnavailableError('source_input_start_unproven')
    throw new SourceUnavailableError('source_store_unavailable')
  }
  if (!scan?.version || ![scan.version.content, scan.version.authorization, scan.version.storage].every(decimal)
    || !decimal(scan.through) || !Array.isArray(scan.keys) || scan.keys.length > limit) {
    throw new SourceUnavailableError('source_metadata_conflict')
  }
  if (prior && (canonicalJsonString(scan.version) !== canonicalJsonString(prior.version)
    || (prior.through !== undefined && scan.through !== prior.through))) throw new SourceUnavailableError('changed')

  const after = BigInt(prior?.after ?? 0)
  const upper = BigInt(scan.through)
  if (scan.scannedThrough === null) {
    if (after !== upper || scan.keys.length) throw new SourceUnavailableError('source_metadata_conflict')
    return {keys: scan.keys, version: scan.version}
  }
  if (!decimal(scan.scannedThrough)) throw new SourceUnavailableError('source_metadata_conflict')
  const last = BigInt(scan.scannedThrough)
  if (last <= after || last > upper) throw new SourceUnavailableError('source_metadata_conflict')
  let previous = after
  for (const key of scan.keys) {
    if (!decimal(key) || BigInt(key) <= previous || BigInt(key) > last) throw new SourceUnavailableError('source_metadata_conflict')
    previous = BigInt(key)
  }
  const nextCursor = last < upper
    ? Buffer.from(canonicalJsonString({v:1, scope:scopeHash, after:scan.scannedThrough, through:scan.through, version:scan.version})).toString('base64url')
    : undefined
  return {keys: scan.keys, version: scan.version, nextCursor}
}
