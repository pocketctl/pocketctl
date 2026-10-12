import { randomUUID } from 'node:crypto'
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrivateObjectArchiveStorage } from '../session-archive/object-storage.js'
import {
  archiveObjectKey,
  readArchiveObject,
} from '../session-archive/storage.js'
import {
  encodeArchiveChunk,
  decodeArchiveChunk,
} from '../session-archive/codec.js'

const suite =
  process.env.RUN_SESSION_LIFECYCLE_OBJECTS === '1' ? describe : describe.skip
suite('private archive storage isolated MinIO', () => {
  let storage: PrivateObjectArchiveStorage, client: S3Client
  beforeAll(async () => {
    const endpoint = process.env.TEST_SESSION_LIFECYCLE_OBJECT_ENDPOINT
    if (!endpoint) throw new Error('explicit object test endpoint required')
    const url = new URL(endpoint)
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.protocol !== 'http:' ||
      url.port !== '18690' ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('dedicated loopback object fixture required')
    const bucket = process.env.TEST_SESSION_LIFECYCLE_OBJECT_BUCKET
    if (bucket !== 'pocketctl-session-lifecycle-test')
      throw new Error('dedicated object test bucket required')
    const credentials = {
      accessKeyId: 'lifecycle-test',
      secretAccessKey: 'lifecycle-test-only',
    }
    storage = new PrivateObjectArchiveStorage({
      endpoint,
      bucket,
      region: 'us-east-1',
      credentials,
      localTest: true,
      maxObjectBytes: 1_000_000,
    })
    client = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials,
      forcePathStyle: true,
      maxAttempts: 1,
    })
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)
      )
        throw error
    }
  }, 30_000)
  afterAll(() => {
    storage?.close()
    client?.destroy()
  })
  test('real put/read verification, immutable retry and repeated deletion', async () => {
    const binding = {
      userId: 1,
      sessionId: 'source',
      activityEpoch: '1',
      manifestId: randomUUID(),
      ordinal: 0,
    }
    const records = [
      { id: '1', eventType: 'agent_text', payload: { text: '冷正文' } },
    ]
    const limits = {
      maxRawBytes: 1_000_000,
      maxCompressedBytes: 1_000_000,
      maxRecords: 1000,
    }
    const encoded = await encodeArchiveChunk(binding, records, limits),
      key = archiveObjectKey(binding.manifestId, 0)
    try {
      await storage.put(key, encoded.bytes)
      await storage.put(key, encoded.bytes)
      const anonymous = await fetch(
        `${process.env.TEST_SESSION_LIFECYCLE_OBJECT_ENDPOINT}/${process.env.TEST_SESSION_LIFECYCLE_OBJECT_BUCKET}/${key}`,
      )
      expect(anonymous.status).toBe(403)
      const bytes = await readArchiveObject(
        storage,
        key,
        limits.maxCompressedBytes,
      )
      expect(
        await decodeArchiveChunk(bytes, encoded.manifest, binding, limits),
      ).toEqual(records)
      await expect(storage.put(key, Buffer.from('different'))).rejects.toThrow(
        'identity conflict',
      )
      await storage.delete(key)
      await storage.delete(key)
      await expect(
        readArchiveObject(storage, key, limits.maxCompressedBytes),
      ).rejects.toThrow()
    } finally {
      await storage.delete(key)
    }
  })
  test('missing object and invalid private identities fail without public fallbacks', async () => {
    await expect(
      storage.read(archiveObjectKey(randomUUID(), 0)),
    ).rejects.toThrow()
    await expect(
      storage.read('https://external.invalid/private'),
    ).rejects.toThrow('key')
    expect(
      () =>
        new PrivateObjectArchiveStorage({
          bucket: 'business',
          region: 'us-east-1',
          localTest: true,
          endpoint: 'http://127.0.0.1:18690',
          maxObjectBytes: 1000,
        }),
    ).toThrow('test bucket')
    expect(
      () =>
        new PrivateObjectArchiveStorage({
          bucket: 'business',
          region: 'us-east-1',
          endpoint: 'http://external.invalid',
          maxObjectBytes: 1000,
        }),
    ).toThrow('TLS')
  })
})
