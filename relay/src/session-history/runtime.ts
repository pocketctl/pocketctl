import type pg from 'pg'
import { PrivateObjectArchiveStorage } from '../session-archive/object-storage.js'
import type { SessionLifecycleConfig } from '../session-lifecycle/types.js'
import { installPostgresHistoryBodyReader } from './postgres-reader.js'
import { installDocumentBodyReader } from '../session-documents/body-reader.js'
const configuredStores=new WeakMap<object,PrivateObjectArchiveStorage>()
export function configuredArchiveStorage(db:object):PrivateObjectArchiveStorage|undefined{return configuredStores.get(db)}

/** Reading published bodies is independent of whether new maintenance is on. */
export function installConfiguredHistoryReader(db: Pick<pg.Pool,'query'>, config: SessionLifecycleConfig, env: Record<string,string|undefined> = process.env): boolean {
  const endpoint = env.SESSION_LIFECYCLE_OBJECT_ENDPOINT
  const localFlag = env.SESSION_LIFECYCLE_OBJECT_LOCAL_TEST ?? 'off'
  if (!['off','on'].includes(localFlag)) throw new Error('invalid archive local test flag')
  if (!config.objectBucket && !config.objectRegion && !endpoint && !env.SESSION_LIFECYCLE_OBJECT_ACCESS_KEY && !env.SESSION_LIFECYCLE_OBJECT_SECRET_KEY && localFlag === 'off') return false
  if (!config.objectBucket || !config.objectRegion) throw new Error('archive bucket and region required for cold reads')
  const localTest = localFlag === 'on'
  if (localTest && !['test','development'].includes(env.NODE_ENV ?? '')) throw new Error('archive local fixtures require a test runtime')
  const accessKeyId = env.SESSION_LIFECYCLE_OBJECT_ACCESS_KEY
  const secretAccessKey = env.SESSION_LIFECYCLE_OBJECT_SECRET_KEY
  if (!!accessKeyId !== !!secretAccessKey) throw new Error('incomplete archive credentials')
  const storage=new PrivateObjectArchiveStorage({
    bucket:config.objectBucket,region:config.objectRegion,endpoint,localTest,
    maxObjectBytes:config.maxCompressedBytes,
    ...(accessKeyId && secretAccessKey ? {credentials:{accessKeyId,secretAccessKey}} : {}),
  })
  const limits={maxRawBytes:config.maxChunkBytes,maxCompressedBytes:config.maxCompressedBytes,maxRecords:1000}
  installPostgresHistoryBodyReader(db,storage,limits)
  installDocumentBodyReader(db,storage,limits)
  configuredStores.set(db,storage)
  return true
}
