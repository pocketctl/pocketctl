import { Readable } from 'node:stream'

export interface ArchiveStorage {
  readonly namespace?: string
  put(key: string, bytes: Buffer): Promise<void>
  read(key: string): Promise<AsyncIterable<Uint8Array>>
  delete(key: string): Promise<void>
}
export function archiveObjectKey(manifestId: string, ordinal: number): string {
  if (
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(manifestId) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  )
    throw new Error('invalid archive object identity')
  return `session-archive/v1/${manifestId.toLowerCase()}/${ordinal}.gz`
}
export function assertArchiveObjectKey(key: string): void {
  if (
    !/^session-archive\/v1\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/\d+\.gz$/.test(
      key,
    )
  ) {
    throw new Error('invalid archive object key')
  }
}
export async function readArchiveObject(
  storage: ArchiveStorage,
  key: string,
  maximum: number,
): Promise<Buffer> {
  assertArchiveObjectKey(key)
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error('invalid archive byte limit')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of await storage.read(key)) {
    length += chunk.length
    if (length > maximum) throw new Error('archive byte limit exceeded')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, length)
}
/** Isolated fixtures only. Never instantiate as a production fallback. */
export class MemoryArchiveStorage implements ArchiveStorage {
  private readonly objects = new Map<string, Buffer>()
  async put(key: string, bytes: Buffer): Promise<void> {
    assertArchiveObjectKey(key)
    this.objects.set(key, Buffer.from(bytes))
  }
  async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    assertArchiveObjectKey(key)
    const value = this.objects.get(key)
    if (!value) throw new Error('archive object missing')
    return Readable.from([Buffer.from(value)])
  }
  async delete(key: string): Promise<void> {
    assertArchiveObjectKey(key)
    this.objects.delete(key)
  }
}
