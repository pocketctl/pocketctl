import type pg from 'pg'
import {sharedSourceHeadersEnabled,sessionTransportConsumerPolicyEnabled} from '../shared-source/headers.js'
import {readSessionTransportConsumerPolicy,recordSessionTransportBodyOmission} from '../shared-source/consumer-policy.js'
import {canonicalPayloadHash,canonicalSourceClassification} from '@pocketctl/session-source'
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
  sourceEventId: number | string
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
 * Legacy mode retains its single-statement append. Shared headers use a bounded
 * number of scalar SQL operations on the caller transaction, with no fan-out.
 * Replays retain the original identity/sequence, and JSONB normalization matches
 * the canonical events row. A failure must propagate to the transaction owner.
 */
export function createPostgresExtensionJournalSink(options:{sharedHeaders?:boolean;consumerPolicy?:boolean}={}): ExtensionJournalSink {
  if(options.consumerPolicy&&!options.sharedHeaders)throw Error('shared_session_transport_headers_required')
  return {
    async appendCanonicalEvent(client, input) {
      const payload=sanitizeJSONBPayload(input.payload)
      if(options.sharedHeaders && (!/^[1-9][0-9]{0,18}$/.test(String(input.sourceEventId)) || BigInt(input.sourceEventId)>9223372036854775807n
       || typeof input.sourceEventId==='number'&&!Number.isSafeInteger(input.sourceEventId)))throw Error('canonical_source_identity_invalid')
      if(!options.sharedHeaders){
        // Keep the native owner proof and append in one statement. Replays
        // still return the proof when the journal row already exists; an
        // unproved owner neither inserts nor silently succeeds.
        const proof=await client.query(`WITH canonical_owner AS MATERIALIZED (
          SELECT 1 AS valid FROM public.events WHERE id=$8::bigint AND user_id=$3
          AND logical_source_session_id=$4 AND event_type=$5 AND NOT owner_retired
          AND (public.native_event_authority(id,$3)->>'state'='current' OR
            (session_id=$4 AND NOT EXISTS(SELECT 1 FROM public.sessions WHERE session_id=$4)
              AND NOT EXISTS(SELECT 1 FROM public.session_aliases WHERE old_session_id=$4)
              AND NOT EXISTS(SELECT 1 FROM public.deleted_sessions WHERE session_id=$4)))
        ), appended AS (
          INSERT INTO extension_source_outbox
            (source_kind,source_id,owner_user_id,session_id,event_type,occurred_at,payload)
          SELECT $1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb FROM canonical_owner
          ON CONFLICT (source_kind, source_id) DO NOTHING RETURNING 1
        ) SELECT valid FROM canonical_owner`,
          [CANONICAL_EVENT_SOURCE_KIND,`event:${input.sourceEventId}`,input.ownerUserId,input.sessionId,
            input.eventType,input.occurredAt,JSON.stringify(payload),String(input.sourceEventId)])
        if(proof.rowCount!==1)throw Error('canonical_source_owner_retired_or_unknown')
        return
      }
      const payloadHash=canonicalPayloadHash(payload).toString('hex')
      let originalSequence:string|undefined
      if(options.sharedHeaders){
        const canonical=(await client.query(`SELECT source_header_version,source_sequence::text FROM public.events
          WHERE id=$1::bigint AND NOT owner_retired AND user_id=$2 AND logical_source_session_id=$3 AND event_type=$4
           AND (payload=$5::jsonb OR(body_storage='cold' AND payload IS NULL AND source_header_version=1 AND canonical_payload_hash=$6))
           AND ((session_id=$3 AND NOT EXISTS(SELECT 1 FROM public.session_aliases a WHERE a.old_session_id=$3)
             AND NOT EXISTS(SELECT 1 FROM public.deleted_sessions d WHERE d.session_id=$3)
             AND (NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.session_id=$3)
               OR public.native_session_authority($3,$2,NULL)->>'state'='current'))
            OR(public.native_session_authority($3,$2,NULL)->>'state'='current'
              AND public.native_session_authority($3,$2,NULL)->>'sessionId'=events.session_id))
           AND effect_status IN ('none','pending','completed') FOR UPDATE`,
          [String(input.sourceEventId),input.ownerUserId,input.sessionId,input.eventType,JSON.stringify(payload),payloadHash])).rows
        if(canonical.length!==1)throw Error('canonical_source_header_mismatch')
        const row=canonical[0]
        if(row.source_header_version!=null){
          if(row.source_header_version!==1 || !/^[1-9][0-9]{0,18}$/.test(row.source_sequence??'') || BigInt(row.source_sequence)>9223372036854775807n)throw Error('canonical_source_header_mismatch')
          originalSequence=row.source_sequence
        }else if(row.source_sequence!=null)throw Error('canonical_source_header_mismatch')
      }
      const persistHeader=async(sequence:string)=>{
        const hash=payloadHash
        const classification=canonicalSourceClassification({source_kind:'canonical_event',session_id:input.sessionId,source_seq:sequence,payload})
        if(Buffer.byteLength(JSON.stringify(classification))>65536)throw Error('canonical_source_header_limit')
        const saved=await client.query(`UPDATE public.events SET source_header_version=1,source_sequence=$6::bigint,
          canonical_payload_hash=$7,source_classification=$8::jsonb
          WHERE id=$1::bigint AND NOT owner_retired AND user_id=$2 AND logical_source_session_id=$3 AND event_type=$4
            AND(payload=$5::jsonb OR(body_storage='cold' AND payload IS NULL AND source_header_version=1 AND canonical_payload_hash=$7)) AND effect_status IN ('none','pending','completed')
            AND (source_header_version IS NULL OR (source_header_version=1 AND source_sequence=$6::bigint AND canonical_payload_hash=$7 AND source_classification=$8::jsonb))
          RETURNING id`,[String(input.sourceEventId),input.ownerUserId,input.sessionId,input.eventType,JSON.stringify(payload),sequence,hash,JSON.stringify(classification)])
        if(saved.rowCount!==1)throw Error('canonical_source_header_mismatch')
      }
      if(options.consumerPolicy){
        const policy=await readSessionTransportConsumerPolicy(client,input.ownerUserId)
        if(!policy.bodyRequired){
          // A pre-header legacy replay may already own a journal sequence.
          // Never allocate a replacement or overlook a conflicting old row.
          const old=(await client.query(`SELECT source_seq::text,
            owner_user_id=$2 AND session_id=$3 AND event_type=$4 AND payload=$5::jsonb AS matches
            FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1 FOR UPDATE`,
            [`event:${input.sourceEventId}`,input.ownerUserId,input.sessionId,input.eventType,JSON.stringify(payload)])).rows
          if(old.length>1||old.length===1&&(old[0].matches!==true||originalSequence!==undefined&&old[0].source_seq!==originalSequence))throw Error('canonical_source_header_mismatch')
          const sequence=originalSequence??old[0]?.source_seq??(await client.query("SELECT nextval(pg_get_serial_sequence('public.extension_source_outbox','source_seq')::regclass)::text AS source_seq")).rows[0]?.source_seq
          if(typeof sequence!=='string'||!/^[1-9][0-9]{0,18}$/.test(sequence)||BigInt(sequence)>9223372036854775807n)throw Error('canonical_source_header_mismatch')
          if(!originalSequence&&!old.length)await recordSessionTransportBodyOmission(client,input.ownerUserId)
          await persistHeader(sequence)
          return
        }
      }
      const inserted=await client.query(
        `INSERT INTO extension_source_outbox
           (source_kind, source_id, owner_user_id, session_id, event_type, occurred_at, payload${originalSequence?', source_seq':''})
         VALUES ($1, $2, $3, $4, $5, $6, $7${originalSequence?', $8::bigint':''})
         ON CONFLICT (source_kind, source_id) DO NOTHING${options.sharedHeaders?' RETURNING source_seq::text':''}`,
        [
          CANONICAL_EVENT_SOURCE_KIND,
          `event:${input.sourceEventId}`,
          input.ownerUserId,
          input.sessionId,
          input.eventType,
          input.occurredAt,
          JSON.stringify(payload),
          ...(originalSequence?[originalSequence]:[]),
        ],
      )
      if(options.sharedHeaders){
        // A replay keeps the original server sequence, never the sequence the
        // failed INSERT may have allocated. Match the complete trusted relation.
        const journal=(await client.query(`SELECT source_seq::text FROM public.extension_source_outbox
          WHERE source_kind='canonical_event' AND source_id=$1 AND owner_user_id=$2 AND session_id=$3 AND event_type=$4 AND payload=$5::jsonb`,
          [`event:${input.sourceEventId}`,input.ownerUserId,input.sessionId,input.eventType,JSON.stringify(payload)])).rows
        if(journal.length!==1 || !/^[1-9][0-9]{0,18}$/.test(journal[0].source_seq) || BigInt(journal[0].source_seq)>9223372036854775807n
          || inserted.rows.length && inserted.rows[0].source_seq!==journal[0].source_seq)throw Error('canonical_source_header_mismatch')
        await persistHeader(journal[0].source_seq)
      }
    },
  }
}

/** off injects no sink; shadow/enabled inject the PostgreSQL sink. */
export function createExtensionJournalSinkFromEnv(
  env: Record<string, string | undefined> = process.env,
): ExtensionJournalSink | null {
  const headers=sharedSourceHeadersEnabled(env),consumerPolicy=sessionTransportConsumerPolicyEnabled(env)
  const mode=extensionModeFromEnv(env)
  if(headers&&mode==='off')throw Error('shared_source_headers_require_journal')
  return mode==='off'?null:createPostgresExtensionJournalSink({sharedHeaders:headers,consumerPolicy})
}
