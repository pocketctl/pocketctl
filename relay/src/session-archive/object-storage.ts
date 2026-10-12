import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { assertArchiveObjectKey, type ArchiveStorage } from './storage.js'
import { readArchiveObject } from './storage.js'
import { archiveSha256 } from './codec.js'
import { createHash } from 'node:crypto'

export interface PrivateObjectStorageConfig {
  bucket: string
  region: string
  endpoint?: string
  credentials?: S3ClientConfig['credentials']
  maxObjectBytes: number
  /** Local fixture exceptions are explicit and limited to the dedicated bucket. */
  localTest?: boolean
}

/** Service-side S3 adapter. Endpoints and keys must never come from requests. */
export class PrivateObjectArchiveStorage implements ArchiveStorage {
  private readonly client: S3Client
  readonly namespace: string
  constructor(private readonly config: PrivateObjectStorageConfig) {
    this.config = Object.freeze({ ...config })
    if (
      !config.bucket ||
      !config.region ||
      !Number.isSafeInteger(config.maxObjectBytes) ||
      config.maxObjectBytes < 1 ||
      config.maxObjectBytes > 128 * 1024 * 1024
    )
      throw new Error('invalid archive storage configuration')
    if (
      config.localTest &&
      config.bucket !== 'pocketctl-session-lifecycle-test'
    )
      throw new Error('dedicated test bucket required')
    if (config.endpoint) {
      let endpoint: URL
      try {
        endpoint = new URL(config.endpoint)
      } catch {
        throw new Error('invalid archive endpoint')
      }
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error('invalid archive endpoint')
      const local =
        config.localTest &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      if (config.localTest && !local)
        throw new Error('archive test endpoint must be loopback')
      if (
        endpoint.protocol !== 'https:' &&
        !(local && endpoint.protocol === 'http:')
      )
        throw new Error('archive endpoint requires TLS')
    } else if (config.localTest)
      throw new Error('explicit local test endpoint required')
    this.namespace = createHash('sha256').update(JSON.stringify([config.bucket,config.region,config.endpoint ? new URL(config.endpoint).href : null])).digest('hex')
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: config.credentials,
      forcePathStyle: config.localTest === true,
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 },
    })
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    assertArchiveObjectKey(key)
    if (!bytes.length || bytes.length > this.config.maxObjectBytes)
      throw new Error('archive object byte limit exceeded')
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: 'application/gzip',
          ACL: 'private',
          ...(this.config.localTest
            ? {}
            : { ServerSideEncryption: 'AES256' as const }),
          // New object identities are immutable; retries verify an existing object
          // rather than overwrite bytes referenced by a published manifest.
          IfNoneMatch: '*',
        }),
      )
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('name' in error) ||
        error.name !== 'PreconditionFailed'
      )
        throw error
      const existing = await readArchiveObject(
        this,
        key,
        this.config.maxObjectBytes,
      )
      if (archiveSha256(existing) !== archiveSha256(bytes))
        throw new Error('archive object immutable identity conflict')
    }
  }
  async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    assertArchiveObjectKey(key)
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    )
    const body = response.Body
    if (!body || !(Symbol.asyncIterator in body))
      throw new Error('archive object body unavailable')
    if ((response.ContentLength ?? 0) > this.config.maxObjectBytes) {
      if ('destroy' in body && typeof body.destroy === 'function')
        body.destroy()
      throw new Error('archive object byte limit exceeded')
    }
    const maximum = this.config.maxObjectBytes
    return (async function* () {
      let size = 0
      for await (const bytes of body as AsyncIterable<Uint8Array>) {
        size += bytes.length
        if (size > maximum)
          throw new Error('archive object byte limit exceeded')
        yield bytes
      }
    })()
  }
  async delete(key: string): Promise<void> {
    assertArchiveObjectKey(key)
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    )
  }
  close(): void {
    this.client.destroy()
  }
}
