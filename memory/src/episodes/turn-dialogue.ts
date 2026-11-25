import { createHash } from 'node:crypto'
import type pg from 'pg'
import {
  canonicalPayloadHash,
  parseMemorySourceProvenance,
  canonicalJsonString,
  type SourceScope,
  type SourceVersion,
} from '@pocketctl/session-source'
import { createObservedSourceReader } from '../sources/observed-reader.js'
import { sourcePoolContext } from '../sources/pool-context.js'
import type { PreparedEvent } from '../sources/prepared-sources.js'
import { JobDeferredError } from '../jobs/types.js'

import { isOperationalDialogueText } from './dialogue-operation.js'

type Db = Pick<pg.Pool, 'query'>
type Header = Record<string, unknown>
export type Member = {
  id: string
  kind: string
  at: Date
  hash: string
  header: Header
  proof: Header | null
}
type Context = { scope: SourceScope; root: string; version: SourceVersion }
export type DialogueRef = {
  kind: 'relay_turn_v1'
  session: string
  turn: string
  members: string
  event: string
  eventHash: string
  stream?: string
  textSha256?: string
  partCount?: number
}
export class DialogueReadDisposition extends Error {
  assertCurrent?: (db: Db) => Promise<void>
  constructor(readonly reason: string) {
    super(reason)
  }
}
export interface DialogueGapProbe { previous: unknown; stabilizationMs: number }
export class DialogueInputGap extends DialogueReadDisposition {
  // Saved only by a fenced compile job. "inspect" requests one bounded
  // fallback; a reason and digest identify a previously confirmed gap.
  probeResult?: string
  inspectAt?: Date
}
export class DialogueExcluded extends DialogueReadDisposition {
  constructor() {
    super('operational_turn')
  }
}
const gap = (reason: string) => new DialogueInputGap(reason)
const waitForInput = () => new JobDeferredError('source_not_ready', new Date(Date.now() + 5 * 60_000))
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const metadata = async (db: Db, install: string, session: string, turn: string) => {
  const { rows } = await db.query<Member>(
    'SELECT * FROM shared.memory_dialogue_members($1,$2,$3) ORDER BY id::bigint,kind',
    [install, session, turn],
  )
  const signature = digest(
    canonicalJsonString(
      rows.map((r) => [r.id, r.kind, r.hash, r.header, r.proof, new Date(r.at).toISOString()]),
    ),
  )
  return { rows, signature }
}
async function context(db: Db, install: string, session: string): Promise<Context> {
  const row = (await db.query('SELECT shared.memory_dialogue_context($1,$2) AS context', [install, session]))
    .rows[0]
  if (!row?.context) throw gap('source_reference_unavailable')
  return row.context
}
export async function checkDialogueRef(db: Db, install: string, ref: DialogueRef, lock: boolean) {
  const ctx = await context(db, install, ref.session)
  const { rows, signature } = await metadata(db, install, ref.session, ref.turn)
  if (
    rows.some((r) => r.kind === 'operation') ||
    signature !== ref.members ||
    !rows.some((r) => r.id === ref.event && r.hash === ref.eventHash && r.kind !== 'control')
  )
    throw Error('source_reference_changed')
  if (
    lock &&
    !(
      await db.query("SELECT shared.lock_memory_personal_source_commit($1,'relay_event',$2,$3,FALSE) AS ok", [
        ctx.scope,
        ctx.root,
        ctx.version,
      ])
    ).rows[0]?.ok
  )
    throw Error('source_reference_changed')
}
function messageGroups(rows: Member[]) {
  const messages = new Map<string, Member[]>()
  for (const r of rows) {
    if (r.kind !== 'user_text' && r.kind !== 'agent_text') continue
    const h = r.header
    const key = r.kind + ':' + (h.part_id || h.message_id || h.stream_id || h.event_id || r.id)
    const list = messages.get(key) ?? []
    list.push(r)
    messages.set(key, list)
  }
  const groups: { anchor: Member; parts: Member[] }[] = []
  const finalMessageIds = new Set(
    rows
      .filter((r) => r.header.message_phase === 'final_answer' && r.header.dialogue_message_id)
      .map((r) => r.header.dialogue_message_id),
  )
  for (const list of messages.values()) {
    const final = list
      .filter(
        (r) =>
          (r.kind === 'user_text' ||
            r.header.message_phase === 'final_answer' ||
            finalMessageIds.has(r.header.dialogue_message_id)) &&
          (!r.header.stream_id || r.header.final === true),
      )
      .sort((a, b) => Number(a.header.revision ?? 0) - Number(b.header.revision ?? 0))
      .at(-1)
    if (!final) {
      if (list[0].kind === 'user_text' || list.some((r) => r.header.message_phase === 'final_answer'))
        throw gap('message_incomplete')
      continue
    }
    groups.push({
      anchor: final,
      parts: final.header.stream_id
        ? list.filter((r) => r.header.stream_id === final.header.stream_id)
        : [final],
    })
  }
  return groups
}
export function selectDialogue(rows: Member[]) {
  const terminal = rows
    .filter(
      (r) =>
        r.kind === 'turn_status' &&
        ['completed', 'interrupted', 'failed', 'abandoned'].includes(String(r.header.turn_status)),
    )
    .at(-1)
  if (!terminal) throw gap('terminal_unavailable')
  const groups = messageGroups(rows)
  const answers = new Set(
    groups
      .filter((g) => g.anchor.kind === 'agent_text')
      .map(
        ({ anchor: r }) => r.header.dialogue_message_id || r.header.message_id || r.header.part_id || r.id,
      ),
  ).size
  if (!groups.some((g) => g.anchor.kind === 'user_text')) throw gap('prompt_unavailable')
  if (answers > 1 || (!answers && terminal.header.turn_status === 'completed'))
    throw gap('final_message_unconfirmed')
  return { terminal, groups }
}
function selectDialogueHeaders(rows: Member[]) {
  try {
    const selection = selectDialogue(rows)
    // The final sequence is zero-indexed: an incomplete inventory cannot
    // produce a valid answer. The reader still checks offsets, bytes and hash.
    const missingParts = selection.groups.some(({ anchor, parts }) =>
      anchor.kind === 'agent_text' && anchor.header.stream_id &&
      typeof anchor.header.chunk_seq === 'number' && anchor.header.chunk_seq + 1 !== parts.length)
    return missingParts ? gap('message_incomplete') : selection
  } catch (error) {
    if (error instanceof DialogueInputGap) return error
    throw error
  }
}

export function readDialogueText(anchor: Member, parts: Member[], bodies: Map<string, Header>) {
  const body = bodies.get(anchor.id)
  if (!body) throw gap('message_incomplete')
  if (!anchor.header.stream_id) {
    const text = body.snapshot || body.text
    if (typeof text !== 'string' || !text) throw gap('message_incomplete')
    return text
  }
  const ordered = [...parts].sort((a, b) => Number(a.header.chunk_seq) - Number(b.header.chunk_seq))
  let bytes = 0
  const text = ordered
    .map((r, i) => {
      const part = bodies.get(r.id)?.text ?? ''
      if (typeof part !== 'string' || r.header.chunk_seq !== i || r.header.byte_offset !== bytes)
        throw gap('message_incomplete')
      bytes += Buffer.byteLength(part)
      return part
    })
    .join('')
  const hash = String(anchor.header.content_hash)
  if (
    ordered.at(-1)?.id !== anchor.id ||
    bytes !== anchor.header.total_bytes ||
    !/^([a-f0-9]{16}|[a-f0-9]{32}|[a-f0-9]{64})$/.test(hash) ||
    !digest(text).startsWith(hash)
  )
    throw gap('message_incomplete')
  return text
}
// The terminal producer certifies the inventory of one completed native turn.
// Relay independently authenticates the accepted dispatch and stamps its sequence.
// Bind both identities and reassembled bytes before using the terminal as evidence.
export function certifiedCodexDialogue(
  terminal: Member,
  messages: Member[],
  texts: ReadonlyMap<string, string>,
  unsafe: ReadonlySet<unknown>,
  session: string,
  turn: string,
) {
  const cert = parseMemorySourceProvenance(terminal.proof)
  if (
    !cert || cert.producer !== 'codex' || cert.source_role !== 'system' ||
    cert.session_id !== session || cert.turn_id !== turn || terminal.header.turn_status !== 'completed' ||
    !cert.event_id.startsWith('codex-dialogue-v1:') || !/^dialogue:[a-f0-9]{64}$/.test(cert.invocation_id) ||
    !cert.lineage_complete || cert.skill_state !== 'non_skill' || cert.skill_invocation_id ||
    cert.derived_from_event_ids.length !== 1 || unsafe.has(cert.invocation_id)
  ) return

  const prompts = messages.filter(m => m.kind === 'user_text')
  const answers = messages.filter(m => m.kind === 'agent_text')
  const roots = prompts.filter(m => m.proof?.event_id === cert.derived_from_event_ids[0])
  if (roots.length !== 1 || prompts.length > 2 || answers.length !== 1) return
  const prompt = roots[0]
  const answer = answers[0]
  const root = parseMemorySourceProvenance(prompt.proof)
  if (
    !root || root.producer !== 'codex' || root.session_id !== session || root.turn_id !== turn ||
    !/^input:[a-f0-9]{64}$/.test(root.event_id) || root.invocation_id !== root.event_id ||
    root.source_role !== 'user' || root.skill_state !== 'non_skill' || !root.lineage_complete ||
    root.skill_invocation_id || root.parent_invocation_id || root.derived_from_event_ids.length ||
    (root.accepted_input_event_id !== undefined && root.accepted_input_event_id !== root.event_id) ||
    (cert.accepted_input_event_id !== undefined && cert.accepted_input_event_id !== root.event_id) ||
    unsafe.has(root.invocation_id) || cert.parent_invocation_id !== root.invocation_id ||
    BigInt(cert.sequence) <= BigInt(root.sequence)
  ) return
  const promptText = texts.get(prompt.id)
  const answerText = texts.get(answer.id)
  if (!promptText || !answerText || typeof answer.header.part_id !== 'string' ||
      answer.header.message_phase !== 'final_answer') return
  const fingerprint = digest([
    session, turn, root.event_id, cert.invocation_id, digest(promptText), digest(answer.header.part_id), digest(answerText),
  ].join('\0'))
  if (cert.event_id !== 'codex-dialogue-v1:' + fingerprint) return
  const echo = prompts.find(m => m !== prompt)
  if (echo && (typeof echo.header.part_id !== 'string' ||
      'dialogue:' + digest(echo.header.part_id) !== cert.invocation_id || texts.get(echo.id) !== promptText)) return
  // The raw answer locator still identifies the content. The terminal sequence
  // identifies the later producer observation which established its lineage.
  return {echo: echo?.id, answer: answer.id, proof: {...cert, source_role: 'assistant' as const}}
}

export async function prepareDialogue(pool: pg.Pool, install: string, session: string, turn: string,
  gapProbe?: DialogueGapProbe,
) {
  const ctx = await context(pool, install, session),
    root = { kind: 'relay_event' as const, key: ctx.root }
  const { rows, signature } = await metadata(pool, install, session, turn)
  try {
    if (rows.some((r) => r.kind === 'operation')) throw new DialogueExcluded()
    const selection = selectDialogueHeaders(rows)
    if (gapProbe) {
      // A previous fenced fallback checked the exact same authenticated members.
      // A changed prompt, reply, stream or control marker changes the signature.
      if (typeof gapProbe.previous === 'string' && gapProbe.previous.startsWith(signature + ':')) {
        const reason = gapProbe.previous.slice(signature.length + 1)
        if (['message_incomplete', 'final_message_unconfirmed', 'prompt_unavailable', 'terminal_unavailable'].includes(reason))
          throw gap(reason)
      }
      if (selection instanceof DialogueInputGap && gapProbe.previous !== 'inspect' &&
          rows.some(r => r.kind === 'user_text') &&
          (selection.reason === 'final_message_unconfirmed' || selection.reason === 'message_incomplete')) {
        const now = Date.now()
        const latest = rows.reduce((last, row) => Math.max(last, new Date(row.at).getTime()), 0)
        const due = Math.min(latest, now) + gapProbe.stabilizationMs
        if (due > now) {
          selection.probeResult = 'inspect'
          selection.inspectAt = new Date(due)
          throw selection
        }
      }
    }
    const reader = createObservedSourceReader(pool, sourcePoolContext(pool).archive, turn)
    const bodies = new Map<string, Header>()
    async function loadBodies(parts: Member[]) {
      for (let start = 0; start < parts.length; start += 256) {
        const batch = parts.slice(start, start + 256)
        const page = await reader.getHeads(
          ctx.scope,
          root,
          batch.map((r) => r.id),
        )
        if (canonicalJsonString(page.version) !== canonicalJsonString(ctx.version)) throw waitForInput()
        const expected = new Map(batch.map((r) => [r.id, r.hash]))
        for (const b of await reader.resolveBodies(ctx.scope, root, [...page.heads], page.version)) {
          if (expected.get(b.head.canonicalKey) !== b.head.contentHash) throw waitForInput()
          bodies.set(b.head.canonicalKey, b.payload as Header)
        }
      }
    }
    // In a complete turn (or the single fallback), classify prompts before
    // reading any answer. Text-only operational requests never become gaps.
    const prompts = selection instanceof DialogueInputGap
      ? messageGroups(rows.filter(r => r.kind === 'user_text'))
      : selection.groups.filter(g => g.anchor.kind === 'user_text')
    await loadBodies(prompts.flatMap((group) => group.parts))
    const texts = new Map<string, string>()
    for (const { anchor, parts } of prompts) {
      const text = readDialogueText(anchor, parts, bodies)
      if (isOperationalDialogueText(text, 'user')) throw new DialogueExcluded()
      texts.set(anchor.id, text)
    }
    if (selection instanceof DialogueInputGap) throw selection
    const { terminal, groups } = selection
    const answers = groups.filter((group) => group.anchor.kind === 'agent_text')
    await loadBodies(answers.flatMap((group) => group.parts))
    for (const { anchor, parts } of answers) {
      const text = readDialogueText(anchor, parts, bodies)
      if (isOperationalDialogueText(text, 'assistant')) throw new DialogueExcluded()
      texts.set(anchor.id, text)
    }
    const makeRef = (row: Member): DialogueRef => ({
      kind: 'relay_turn_v1',
      session,
      turn,
      members: signature,
      event: row.id,
      eventHash: row.hash,
    })
    const unsafeInvocations = new Set(
      rows.filter((r) => r.kind === 'control').map((r) => r.proof?.invocation_id),
    )
    const certified = certifiedCodexDialogue(terminal, groups.map(g => g.anchor), texts, unsafeInvocations, session, turn)
    const events: PreparedEvent[] = groups.filter(g => g.anchor.id !== certified?.echo).map(({ anchor, parts }) => {
      const text = texts.get(anchor.id)!,
        payload = { text },
        ref: DialogueRef = {
          ...makeRef(anchor),
          textSha256: digest(text),
          partCount: parts.length,
          ...(typeof anchor.header.stream_id === 'string' ? { stream: anchor.header.stream_id } : {}),
        }
      // Task span handles remain UUID-shaped. Raw identities always live in the locator.
      const hex = digest(install + ':relay:' + anchor.id)
      const id = [
        hex.slice(0, 8),
        hex.slice(8, 12),
        '5' + hex.slice(13, 16),
        'a' + hex.slice(17, 20),
        hex.slice(20, 32),
      ].join('-')
      const native = certified?.answer === anchor.id ? certified.proof : anchor.proof
      const valid =
        native &&
        !unsafeInvocations.has(native.invocation_id) &&
        (anchor.kind === 'user_text'
          ? native.source_role === 'user'
          : ['assistant', 'summary'].includes(String(native.source_role)))
      // Keep an existing negative producer proof and its invocation identity.
      // Null loses the distinction between absent evidence and an unsafe sibling.
      const memory = valid || !native ? native : {
        ...native, lineage_complete: false, skill_state: native.skill_state === 'skill' ? 'skill' : 'unknown',
      }
      return {
        source_event_id: id,
        installation_id: install,
        session_id: session,
        turn_id: turn,
        origin: 'canonical',
        origin_position: anchor.id,
        event_type: anchor.kind,
        occurred_at: new Date(anchor.at),
        payload_hash: canonicalPayloadHash(payload),
        classification: {},
        source_provenance: { memory, dialogue: ref },
        body_reclaimed_at: null,
        row_version: signature,
        payload,
      }
    })
    const ref = makeRef(terminal)
    return {
      events,
      ref,
      terminal,
      assertCurrent: (db: Db, options?: { forCommit?: boolean }) =>
        checkDialogueRef(db, install, ref, options?.forCommit === true),
    }
  } catch (error) {
    if (error instanceof DialogueInputGap && gapProbe && !error.probeResult) {
      const checked = signature + ':' + error.reason
      if (gapProbe.previous !== checked) error.probeResult = checked
    }
    if (error instanceof DialogueReadDisposition)
      error.assertCurrent = async (db) => {
        const current = await metadata(db, install, session, turn)
        if (current.signature !== signature) throw waitForInput()
        const lock = await db.query(
          "SELECT shared.lock_memory_personal_source_commit($1,'relay_event',$2,$3,FALSE) AS ok",
          [ctx.scope, ctx.root, ctx.version],
        )
        if (!lock.rows[0]?.ok) throw waitForInput()
      }
    throw error
  }
}
