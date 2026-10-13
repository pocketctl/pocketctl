import type pg from 'pg'
import { PrivateObjectArchiveStorage } from '../session-archive/object-storage.js'
import { FilesystemArchiveStorage } from '../session-archive/filesystem-storage.js'
import type { ArchiveStorage } from '../session-archive/storage.js'
import type { SessionLifecycleConfig } from '../session-lifecycle/types.js'
import { installPostgresHistoryBodyReader } from './postgres-reader.js'
import { installDocumentBodyReader } from '../session-documents/body-reader.js'
const configuredStores=new WeakMap<object,ArchiveStorage>()
export function configuredArchiveStorage(db:object):ArchiveStorage|undefined{return configuredStores.get(db)}

/** Reading published bodies is independent of whether new maintenance is on. */
export function createConfiguredArchiveStorage(config: SessionLifecycleConfig, env: Record<string,string|undefined> = process.env): ArchiveStorage | undefined {
  if (config.storageDriver === 'filesystem') {
    if (!config.archiveDirectory) return undefined
    // Reject ambiguous configurations; switching backends must be deliberate.
    if (config.objectBucket || config.objectRegion || env.SESSION_LIFECYCLE_OBJECT_ENDPOINT || env.SESSION_LIFECYCLE_OBJECT_ACCESS_KEY || env.SESSION_LIFECYCLE_OBJECT_SECRET_KEY || (env.SESSION_LIFECYCLE_OBJECT_LOCAL_TEST && env.SESSION_LIFECYCLE_OBJECT_LOCAL_TEST !== 'off'))
      throw new Error('conflicting lifecycle storage configuration')
    return new FilesystemArchiveStorage(config.archiveDirectory, config.maxCompressedBytes, config.filesystemMinFreeBytes)
  }
  if (config.archiveDirectory) throw new Error('archive directory requires filesystem driver')
  const endpoint = env.SESSION_LIFECYCLE_OBJECT_ENDPOINT
  const localFlag = env.SESSION_LIFECYCLE_OBJECT_LOCAL_TEST ?? 'off'
  if (!['off','on'].includes(localFlag)) throw new Error('invalid archive local test flag')
  if (!config.objectBucket && !config.objectRegion && !endpoint && !env.SESSION_LIFECYCLE_OBJECT_ACCESS_KEY && !env.SESSION_LIFECYCLE_OBJECT_SECRET_KEY && localFlag === 'off') return undefined
  if (!config.objectBucket || !config.objectRegion) throw new Error('archive bucket and region required for cold reads')
  const localTest = localFlag === 'on'
  if (localTest && !['test','development'].includes(env.NODE_ENV ?? '')) throw new Error('archive local fixtures require a test runtime')
  const accessKeyId = env.SESSION_LIFECYCLE_OBJECT_ACCESS_KEY
  const secretAccessKey = env.SESSION_LIFECYCLE_OBJECT_SECRET_KEY
  if (!!accessKeyId !== !!secretAccessKey) throw new Error('incomplete archive credentials')
  return new PrivateObjectArchiveStorage({
    bucket:config.objectBucket,region:config.objectRegion,endpoint,localTest,
    maxObjectBytes:config.maxCompressedBytes,
    ...(accessKeyId && secretAccessKey ? {credentials:{accessKeyId,secretAccessKey}} : {}),
  })
}

export function installConfiguredHistoryReader(db: Pick<pg.Pool,'query'>, config: SessionLifecycleConfig, env: Record<string,string|undefined> = process.env): boolean {
  const storage = createConfiguredArchiveStorage(config, env)
  if (!storage) { configuredStores.delete(db); return false }
  const limits={maxRawBytes:config.maxChunkBytes,maxCompressedBytes:config.maxCompressedBytes,maxRecords:1000}
  installPostgresHistoryBodyReader(db,storage,limits)
  installDocumentBodyReader(db,storage,limits)
  configuredStores.set(db,storage)
  return true
}
