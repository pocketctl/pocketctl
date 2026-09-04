import type pg from 'pg'
import { sanitizeJSONBPayload } from '../jsonb-payload.js'
import { isAppReviewDemoSession } from '../config/app-review-demo.js'
import { extensionModeFromEnv } from './config.js'

/**
 * ADR-0003 transactional Source Journal. The sink writes exactly one
 * extension_source_outbox row per canonical event, inside the caller's
 * session-materialization transaction — never on its own connection, never
 * with a swallowed error, so journal failure rolls the canonical event back.
 */

export const CANONICAL_EVENT_SOURCE_KIND = 'canonical_event'

export interface ExtensionJournalAppendInput {
  sourceEventId: number
  ownerUserId: number
  sessionId: string
  eventType: string
  occurredAt: Date | null
  payload: Record<string, unknown>
}

export interface ExtensionJournalSink {
  appendCanonicalEvent(
    client: Pick<pg.PoolClient, 'query'>,
    input: ExtensionJournalAppendInput,
  ): Promise<void>
}

export type ExtensionJournalSkipReason =
  | 'skipped_no_owner'
  | 'skipped_no_session'
  | 'excluded_demo_data'

export interface ExtensionJournalEligibility {
  journal: boolean
  reason?: ExtensionJournalSkipReason
}

export interface ExtensionJournalEligibilityInput {
  ownerUserId: number | null
  /** Ledger-scoped session identity (synthetic quota-failure ids included). */
  ledgerSessionId: string
  /** Raw wire session id, used for the immutable demo prefix check. */
  sessionId?: string | null
  /** Persisted sessions.source, when the caller already holds the row. */
  sessionSource?: string | null
}

/**
 * Pure policy deciding whether a canonical event may enter the Source
 * Journal. App-review demo fixtures are explicitly unpublishable; events
 * without a ledger session have no session scope to project; a missing
 * owner is an authorization defect the write path must surface loudly.
 */
export function extensionJournalEligibility(
  input: ExtensionJournalEligibilityInput,
): ExtensionJournalEligibility {
  if (input.sessionSource === 'app_review_demo'
    || isAppReviewDemoSession(input.sessionId ?? null)) {
    return { journal: false, reason: 'excluded_demo_data' }
  }
  if (!input.ledgerSessionId) return { journal: false, reason: 'skipped_no_session' }
  if (input.ownerUserId === null) return { journal: false, reason: 'skipped_no_owner' }
  return { journal: true }
}

/** Raised when an ownable canonical event lacks a server-derived owner. */
export class ExtensionJournalOwnerMissingError extends Error {
  constructor() {
    super('canonical event has no server-derived owner for the extension journal')
    this.name = 'ExtensionJournalOwnerMissingError'
  }
}

/**
 * Single-statement O(1) journal append. ON CONFLICT DO NOTHING keeps dedup
 * replay a repair, never a duplication; the payload copy is sanitized through
 * the same JSONB policy as the canonical events row.
 */
export function createPostgresExtensionJournalSink(): ExtensionJournalSink {
  return {
    async appendCanonicalEvent(client, input) {
      await client.query(
        `INSERT INTO extension_source_outbox
           (source_kind, source_id, owner_user_id, session_id, event_type, occurred_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_kind, source_id) DO NOTHING`,
        [
          CANONICAL_EVENT_SOURCE_KIND,
          `event:${input.sourceEventId}`,
          input.ownerUserId,
          input.sessionId,
          input.eventType,
          input.occurredAt,
          JSON.stringify(sanitizeJSONBPayload(input.payload)),
        ],
      )
    },
  }
}

/** off injects no sink; shadow/enabled inject the PostgreSQL sink. */
export function createExtensionJournalSinkFromEnv(
  env: Record<string, string | undefined> = process.env,
): ExtensionJournalSink | null {
  return extensionModeFromEnv(env) === 'off'
    ? null
    : createPostgresExtensionJournalSink()
}
