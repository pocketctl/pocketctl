import { ContentStreamAssembler } from './contentStream'
import { contentDigest } from './contentDigest'

export type FileChangeKind = 'create' | 'update' | 'delete' | 'move'
export type FileChangeIntegrity = 'complete' | 'streaming' | 'verifying' | 'failed' | 'truncated'

export interface AgentFileChangeEdit {
  id: string
  eventId?: string
  streamId?: string
  changeSetId: string
  sequence: number
  changeIndex: number
  diff: string
  additions: number
  deletions: number
  integrity: FileChangeIntegrity
}

export interface AgentChangedFile {
  path: string
  kind: FileChangeKind
  movePath?: string
  additions: number
  deletions: number
  edits: AgentFileChangeEdit[]
}

export interface TurnFileChangeCard {
  turnId: string
  files: AgentChangedFile[]
  additions: number
  deletions: number
  selectedPath: string
}

export interface AgentFileChangeMessage {
  id: string
  type: 'agent_file_change'
  role: 'agent'
  fileChange: TurnFileChangeCard
}

export type AgentFileChangeAcceptResult = 'ignored' | 'inserted' | 'updated'

export interface AgentFileChangeReducer {
  accept(raw: Record<string, unknown>, target: AgentFileChangeMessage[]): AgentFileChangeAcceptResult
  resetTransientStreams(): void
}

interface NormalizedChange {
  sessionId: string
  turnId: string
  eventId?: string
  streamId?: string
  changeSetId: string
  sequence: number
  changeIndex: number
  path: string
  kind: FileChangeKind
  movePath?: string
  diff: string
  additions: number
  deletions: number
  chunkSequence?: number
  byteOffset: number
  final: boolean
  totalBytes?: number
  contentHash?: string
}

interface StreamRecord {
  target: AgentFileChangeMessage[]
  message: AgentFileChangeMessage
  file: AgentChangedFile
  edit: AgentFileChangeEdit
  eventId?: string
  contentHash?: string
}

interface EditFileMetadata {
  kind: FileChangeKind
  movePath?: string
}

const validKinds = new Set<FileChangeKind>(['create', 'update', 'delete', 'move'])

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function normalize(raw: Record<string, unknown>, fallbackSequence: number): NormalizedChange | null {
  const payload = raw.payload && typeof raw.payload === 'object'
    ? raw.payload as Record<string, unknown>
    : {}
  const event = { ...payload, ...raw }
  if ((event.type ?? event.event_type) !== 'agent_file_change') return null

  const turnId = stringValue(event.turn_id)
  const path = stringValue(event.path)
  const changeSetId = stringValue(event.change_set_id)
  const kind = event.change_kind as FileChangeKind
  const changeTotal = integerValue(event.change_total)
  const changeIndex = event.change_index === undefined ? 0 : integerValue(event.change_index)
  const additions = event.additions === undefined ? 0 : integerValue(event.additions)
  const deletions = event.deletions === undefined ? 0 : integerValue(event.deletions)
  if (!turnId || !turnId.trim() || !path || !path.trim() || !changeSetId || !changeSetId.trim() || !validKinds.has(kind) ||
      changeTotal === undefined || changeTotal <= 0 || changeIndex === undefined ||
      changeIndex < 0 || changeIndex >= changeTotal || additions === undefined || additions < 0 ||
      deletions === undefined || deletions < 0) return null

  const streamId = stringValue(event.stream_id)
  const eventId = stringValue(event.event_id)
  const rawSequence = integerValue(event.seq)
  if (!streamId && !eventId) return null
  if (!streamId && event.status !== undefined && event.status !== 'completed') return null

  let chunkSequence: number | undefined
  let byteOffset = 0
  if (streamId) {
    chunkSequence = integerValue(event.chunk_seq)
    const normalizedOffset = event.byte_offset === undefined ? 0 : integerValue(event.byte_offset)
    if (chunkSequence === undefined || chunkSequence < 0 || normalizedOffset === undefined || normalizedOffset < 0) return null
    byteOffset = normalizedOffset
  }

  const totalBytes = integerValue(event.total_bytes)
  return {
    sessionId: stringValue(event.session_id) ?? '',
    turnId,
    eventId,
    streamId,
    changeSetId,
    sequence: rawSequence === undefined || rawSequence < 0 ? fallbackSequence : rawSequence,
    changeIndex,
    path,
    kind,
    movePath: stringValue(event.move_path),
    diff: typeof event.diff === 'string' ? event.diff : '',
    additions,
    deletions,
    chunkSequence,
    byteOffset,
    final: event.final === true,
    totalBytes: totalBytes !== undefined && totalBytes >= 0 ? totalBytes : undefined,
    contentHash: stringValue(event.content_hash),
  }
}

function compareEdits(left: AgentFileChangeEdit, right: AgentFileChangeEdit): number {
  if (left.changeSetId === right.changeSetId) {
    return left.changeIndex - right.changeIndex || left.sequence - right.sequence || left.id.localeCompare(right.id)
  }
  return left.sequence - right.sequence || left.changeIndex - right.changeIndex || left.id.localeCompare(right.id)
}

function recalculate(
  message: AgentFileChangeMessage,
  editFileMetadata: WeakMap<AgentFileChangeEdit, EditFileMetadata>,
): void {
  for (const file of message.fileChange.files) {
    file.edits.sort(compareEdits)
    file.additions = file.edits.reduce((total, edit) => total + edit.additions, 0)
    file.deletions = file.edits.reduce((total, edit) => total + edit.deletions, 0)
    const displayMetadata = editFileMetadata.get(file.edits[file.edits.length - 1])
    if (displayMetadata) {
      file.kind = displayMetadata.kind
      file.movePath = displayMetadata.movePath
    }
  }
  message.fileChange.files.sort((left, right) =>
    compareEdits(left.edits[0], right.edits[0]) || left.path.localeCompare(right.path),
  )
  message.fileChange.additions = message.fileChange.files.reduce((total, file) => total + file.additions, 0)
  message.fileChange.deletions = message.fileChange.files.reduce((total, file) => total + file.deletions, 0)
  if (!message.fileChange.files.some(file => file.path === message.fileChange.selectedPath)) {
    message.fileChange.selectedPath = message.fileChange.files[0]?.path ?? ''
  }
}

export function createAgentFileChangeReducer(): AgentFileChangeReducer {
  let arrivalSequence = 0
  let resetGeneration = 0
  let assembler = createAssembler()
  const streams = new Map<string, StreamRecord>()
  const editFileMetadata = new WeakMap<AgentFileChangeEdit, EditFileMetadata>()

  function createAssembler(): ContentStreamAssembler {
    return new ContentStreamAssembler(8 * 1024 * 1024, {
      maxBufferedChunksPerStream: 128,
      maxBufferedBytes: 16 * 1024 * 1024,
      maxActiveStreams: 8,
      maxCompletedStreams: 2048,
    })
  }

  function findCompleted(target: AgentFileChangeMessage[], eventId: string): boolean {
    return target.some(message => message.type === 'agent_file_change' &&
      message.fileChange.files.some(file => file.edits.some(edit => edit.eventId === eventId)))
  }

  function ensureMessage(change: NormalizedChange, target: AgentFileChangeMessage[]) {
    let message = target.find(candidate =>
      candidate.type === 'agent_file_change' && candidate.fileChange.turnId === change.turnId,
    )
    const inserted = !message
    if (!message) {
      message = {
        id: `agent-file-change:${change.sessionId}:${change.turnId}`,
        type: 'agent_file_change',
        role: 'agent',
        fileChange: {
          turnId: change.turnId,
          files: [],
          additions: 0,
          deletions: 0,
          selectedPath: change.path,
        },
      }
      target.push(message)
    }
    let file = message.fileChange.files.find(candidate => candidate.path === change.path)
    if (!file) {
      file = {
        path: change.path,
        kind: change.kind,
        movePath: change.movePath,
        additions: 0,
        deletions: 0,
        edits: [],
      }
      message.fileChange.files.push(file)
    }
    return { message, file, inserted }
  }

  function discardStream(streamId: string): void {
    const record = streams.get(streamId)
    if (!record) return
    record.file.edits = record.file.edits.filter(edit => edit !== record.edit)
    if (record.file.edits.length === 0) {
      record.message.fileChange.files = record.message.fileChange.files.filter(file => file !== record.file)
    }
    if (record.message.fileChange.files.length === 0) {
      const index = record.target.indexOf(record.message)
      if (index >= 0) record.target.splice(index, 1)
    } else {
      recalculate(record.message, editFileMetadata)
    }
    streams.delete(streamId)
  }

  function verifyCompleted(record: StreamRecord, content: string): void {
    if (!record.contentHash) {
      record.edit.diff = ''
      record.edit.integrity = 'failed'
      return
    }
    const generation = resetGeneration
    void contentDigest(content).then(digest => {
      if (generation !== resetGeneration) return
      if (digest === record.contentHash) {
        record.edit.integrity = 'complete'
      } else {
        record.edit.diff = ''
        record.edit.integrity = 'failed'
      }
    }).catch(() => {
      if (generation !== resetGeneration) return
      record.edit.diff = ''
      record.edit.integrity = 'failed'
    })
  }

  function accept(raw: Record<string, unknown>, target: AgentFileChangeMessage[]): AgentFileChangeAcceptResult {
    const change = normalize(raw, 4_000_000_000_000_000 + (++arrivalSequence))
    if (!change) return 'ignored'

    if (!change.streamId) {
      if (!change.eventId || findCompleted(target, change.eventId)) return 'ignored'
      const { message, file, inserted } = ensureMessage(change, target)
      const edit: AgentFileChangeEdit = {
        id: change.eventId,
        eventId: change.eventId,
        changeSetId: change.changeSetId,
        sequence: change.sequence,
        changeIndex: change.changeIndex,
        diff: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        integrity: 'complete',
      }
      editFileMetadata.set(edit, { kind: change.kind, movePath: change.movePath })
      file.edits.push(edit)
      recalculate(message, editFileMetadata)
      return inserted ? 'inserted' : 'updated'
    }

    let record = streams.get(change.streamId)
    if (record && (record.target !== target || record.message.fileChange.turnId !== change.turnId ||
        record.file.path !== change.path || record.edit.changeSetId !== change.changeSetId ||
        record.edit.changeIndex !== change.changeIndex || record.edit.additions !== change.additions ||
        record.edit.deletions !== change.deletions)) return 'ignored'

    if (change.eventId && findCompleted(target, change.eventId)) {
      discardStream(change.streamId)
      return 'ignored'
    }

    const update = assembler.accept({
      streamId: change.streamId,
      sequence: change.chunkSequence!,
      byteOffset: change.byteOffset,
      content: change.diff,
      final: change.final,
      totalBytes: change.totalBytes,
    })
    if (!update || (!record && update.completed && !update.transitionedToComplete)) return 'ignored'

    let inserted = false
    if (!record) {
      const ensured = ensureMessage(change, target)
      inserted = ensured.inserted
      const edit: AgentFileChangeEdit = {
        id: change.streamId,
        streamId: change.streamId,
        changeSetId: change.changeSetId,
        sequence: change.sequence,
        changeIndex: change.changeIndex,
        diff: update.content,
        additions: change.additions,
        deletions: change.deletions,
        integrity: 'streaming',
      }
      editFileMetadata.set(edit, { kind: change.kind, movePath: change.movePath })
      ensured.file.edits.push(edit)
      record = { target, message: ensured.message, file: ensured.file, edit }
      streams.set(change.streamId, record)
    } else {
      record.edit.sequence = Math.min(record.edit.sequence, change.sequence)
      record.edit.diff = update.content
    }
    if (change.eventId) record.eventId = change.eventId
    if (change.contentHash) record.contentHash = change.contentHash

    if (update.completed) {
      record.edit.eventId = record.eventId
      record.edit.streamId = undefined
      record.edit.id = record.eventId ?? record.edit.id
      record.edit.diff = update.content
      if (!record.eventId) {
        record.edit.diff = ''
        record.edit.integrity = 'failed'
      } else if (update.truncated) {
        record.edit.integrity = 'truncated'
      } else {
        record.edit.integrity = 'verifying'
        verifyCompleted(record, update.content)
      }
      streams.delete(change.streamId)
    } else {
      record.edit.integrity = update.truncated ? 'truncated' : 'streaming'
    }
    recalculate(record.message, editFileMetadata)
    return inserted ? 'inserted' : 'updated'
  }

  return {
    accept,
    resetTransientStreams() {
      resetGeneration += 1
      for (const streamId of [...streams.keys()]) discardStream(streamId)
      assembler = createAssembler()
    },
  }
}
